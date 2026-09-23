create schema if not exists private;

-- private.allowed_emails stores only a keyed hash of each allow-listed
-- address (HMAC-SHA256, keyed with a secret held in Supabase Vault), never
-- the address itself. A leak of this table on its own reveals nothing — the
-- key lives in vault.secrets, not here — and a keyed hash, unlike a plain
-- SHA-256 of an email, can't be brute-forced by guessing addresses against a
-- stolen table alone.
create table private.allowed_emails (
  email_hash text primary key,
  added_at timestamptz not null default now()
);

alter table private.allowed_emails enable row level security;
-- No policies are created: RLS with zero policies denies all access to
-- every role. Combined with the revoke below, this is defence in depth —
-- the private schema is never exposed over PostgREST regardless, but a
-- config change elsewhere should not be the only thing standing between
-- this table and the anon key.
revoke all on private.allowed_emails from public, anon, authenticated;

-- private.is_allow_listed() takes no arguments on purpose: it can only ever
-- answer "is the caller's own, JWT-verified email on the list?", never "is
-- <arbitrary email> on the list?". That is what keeps this an allow-list
-- rather than an address-probing oracle, and what keeps it from becoming
-- the kind of shared-secret bypass a hidden password or magic word would be
-- — the identity it trusts is the one Supabase Auth already verified via
-- magic-link/OTP sign-in, never a value the caller supplies.
create function private.is_allow_listed()
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_email text;
  hmac_key text;
begin
  caller_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  if caller_email = '' then
    return false;
  end if;

  select decrypted_secret into hmac_key
    from vault.decrypted_secrets
    where name = 'allowed_emails_hmac_key';

  if hmac_key is null then
    return false;
  end if;

  return exists (
    select 1
    from private.allowed_emails
    where email_hash = encode(extensions.hmac(caller_email, hmac_key, 'sha256'), 'hex')
  );
end;
$$;

-- EXECUTE is granted to PUBLIC by default at creation (the same lesson
-- revoke_handle_new_user_execute recorded for handle_new_user). Revoke it
-- from everyone, then grant it back only to authenticated — anon never
-- needs it, since every policy that calls this function is itself scoped
-- `to authenticated`.
revoke execute on function private.is_allow_listed() from public, anon, authenticated;
grant execute on function private.is_allow_listed() to authenticated;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Narrow the existing authenticated-write policies on entries and races to
-- allow-listed members only. Read access is unchanged for both tables.
-- ---------------------------------------------------------------------------
drop policy "Members can add entries" on public.entries;
drop policy "Members can update entries" on public.entries;
drop policy "Members can remove entries" on public.entries;

create policy "Members can add entries" on public.entries
  for insert to authenticated with check (private.is_allow_listed());

create policy "Members can update entries" on public.entries
  for update to authenticated
  using (private.is_allow_listed()) with check (private.is_allow_listed());

create policy "Members can remove entries" on public.entries
  for delete to authenticated using (private.is_allow_listed());

drop policy "Members can add races" on public.races;
drop policy "Members can update races" on public.races;

create policy "Members can add races" on public.races
  for insert to authenticated with check (private.is_allow_listed());

create policy "Members can update races" on public.races
  for update to authenticated
  using (deleted_at is null and private.is_allow_listed())
  with check (private.is_allow_listed());
