-- Gated member accounts, step B3, part 5 of 8: member functions.
-- The design notes are at the top of part 1 (20261012042054).

-- ---------------------------------------------------------------------------
-- Member functions. Signed-in users only; each acts on the caller (auth.uid())
-- and takes no user id, so one member can never read or change another's state.
-- ---------------------------------------------------------------------------

-- Where do I stand? Anyone on the allow-list counts as approved, with or
-- without a request row, so existing members need no backfill. A request that
-- says approved while the address is no longer listed was revoked outside the
-- console, and is reported as revoked.
create function public.my_access_status()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  req private.access_requests;
  rst private.password_resets;
  st text;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into req from private.access_requests where user_id = uid;
  select * into rst from private.password_resets where user_id = uid and cleared_at is null;

  if private.is_allow_listed() then
    st := 'approved';
  elsif req.user_id is null then
    st := 'none';
  elsif req.status = 'approved' then
    st := 'revoked';
  else
    st := req.status;
  end if;

  return jsonb_build_object(
    'state', st,
    'display_name', coalesce(req.display_name, (select p.display_name from public.profiles p where p.id = uid)),
    'password_change_due', rst.user_id is not null,
    'reset_expires_at', rst.expires_at,
    'reset_expired', coalesce(rst.expires_at < now(), false)
  );
end;
$$;

-- Ask to join. Allowed once, for a signed-in account that is not listed and
-- has no request. Errors are worded for the member, and the app shows them as
-- they are.
create function public.request_access(p_display_name text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  existing text;
  v_name text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_constraint text;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  -- A double tap sends two calls; the second waits here, then finds the first's row.
  perform private.lock_account(uid);
  if private.is_allow_listed() then
    raise exception 'You already have access.';
  end if;
  select status into existing from private.access_requests where user_id = uid;
  if existing = 'pending' then
    raise exception 'Your request is already waiting for the club admin.';
  elsif existing is not null then
    raise exception 'This account can''t send another request. Contact the club.';
  end if;

  v_name := private.clean_display_name(p_display_name);
  if char_length(v_note) > 280 then
    raise exception 'Keep the note to 280 characters or fewer.';
  end if;
  if private.display_name_taken(v_name, uid) then
    raise exception 'Someone at the club already uses that name. Add a surname or initial.';
  end if;

  -- Transaction-local, and the API can't set it: PostgREST exposes no way to
  -- call set_config, so a member can't use it to dodge the cap or the history.
  perform set_config('app.naming', 'request_access', true);
  update public.profiles set display_name = v_name where id = uid;
  perform set_config('app.naming', '', true);
  if not found then
    insert into public.profiles (id, display_name) values (uid, v_name);
  end if;
  insert into private.access_requests (user_id, display_name, note, status)
  values (uid, v_name, v_note, 'pending');

  return jsonb_build_object('state', 'pending', 'display_name', v_name);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'access_requests_pkey' then
    raise exception 'Your request is already waiting for the club admin.';
  end if;
  -- Two people asked for the same name at the same moment.
  raise exception 'Someone at the club already uses that name. Add a surname or initial.';
end;
$$;

-- The app calls this after updateUser() succeeds on the forced set-password
-- step. In phase 1 the app, not the server, enforces the step (spec R6), so
-- this trusts the caller to have changed it.
create function public.password_changed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  update private.password_resets set cleared_at = now()
   where user_id = auth.uid() and cleared_at is null;
end;
$$;

-- Signed-in users only. Supabase hands every new public function to anon,
-- so revoke that explicitly.
revoke execute on function public.my_access_status() from public, anon;
revoke execute on function public.request_access(text, text) from public, anon;
revoke execute on function public.password_changed() from public, anon;
grant execute on function public.my_access_status() to authenticated;
grant execute on function public.request_access(text, text) to authenticated;
grant execute on function public.password_changed() to authenticated;
