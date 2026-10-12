-- ---------------------------------------------------------------------------
-- Admin password reset (step B5, spec 5.5): the database side of the
-- admin-reset-password Edge Function.
--
-- NOT APPLIED. Apply it only after the owner's go, and after the B3 migration
-- (20261011230000_add_access_requests), which makes private.password_resets
-- and private.lock_account(). Then rename this file to the version Supabase
-- recorded (list_migrations), as CLAUDE.md says.
--
-- Supabase's own reset sends an email, and this design sends members none. The
-- owner presses Reset password in the console instead. The Edge Function calls
-- admin_password_reset_begin() below AS THE OWNER, so the usual admin check
-- (an admin, signed in with two-factor) decides; only then does the function
-- set a temporary password with the service role and show it to the owner once.
--
-- The temporary password is never stored here or anywhere else. The row in
-- private.password_resets holds only who reset whom, when, and when the
-- "must change password" flag expires (7 days; the app enforces the expiry in
-- phase 1, spec R6). public.password_changed() (B3) clears it.
-- ---------------------------------------------------------------------------

create function public.admin_password_reset_begin(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz := now() + interval '7 days';
begin
  perform private.require_admin();
  if p_user_id = auth.uid() then
    raise exception 'Use Change password for your own account.';
  end if;
  -- One admin must not be able to take over another's account. Admins change
  -- their own password with Change password, or in the dashboard.
  if exists (select 1 from private.admins where user_id = p_user_id) then
    raise exception 'Admins can''t reset another admin''s password here. Use the dashboard.';
  end if;
  perform private.lock_account(p_user_id);
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'That account no longer exists.';
  end if;

  insert into private.password_resets (user_id, reset_by, reset_at, expires_at, cleared_at)
  values (p_user_id, auth.uid(), now(), v_expires, null)
  on conflict (user_id) do update
    set reset_by = excluded.reset_by, reset_at = excluded.reset_at,
        expires_at = excluded.expires_at, cleared_at = null;

  -- Sign the member out on every device (spec P9): no session, no refresh
  -- token, so no device can renew its access token. One already issued lasts
  -- until it expires (jwt_expiry, an hour at most): RLS checks the token's
  -- signature and expiry, not whether its session still exists. The app sends a
  -- flagged member straight to the set-password step.
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;

  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'password_reset', jsonb_build_object('user_id', p_user_id, 'expires_at', v_expires));

  return jsonb_build_object('user_id', p_user_id, 'expires_at', v_expires);
end;
$$;

-- Called after the temporary password is set. The old password worked until
-- that moment, so sign the member out again: a session someone opened in
-- between (with the old password, which a reset is often recovering from)
-- must not outlive the reset.
create function public.admin_password_reset_finish(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if exists (select 1 from private.admins where user_id = p_user_id) then
    raise exception 'Admins can''t reset another admin''s password here. Use the dashboard.';
  end if;
  perform private.lock_account(p_user_id);
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;
end;
$$;

-- Signed-in users only; the functions refuse non-admins inside.
revoke execute on function public.admin_password_reset_begin(uuid) from public, anon;
revoke execute on function public.admin_password_reset_finish(uuid) from public, anon;
grant execute on function public.admin_password_reset_begin(uuid) to authenticated;
grant execute on function public.admin_password_reset_finish(uuid) to authenticated;
