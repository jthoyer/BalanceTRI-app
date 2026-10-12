-- ---------------------------------------------------------------------------
-- Gated member accounts, step B3: the database side of "sign up with email,
-- password and display name, then wait for the club admin to approve".
--
-- Applied to the live project on 12 October 2026 in eight parts, one file
-- each, named after the version Supabase recorded. The connector timed out
-- on the whole file, so it went in pieces. Part 8 was run in the SQL editor
-- and its history row added by hand. This file is part 1 of 8.
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
