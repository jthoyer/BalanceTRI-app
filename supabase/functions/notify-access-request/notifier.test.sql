-- Tests for the database side of the notifier
-- (migration 20261012050000_add_access_request_notifier.sql).
--
-- Run against a THROWAWAY Postgres, never the live project. From the repo root:
--
--   sed '/^create extension/d' supabase/migrations/20261012050000_add_access_request_notifier.sql > /tmp/notifier_migration.sql
--   psql -v ON_ERROR_STOP=1 -v migration=/tmp/notifier_migration.sql -d <scratch db> \
--        -f supabase/functions/notify-access-request/notifier.test.sql
--
-- (sed drops the pg_net line: a plain Postgres has no pg_net, so a stand-in
-- stands in for it.) The file builds stand-ins for what Supabase and migration
-- B3 provide (auth.users, vault, net.http_post, the API roles, and
-- private.access_requests as spec section 6.1 defines it), applies the
-- migration, runs the checks, and rolls everything back. A failed check raises
-- an exception, and psql stops with an error.

begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create schema private;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create schema net;
create table net.calls (url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb, headers jsonb) returns bigint
language plpgsql as $$
begin
  if current_setting('test.net_fails', true) = 'yes' then raise exception 'pg_net is down'; end if;
  insert into net.calls values (url, body, headers);
  return 1;
end $$;

create table private.access_requests (
  user_id      uuid primary key references auth.users on delete cascade,
  display_name text not null,
  note         text,
  status       text not null check (status in ('pending','approved','rejected','revoked')),
  requested_at timestamptz not null default now(),
  decided_by   uuid,
  decided_at   timestamptz,
  reason       text,
  notified_at  timestamptz
);

\i :migration

create schema t;
create function t.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAILED: %', msg; end if;
end $$;
-- A pending request for a fresh user. Insert fires the trigger, so callers
-- clear net.calls when they care.
create function t.add_request(p_name text, p_status text default 'pending') returns uuid
language plpgsql as $$
declare u uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (u, p_name || '@example.com');
  insert into private.access_requests (user_id, display_name, status) values (u, p_name, p_status);
  return u;
end $$;

-- 1. No Vault secret yet: the trigger stays quiet and the request is saved.
select t.add_request('Quiet');
select t.ok((select count(*) from net.calls) = 0, 'no call without a vault secret');
select t.ok((select count(*) from private.access_requests) = 1, 'request saved without a secret');

-- 2. With the secret, one insert makes one call that carries the user_id only.
insert into vault.decrypted_secrets values ('notify_access_request_secret', 'shh');
create temp table one as select t.add_request('Sam Lee') as id;
select t.ok((select count(*) from net.calls) = 1, 'one call per insert');
select t.ok((select url from net.calls) = 'https://shkfwuogrldbqldpipxd.supabase.co/functions/v1/notify-access-request', 'calls the function url');
select t.ok((select body from net.calls) = jsonb_build_object('user_id', (select id from one)), 'body is the user_id and nothing else');
select t.ok((select headers->>'x-notify-secret' from net.calls) = 'shh', 'sends the shared secret header');
select t.ok(not ((select body::text from net.calls) ilike '%Sam%'), 'the name never leaves the database in the trigger call');

-- 3. A failing pg_net never blocks the insert.
set local test.net_fails = 'yes';
select t.add_request('Despite outage');
select t.ok((select count(*) from private.access_requests where display_name = 'Despite outage') = 1, 'insert survives a pg_net failure');
set local test.net_fails = 'no';

-- 4. Claim: eligibility.
select t.ok((public.notifier_claim(gen_random_uuid()))->>'send' = 'false', 'unknown request is not claimed');
create temp table approved as select t.add_request('Already approved', 'approved') as id;
select t.ok((public.notifier_claim((select id from approved)))->>'send' = 'false', 'a decided request is not claimed');
create temp table c as select public.notifier_claim((select id from one)) as r;
select t.ok((select r->>'send' from c) = 'true', 'a pending request is claimed');
select t.ok((select r->>'display_name' from c) = 'Sam Lee', 'claim returns the name from the database');
select t.ok((select notified_at is not null from private.access_requests where user_id = (select id from one)), 'claim stamps notified_at');
select t.ok((public.notifier_claim((select id from one)))->>'send' = 'false', 'a second claim is refused');

-- 5. Release hands the claim back.
select public.notifier_release((select id from one));
select t.ok((select notified_at is null from private.access_requests where user_id = (select id from one)), 'release clears notified_at');
select t.ok((public.notifier_claim((select id from one)))->>'send' = 'true', 'a released request can be claimed again');

-- 6. T8, the daily cap: 20 sends, the 20th flagged, the rest refused.
update private.access_requests set notified_at = null;
delete from private.access_requests;
create temp table many as
  select t.add_request('Member ' || g) as id, g as n from generate_series(1, 21) g;
create temp table results as
  select m.n, public.notifier_claim(m.id) as r from many m order by m.n;
select t.ok((select count(*) from results where r->>'send' = 'true') = 20, 'exactly 20 are sent');
select t.ok((select r->>'last_of_day' from results where n = 19) = 'false', 'the 19th is not the last');
select t.ok((select r->>'last_of_day' from results where n = 20) = 'true', 'the 20th says the limit is reached');
select t.ok((select r->>'send' from results where n = 21) = 'false', 'the 21st sends nothing');
select t.ok((select count(*) from private.access_requests) = 21, 'all 21 requests are still stored');

-- 7. The cap counts today's sends only. A failed send frees its slot.
select public.notifier_release((select id from many where n = 20));
select t.ok((public.notifier_claim((select id from many where n = 21)))->>'send' = 'true', 'a released slot can be used by the next request');
update private.access_requests set notified_at = now() - interval '36 hours';
create temp table fresh as select t.add_request('Fresh') as id;
select t.ok((public.notifier_claim((select id from fresh)))->>'send' = 'true', 'sends from an earlier Sydney day do not count');

-- 8. Only the service role can call the claim and release functions, and the trigger function is closed to everyone.
select t.ok(not has_function_privilege('anon', 'public.notifier_claim(uuid)', 'execute'), 'anon cannot claim');
select t.ok(not has_function_privilege('authenticated', 'public.notifier_claim(uuid)', 'execute'), 'authenticated cannot claim');
select t.ok(has_function_privilege('service_role', 'public.notifier_claim(uuid)', 'execute'), 'service_role can claim');
select t.ok(not has_function_privilege('anon', 'public.notifier_release(uuid)', 'execute'), 'anon cannot release');
select t.ok(not has_function_privilege('authenticated', 'public.notifier_release(uuid)', 'execute'), 'authenticated cannot release');
select t.ok(has_function_privilege('service_role', 'public.notifier_release(uuid)', 'execute'), 'service_role can release');
select t.ok(not has_function_privilege('authenticated', 'private.notify_access_request()', 'execute'), 'authenticated cannot run the trigger function');
do $$
begin
  set local role authenticated;
  perform public.notifier_claim(gen_random_uuid());
  reset role;
  raise exception 'FAILED: authenticated called notifier_claim';
exception when insufficient_privilege then
  reset role;
end $$;

select 'all notifier checks passed' as result;
rollback;
