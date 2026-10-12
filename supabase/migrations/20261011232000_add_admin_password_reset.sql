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
  -- until it expires (an hour at most), and the app sends a flagged member
  -- straight to the set-password step.
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;

  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'password_reset', jsonb_build_object('user_id', p_user_id, 'expires_at', v_expires));

  return jsonb_build_object('user_id', p_user_id, 'expires_at', v_expires);
end;
$$;

-- Signed-in users only; the function refuses non-admins inside.
revoke execute on function public.admin_password_reset_begin(uuid) from public, anon;
grant execute on function public.admin_password_reset_begin(uuid) to authenticated;
