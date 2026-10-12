-- ---------------------------------------------------------------------------
-- Gated member accounts, step B3: the database side of "sign up with email,
-- password and display name, then wait for the club admin to approve".
--
-- NOT APPLIED. Apply it only after the owner's go (gate R5). After applying,
-- rename this file to the version Supabase recorded (list_migrations), as
-- CLAUDE.md says. It must sort before 20261011231500_add_access_request_notifier,
-- which puts a trigger on the table made here.
--
-- It is safe with "Confirm email" still on: it only adds. Nothing here turns a
-- setting off, and nothing changes who can write today.
--
-- Design rule: the allow-list (private.allowed_emails) stays the ONLY gate the
-- RLS policies check. private.access_requests is the workflow and the record.
-- It never grants anything by itself; admin_decide_request() moves the two
-- together in one transaction.
--
-- What is in here:
--   * private.access_requests, private.password_resets (no policies, no grants)
--   * public.my_access_status(), request_access(), password_changed()   members
--   * public.admin_requests(), admin_decide_request(), admin_pending_count()
--   * G2: admin_allow_list_add() refuses an address with no account
--   * G3: triggers on auth.users that drop a hash when its account is deleted
--         or its email changes
--   * F7: display-name rules and a uniqueness check on rename, plus a change
--         history trigger on profiles
--   * F6: members can no longer update profiles.justgo_*
--
-- NOT in here, on purpose:
--   * G1 (delete allow-list hashes that match no account). It is a one-off
--     cleanup for cutover (B9), not part of the schema. It must run
--     immediately before "Confirm email" goes off. The statement, tested in
--     supabase/tests/b3_access_requests.test.sql, is:
--
--       delete from private.allowed_emails
--        where email_hash not in (
--          select private.email_hash(email) from auth.users
--           where email is not null and email_confirmed_at is not null
--        );
--
--     Only CONFIRMED accounts count. An unconfirmed account proves nothing:
--     anyone can create one on any address while "Confirm email" is on, then
--     confirm it by signing up again once it is off. So a hash whose only
--     account is unconfirmed is an orphan too.
--
--     Straight after G1, delete the accounts that are still unconfirmed (none
--     of them can be listed by then). They are bots or abandoned sign-ups, and
--     one sitting on a member's address would stop that member joining:
--
--       delete from auth.users where email_confirmed_at is null;
--
--     It cannot be undone: the deleted hashes were never readable.
--   * Anything that sends a message. That is B4.
--   * Anything that sets a temporary password. That is B5.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tables. Same pattern as private.allowed_emails: RLS on, no policies, every
-- grant revoked, and the private schema is never exposed over the API.
-- ---------------------------------------------------------------------------
create table private.access_requests (
  user_id      uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  note         text check (char_length(note) <= 280),
  status       text not null check (status in ('pending', 'approved', 'rejected', 'revoked')),
  requested_at timestamptz not null default now(),
  decided_by   uuid references auth.users on delete set null,
  decided_at   timestamptz,
  reason       text check (char_length(reason) <= 200),
  notified_at  timestamptz
);
alter table private.access_requests enable row level security;
revoke all on private.access_requests from public, anon, authenticated;

-- The primary key on user_id is the one-request-per-person guard. This index is
-- the name guard: entries are unique on (race_id, name), so two "Sam"s would
-- collide on a race. It covers pending and approved only, so a rejected
-- person's name is free again.
create unique index access_requests_active_name_idx
  on private.access_requests (lower(display_name))
  where status in ('pending', 'approved');
create index access_requests_status_idx on private.access_requests (status, requested_at);

create table private.password_resets (
  user_id    uuid primary key references auth.users on delete cascade,
  reset_by   uuid references auth.users on delete set null,
  reset_at   timestamptz not null default now(),
  expires_at timestamptz not null,
  cleared_at timestamptz
);
alter table private.password_resets enable row level security;
revoke all on private.password_resets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Display names (S4, S5, F7).
-- ---------------------------------------------------------------------------

