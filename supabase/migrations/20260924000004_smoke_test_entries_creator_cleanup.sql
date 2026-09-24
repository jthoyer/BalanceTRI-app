-- PLACEHOLDER TIMESTAMP: drafted 2026-09-24, not yet applied. After
-- apply_migration (project_id shkfwuogrldbqldpipxd), rename this file to the
-- version list_migrations reports, per CLAUDE.md.
--
-- Removes every fixture smoke_test_entries_creator_policy created. Idempotent:
-- safe to apply even if the smoke test aborted and left nothing behind.

delete from public.entries where race_id = '00000000-0000-0000-0000-000000000002';
delete from public.races where id = '00000000-0000-0000-0000-000000000002';

delete from private.allowed_emails
where email_hash in (
  select encode(extensions.hmac(e, s.decrypted_secret, 'sha256'), 'hex')
  from vault.decrypted_secrets s
  cross join unnest(array['smoketest-a@example.invalid', 'smoketest-b@example.invalid']) as e
  where s.name = 'allowed_emails_hmac_key'
);

-- Cascades to the profiles rows handle_new_user() seeded for them.
delete from auth.users where id in (
  '00000000-0000-0000-0000-00000000a001',
  '00000000-0000-0000-0000-00000000b001',
  '00000000-0000-0000-0000-00000000c001'
);
