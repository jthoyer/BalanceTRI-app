-- Stand-ins for the parts of a Supabase project that plain Postgres lacks, so
-- the repo's migrations can be replayed on a scratch database and tested.
-- Used by run.sh. Never run this against a real Supabase project.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  -- As on Supabase, the service role is not subject to RLS.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

grant usage on schema public to anon, authenticated, service_role;
-- Supabase gives the API roles every new table and function in public by
-- default. The migrations then revoke what they must, so replay with the same
-- starting point.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  last_sign_in_at timestamptz,
  raw_user_meta_data jsonb
);
-- Sign-in sessions, as GoTrue keeps them (refresh_tokens.user_id is text there).
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade);
create table auth.refresh_tokens (id bigserial primary key, token text, user_id varchar(255), session_id uuid references auth.sessions on delete cascade, revoked boolean default false);

-- As Supabase defines them: read the JWT the API put in a session setting.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated, service_role;

create schema vault;
create table vault.secrets (name text primary key, secret text not null);
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
insert into vault.secrets values ('allowed_emails_hmac_key', 'test-only-hmac-key');

create schema net;
create table net.calls (url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb, headers jsonb) returns bigint
language plpgsql as $$
begin
  insert into net.calls values (url, body, headers);
  return 1;
end $$;

-- The owner's account. add_admin_console seeds private.admins with this id, so
-- it has to exist before that migration runs. (The migrations already hold the
-- id and the address.) The profiles trigger does not exist yet at this point,
-- so the owner's profile row is added by the tests that need it.
insert into auth.users (id, email, email_confirmed_at)
values ('ff177de1-36e1-44ce-8c7b-3361fcf78054', 'jthoyer@gmail.com', now());