-- Trim, collapse repeated spaces, and check the rules: 2 to 40 characters;
-- letters in any language, spaces, apostrophes, hyphens and full stops; at
-- least one letter. Look-alike letters from other scripts (a Cyrillic "а" for
-- a Latin "a") are not caught; entry names are an honour system anyway.
-- [[:alpha:]] follows the database's locale, so this relies on
-- a UTF-8 database (Supabase's is). Raises a message fit to show the member.
create function private.clean_display_name(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  -- NFC first, so "Zoë" typed as one character or as "e" plus an accent mark
  -- is the same name to the uniqueness check.
  v text := normalize(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), NFC);
begin
  -- U+034F is a combining mark that draws nothing, so "Sam" + U+034F would
  -- look exactly like "Sam" yet pass the uniqueness check. Drop it.
  v := trim(regexp_replace(v, '\u034f', '', 'g'));
  if char_length(v) < 2 or char_length(v) > 40 then
    raise exception 'Your name needs to be 2 to 40 characters.';
  end if;
  if v !~ '^([[:alpha:]̀-ͯ]|[ ''.’-])+$' then
    raise exception 'Use letters, spaces, apostrophes, hyphens and full stops in your name.';
  end if;
  if v !~ '[[:alpha:]]' then
    raise exception 'Your name needs at least one letter.';
  end if;
  return v;
end;
$$;

-- Is this name used by someone else who is pending or approved? Approved
-- includes members who joined before requests existed, who have no request
-- row: their profile name counts if their address is on the allow-list.
create function private.display_name_taken(p_name text, p_except uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
           select 1 from private.access_requests r
            where r.user_id is distinct from p_except
              and r.status in ('pending', 'approved')
              and lower(normalize(r.display_name, NFC)) = lower(p_name)
         )
      or exists (
           select 1
             from public.profiles p
             join auth.users u on u.id = p.id
            where p.id is distinct from p_except
              and lower(normalize(p.display_name, NFC)) = lower(p_name)
              and exists (
                    select 1 from private.allowed_emails a
                     where a.email_hash = private.email_hash(u.email)
                  )
         );
$$;

-- One account's access changes one at a time. Admin decisions, request_access
-- and the G3 triggers all take this lock first, so an approval can't interleave
-- with an email change or a deletion and leave a hash behind for an address no
-- account uses (that would be the 5.2 attack again). An advisory lock, because
-- locking rows in auth.users needs privileges this project may not grant.
create function private.lock_account(p_user_id uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtext('account:' || p_user_id::text));
$$;

-- A name for a request row made on someone's behalf (an existing member who
-- loses their listing). Their profile name if it fits the column, else "Member".
create function private.fallback_name(p_user_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(
    (select left(p.display_name, 40) from public.profiles p
      where p.id = p_user_id and char_length(p.display_name) >= 2),
    'Member'
  );
$$;

-- F7: profiles.display_name was freely editable by its owner, so a rename could
-- impersonate another member. Renames now follow the sign-up rules.
create function private.check_profile_rename()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.display_name := private.clean_display_name(new.display_name);
  if new.display_name is not distinct from old.display_name then
    return new;
  end if;
  if private.display_name_taken(new.display_name, new.id) then
    raise exception 'Someone at the club already uses that name. Add a surname or initial.';
  end if;
  -- request_access() replaces the seeded name (the email's local part) with
  -- the chosen one. That is joining, not renaming: no cap, and no history row
  -- (see the history trigger's WHEN clause).
  if current_setting('app.naming', true) = 'request_access' then
    return new;
  end if;
  -- Each rename writes a history row, so cap them. Without a cap any signed-up
  -- account could fill the database by renaming itself in a loop. The
  -- dashboard and the service role (no auth.uid()) are not capped.
  if auth.uid() is not null and (
    select count(*) from private.change_history h
     where h.table_name = 'profiles' and h.row_id = new.id
       and h.changed_at > now() - interval '1 day'
  ) >= 5 then
    raise exception 'You can change your name 5 times a day. Try again tomorrow.';
  end if;
  -- Keep the request on the same name as the profile, so the unique index on
  -- active requests guards renames too, and the console shows the real name.
  begin
    update private.access_requests set display_name = new.display_name where user_id = new.id;
  exception when unique_violation then
    raise exception 'Someone at the club already uses that name. Add a surname or initial.';
  end;
  return new;
end;
$$;

create trigger profiles_rename_biu
  before update of display_name on public.profiles
  for each row
  when (new.display_name is distinct from old.display_name)
  execute function private.check_profile_rename();

-- F7: keep who renamed whom, the way entries and races are kept. Renames
-- only: sign-ups and deletions are not profile edits, and logging them would
-- crowd the console's activity feed.
create trigger profiles_history_au
  after update of display_name on public.profiles
  for each row
  when (old.display_name is distinct from new.display_name
        and current_setting('app.naming', true) is distinct from 'request_access')
  execute function private.record_change();

-- F6: the update policy covers every column, so a member could mark their own
-- profiles.justgo_status as verified. Members may change their display name
-- and nothing else. (Revoking only the justgo columns would do nothing while a
-- table-wide UPDATE grant stands, so replace the grant.)
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- G3: an address's hash must not outlive its account. With "Confirm email" off
-- an address proves nothing, so a hash left behind is a pre-approval that
-- anyone can claim by signing up with that address.
-- ---------------------------------------------------------------------------
create function private.forget_deleted_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_account(old.id);
  if old.email is not null then
    delete from private.allowed_emails where email_hash = private.email_hash(old.email);
  end if;
  return null;
end;
$$;

-- The old address loses its hash, and an approved request becomes revoked so
-- the owner has to approve the new address. The new address is not added. A
-- change of letter case alone is the same address and is ignored. A member who
-- joined before requests existed gets a revoked row, so they see "access
-- removed" rather than the join form.
create function private.forget_changed_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_listed boolean := false;
begin
  -- The lock comes first, and each statement below takes a fresh snapshot, so a
  -- hash an admin inserted while this waited is seen and removed.
  perform private.lock_account(new.id);
  if old.email is not null then
    delete from private.allowed_emails where email_hash = private.email_hash(old.email);
    was_listed := found;
  end if;
  update private.access_requests
     set status = 'revoked', decided_by = null, decided_at = now(),
         reason = 'Email address changed'
   where user_id = new.id and status = 'approved';
  if was_listed and not found then
    insert into private.access_requests (user_id, display_name, status, decided_at, reason)
    values (new.id, private.fallback_name(new.id), 'revoked', now(), 'Email address changed')
    on conflict (user_id) do nothing;
  end if;
  return null;
end;
$$;

create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function private.forget_deleted_account();

-- The foreign-key cascade to access_requests runs before the AFTER trigger
-- above. Taking the account lock in a BEFORE trigger keeps the lock order the
-- same as the admin functions (lock, then request row), so a deletion and an
-- admin decision wait for each other instead of deadlocking.
create function private.lock_deleted_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_account(old.id);
  return old;
end;
$$;

create trigger before_auth_user_deleted
  before delete on auth.users
  for each row execute function private.lock_deleted_account();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (lower(trim(old.email)) is distinct from lower(trim(new.email)))
  execute function private.forget_changed_email();

revoke execute on function private.clean_display_name(text) from public, anon, authenticated;
revoke execute on function private.display_name_taken(text, uuid) from public, anon, authenticated;
revoke execute on function private.check_profile_rename() from public, anon, authenticated;
revoke execute on function private.forget_deleted_account() from public, anon, authenticated;
revoke execute on function private.forget_changed_email() from public, anon, authenticated;
revoke execute on function private.lock_account(uuid) from public, anon, authenticated;
revoke execute on function private.lock_deleted_account() from public, anon, authenticated;
revoke execute on function private.fallback_name(uuid) from public, anon, authenticated;

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

-- ---------------------------------------------------------------------------
-- Admin functions. Each starts with private.require_admin(), which also needs
-- a two-factor (aal2) session. Every decision is logged in private.admin_actions.
-- ---------------------------------------------------------------------------

-- The Requests panel. Emails are read from auth.users here, so the app never
-- reads that table. 'listed' says whether the address is on the allow-list now;
-- for a revoked or rejected request it should be false.
create function public.admin_requests(p_status text default null)
returns table (
  user_id uuid,
  email text,
  display_name text,
  note text,
  status text,
  requested_at timestamptz,
  decided_at timestamptz,
  decided_by_label text,
  reason text,
  notified_at timestamptz,
  listed boolean,
  reset_pending boolean,
  reset_expires_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'revoked') then
    raise exception 'Unknown status.';
  end if;
  return query
    select r.user_id, u.email::text, r.display_name, r.note, r.status,
           r.requested_at, r.decided_at, private.user_label(r.decided_by), r.reason,
           r.notified_at,
           exists (select 1 from private.allowed_emails a where a.email_hash = private.email_hash(u.email)),
           pr.user_id is not null,
           pr.expires_at
      from private.access_requests r
      left join auth.users u on u.id = r.user_id
      left join private.password_resets pr on pr.user_id = r.user_id and pr.cleared_at is null
     where p_status is null or r.status = p_status
     order by (r.status = 'pending') desc, r.requested_at desc;
end;
$$;

-- Approve, reject, revoke or re-approve, moving the allow-list and the request
-- together. Writes stop at once on a revoke or reject, because the RLS policies
-- check the allow-list on every write. Signing the person out is the app's job.
--   approve    pending            -> approved
--   reject     pending            -> rejected
--   revoke     approved           -> revoked
--   reapprove  revoked, rejected  -> approved
create function public.admin_decide_request(p_user_id uuid, p_decision text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  req private.access_requests;
  v_email text;
  v_hash text;
  v_new text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  perform private.require_admin();
  if p_user_id = auth.uid() then
    raise exception 'You can''t change your own access.';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'Keep the reason to 200 characters or fewer.';
  end if;

  -- Taken before the email is read, so an email change or deletion either
  -- finishes first (and is seen below) or waits for this decision to commit.
  perform private.lock_account(p_user_id);
  select * into req from private.access_requests where user_id = p_user_id for update;
  if not found then
    raise exception 'No request from that account.';
  end if;
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then
    raise exception 'That account no longer exists.';
  end if;
  -- As in admin_allow_list_add: an unconfirmed account proves nothing.
  if p_decision in ('approve', 'reapprove')
     and not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
    raise exception 'That account hasn''t confirmed its email address, so it can''t be approved.';
  end if;

  v_new := case
    when p_decision = 'approve'   and req.status = 'pending'               then 'approved'
    when p_decision = 'reject'    and req.status = 'pending'               then 'rejected'
    when p_decision = 'revoke'    and req.status = 'approved'              then 'revoked'
    when p_decision = 'reapprove' and req.status in ('revoked', 'rejected') then 'approved'
  end;
  if v_new is null then
    if p_decision not in ('approve', 'reject', 'revoke', 'reapprove') then
      raise exception 'Unknown decision.';
    end if;
    raise exception 'That request is %, so you can''t % it.', req.status, p_decision;
  end if;

  -- The unique index covers requests only. A member who joined before requests
  -- existed may have taken this name since it was rejected or revoked.
  if v_new = 'approved' and private.display_name_taken(req.display_name, p_user_id) then
    raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
  end if;

  v_hash := private.email_hash(v_email);
  if v_new = 'approved' then
    insert into private.allowed_emails (email_hash) values (v_hash) on conflict do nothing;
  else
    delete from private.allowed_emails where email_hash = v_hash;
  end if;

  update private.access_requests
     set status = v_new, decided_by = auth.uid(), decided_at = now(), reason = v_reason
   where user_id = p_user_id;

  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'access_' || p_decision, jsonb_build_object(
    'user_id', p_user_id, 'from', req.status, 'to', v_new, 'reason', v_reason
  ));

  return jsonb_build_object('status', v_new);
exception when unique_violation then
  raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
end;
$$;

-- The badge in the console header and on the calendar's Admin link.
create function public.admin_pending_count()
returns integer
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  perform private.require_admin();
  return (select count(*)::integer from private.access_requests where status = 'pending');
end;
$$;

-- ---------------------------------------------------------------------------
-- G2: approving an address with no account created a pre-approval that anyone
-- could claim by signing up with it. Refuse it. Where the address does have a
-- request that is not approved, listing it settles that request, so the
-- Requests panel and the allow-list never disagree.
-- ---------------------------------------------------------------------------
create or replace function public.admin_allow_list_add(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
  added boolean;
  v_uid uuid;
  v_confirmed boolean;
  req private.access_requests;
begin
  perform private.require_admin();
  if coalesce(trim(p_email), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That doesn''t look like an email address.';
  end if;
  select id, email_confirmed_at is not null into v_uid, v_confirmed
    from auth.users where lower(trim(email)) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No account uses that address.';
  end if;
  -- An unconfirmed account proves nothing: anyone can make one on any address.
  if not v_confirmed then
    raise exception 'That account hasn''t confirmed its email address, so it can''t be approved.';
  end if;
  -- Lock, then check the address still belongs to that account: an email
  -- change that finished while this waited must not leave a hash behind.
  perform private.lock_account(v_uid);
  if not exists (
    select 1 from auth.users
     where id = v_uid and lower(trim(email)) = lower(trim(p_email)) and email_confirmed_at is not null
  ) then
    raise exception 'That account''s email address just changed. Try again.';
  end if;

  select * into req from private.access_requests where user_id = v_uid for update;
  if req.status is not null and req.status <> 'approved'
     and private.display_name_taken(req.display_name, v_uid) then
    raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
  end if;
  -- No request row (signed up but never asked, or listed before requests
  -- existed): listing them makes their profile name an approved name.
  if req.user_id is null and private.display_name_taken(
       (select p.display_name from public.profiles p where p.id = v_uid), v_uid) then
    raise exception 'Another member uses this account''s name. Rename the account before adding it.';
  end if;

  h := private.email_hash(p_email);
  insert into private.allowed_emails (email_hash) values (h) on conflict do nothing;
  added := found;
  update private.access_requests
     set status = 'approved', decided_by = auth.uid(), decided_at = now()
   where user_id = v_uid and status <> 'approved';
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'allow_list_add', jsonb_build_object(
    'email_hash', h, 'added', added, 'user_id', v_uid, 'request_from', req.status
  ));
  return jsonb_build_object('added', added);
exception when unique_violation then
  raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
end;
$$;

-- The mirror of the above: removing a listing revokes the account's access.
create or replace function public.admin_allow_list_remove(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
  removed boolean;
  v_uid uuid;
begin
  perform private.require_admin();
  select id into v_uid from auth.users where lower(trim(email)) = lower(trim(p_email));
  if v_uid is not null then
    perform private.lock_account(v_uid);
  end if;
  h := private.email_hash(p_email);
  delete from private.allowed_emails where email_hash = h;
  removed := found;
  if v_uid is not null then
    update private.access_requests
       set status = 'revoked', decided_by = auth.uid(), decided_at = now()
     where user_id = v_uid and status = 'approved';
    -- A member who joined before requests existed has no row: give them a
    -- revoked one, so they see "access removed" rather than the join form.
    if removed and not found then
      insert into private.access_requests (user_id, display_name, status, decided_by, decided_at, reason)
      values (v_uid, private.fallback_name(v_uid), 'revoked', auth.uid(), now(), 'Removed from the allow-list')
      on conflict (user_id) do nothing;
    end if;
  end if;
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'allow_list_remove', jsonb_build_object('email_hash', h, 'removed', removed, 'user_id', v_uid));
  return jsonb_build_object('removed', removed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: signed-in users only. The admin functions refuse non-admins inside.
-- Supabase hands every new public function to anon, so revoke that explicitly.
-- ---------------------------------------------------------------------------
revoke execute on function public.my_access_status() from public, anon;
revoke execute on function public.request_access(text, text) from public, anon;
revoke execute on function public.password_changed() from public, anon;
revoke execute on function public.admin_requests(text) from public, anon;
revoke execute on function public.admin_decide_request(uuid, text, text) from public, anon;
revoke execute on function public.admin_pending_count() from public, anon;

grant execute on function public.my_access_status() to authenticated;
grant execute on function public.request_access(text, text) to authenticated;
grant execute on function public.password_changed() to authenticated;
grant execute on function public.admin_requests(text) to authenticated;
grant execute on function public.admin_decide_request(uuid, text, text) to authenticated;
grant execute on function public.admin_pending_count() to authenticated;
