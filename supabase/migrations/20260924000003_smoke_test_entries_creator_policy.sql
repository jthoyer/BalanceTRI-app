-- PLACEHOLDER TIMESTAMP: drafted 2026-09-24, not yet applied. After
-- apply_migration (project_id shkfwuogrldbqldpipxd), rename this file to the
-- version list_migrations reports, per CLAUDE.md.
--
-- Smoke test for `entries_creator_scoped_writes`. Apply straight after it,
-- then apply `smoke_test_entries_creator_cleanup` — same pair pattern as
-- smoke_test_races_delete_policy / smoke_test_races_delete_cleanup.
--
-- Unlike that pair, this one asserts rather than leaving rows for someone to
-- eyeball: every check raises on failure, which aborts the migration's
-- transaction, so a failed run leaves nothing behind and apply_migration
-- returns the SMOKE FAIL message. A clean apply is the pass.
--
-- Actors are simulated the way PostgREST does it: SET LOCAL ROLE authenticated
-- plus request.jwt.claims, which is what auth.uid() and auth.jwt() read.
--   A, B — allow-listed members (their HMAC hashes are added for the test)
--   C    — signed in but NOT allow-listed (guards against the allow-list being
--          dropped, which the pre-allow-list ticket SQL would have done)
-- The fixture race is inserted already soft-deleted, so it never appears on
-- the live calendar between this migration and the cleanup.
-- ---------------------------------------------------------------------------

-- Fixtures, as the migration role.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000a001', 'smoketest-a@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000b001', 'smoketest-b@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000c001', 'smoketest-c@example.invalid', 'authenticated', 'authenticated');

insert into private.allowed_emails (email_hash)
select encode(extensions.hmac(e, s.decrypted_secret, 'sha256'), 'hex')
from vault.decrypted_secrets s
cross join unnest(array['smoketest-a@example.invalid', 'smoketest-b@example.invalid']) as e
where s.name = 'allowed_emails_hmac_key'
on conflict do nothing;

insert into public.races (id, name, date, location, deleted_at)
values ('00000000-0000-0000-0000-000000000002', 'Smoketest creator policy', '2027-01-01', 'Nowhere', now());

-- A pre-migration-style row: created_by is null because auth.uid() is null here.
insert into public.entries (id, race_id, name, events, level)
values ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-000000000002', 'Smoketest legacy', '{Run}', 'considering');

-- ---------------------------------------------------------------------------
-- As A: create a commitment.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a001","email":"smoketest-a@example.invalid","role":"authenticated"}', true);

do $$
declare
  owner uuid;
begin
  if current_user <> 'authenticated' then
    raise exception 'SMOKE SETUP: expected to run as authenticated, running as % — RLS is not being exercised', current_user;
  end if;
  if not private.is_allow_listed() then
    raise exception 'SMOKE SETUP: fixture A is not allow-listed (is vault secret allowed_emails_hmac_key present?)';
  end if;

  insert into public.entries (id, race_id, name, events, level)
  values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-000000000002', 'Smoketest A', '{Run}', 'considering')
  returning created_by into owner;
  if owner is distinct from '00000000-0000-0000-0000-00000000a001'::uuid then
    raise exception 'SMOKE FAIL: A''s insert was stamped created_by=%, expected A', owner;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- As B: every write against A's row must be rejected; B's own and legacy
-- rows must still work; created_by must not be forgeable.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b001","email":"smoketest-b@example.invalid","role":"authenticated"}', true);

do $$
declare
  n int;
  owner uuid;
begin
  update public.entries set level = 'committed' where id = '00000000-0000-0000-0000-00000000e001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SMOKE FAIL: B updated A''s entry (% rows)', n; end if;

  delete from public.entries where id = '00000000-0000-0000-0000-00000000e001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SMOKE FAIL: B deleted A''s entry (% rows)', n; end if;

  -- saveEntry()'s path: upsert on (race_id, name) over A's row. Postgres raises
  -- rather than skipping when the existing row fails the UPDATE policy.
  begin
    insert into public.entries (race_id, name, events, level)
    values ('00000000-0000-0000-0000-000000000002', 'Smoketest A', '{Swim}', 'committed')
    on conflict (race_id, name) do update set events = excluded.events, level = excluded.level;
    raise exception 'SMOKE FAIL: B upserted over A''s entry';
  exception when insufficient_privilege then
    null; -- expected: new row violates row-level security policy
  end;

  update public.entries set level = 'committed' where id = '00000000-0000-0000-0000-00000000e002';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'SMOKE FAIL: B could not update the created_by-null legacy entry (% rows)', n; end if;
  select created_by into owner from public.entries where id = '00000000-0000-0000-0000-00000000e002';
  if owner is not null then raise exception 'SMOKE FAIL: editing a legacy entry claimed it for %', owner; end if;

  -- A forged created_by on insert is overwritten with the caller.
  insert into public.entries (id, race_id, name, events, level, created_by)
  values ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-000000000002', 'Smoketest B', '{Bike}', 'considering',
          '00000000-0000-0000-0000-00000000a001')
  returning created_by into owner;
  if owner is distinct from '00000000-0000-0000-0000-00000000b001'::uuid then
    raise exception 'SMOKE FAIL: forged created_by on insert survived (got %)', owner;
  end if;

  -- created_by is write-once: B cannot hand their row to A, or null it.
  update public.entries set created_by = null where id = '00000000-0000-0000-0000-00000000e003';
  select created_by into owner from public.entries where id = '00000000-0000-0000-0000-00000000e003';
  if owner is distinct from '00000000-0000-0000-0000-00000000b001'::uuid then
    raise exception 'SMOKE FAIL: created_by was rewritten on update (got %)', owner;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- As A again: the creator can still edit and remove their own row.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a001","email":"smoketest-a@example.invalid","role":"authenticated"}', true);

do $$
declare
  n int;
begin
  insert into public.entries (race_id, name, events, level)
  values ('00000000-0000-0000-0000-000000000002', 'Smoketest A', '{Swim}', 'committed')
  on conflict (race_id, name) do update set events = excluded.events, level = excluded.level;

  delete from public.entries where id = '00000000-0000-0000-0000-00000000e001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'SMOKE FAIL: A could not remove their own entry (% rows)', n; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- As C (signed in, not allow-listed): no write at all, including on the
-- legacy row the creator check alone would allow.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000c001","email":"smoketest-c@example.invalid","role":"authenticated"}', true);

do $$
declare
  n int;
begin
  update public.entries set level = 'committed' where id = '00000000-0000-0000-0000-00000000e002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SMOKE FAIL: non-allow-listed C updated the legacy entry — allow-list lost'; end if;

  delete from public.entries where id = '00000000-0000-0000-0000-00000000e002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SMOKE FAIL: non-allow-listed C deleted the legacy entry — allow-list lost'; end if;

  begin
    insert into public.entries (race_id, name, events, level)
    values ('00000000-0000-0000-0000-000000000002', 'Smoketest C', '{Run}', 'considering');
    raise exception 'SMOKE FAIL: non-allow-listed C inserted an entry — allow-list lost';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;
