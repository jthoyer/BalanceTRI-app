-- Tests for migration 20261016043135_admin_undo_refuses_owner_changes.sql:
-- admin_undo refuses to undo a Link or Unlink, because undo puts the old name
-- back but cannot restore created_by. Run with supabase/tests/run.sh.
--
-- Without the migration the first refusal check fails: the undo goes through,
-- the name is restored and the entry stays owned by the account.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

insert into t.u values ('owner', 'ff177de1-36e1-44ce-8c7b-3361fcf78054');
select t.mk('tony');
select t.list('tony');
update public.profiles set display_name = 'Tony Smith' where id = t.id('tony');

insert into public.races (id, name, date) values
  ('44444444-4444-4444-4444-444444444444', 'Harbour Sprint', '2027-02-01');
-- Tony's commitment was typed before he had an account, so nobody owns it.
insert into public.entries (id, race_id, name) values
  ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'T. Smith');
select t.ok((select created_by is null from public.entries where id = '55555555-5555-5555-5555-555555555555'), 'the entry starts unowned');

-- Link it. The entry is renamed and owned.
select t.as_user('owner', 'aal2');
select public.admin_link_entries(t.id('tony'), array['55555555-5555-5555-5555-555555555555'::uuid]);
reset role;
select t.ok((select name = 'Tony Smith' and created_by = t.id('tony') from public.entries where id = '55555555-5555-5555-5555-555555555555'), 'linking renamed the entry and set the owner');
select set_config('t.link_change', (select max(id)::text from private.change_history where table_name = 'entries' and op = 'UPDATE'), false);

-- Undoing the link is refused, with a message that says what to do instead.
select t.as_user('owner', 'aal2');
select t.fails($$select public.admin_undo(current_setting('t.link_change')::bigint)$$, '%cannot be undone here%Link entries%');
reset role;
select t.ok((select name = 'Tony Smith' and created_by = t.id('tony') from public.entries where id = '55555555-5555-5555-5555-555555555555'), 'the refused undo changed nothing: name and owner are as linked');
select t.ok((select count(*) from private.admin_actions where action = 'undo') = 0, 'and wrote no undo log row');

-- The same goes for undoing an Unlink: it would re-link without Link's rules.
select t.as_user('owner', 'aal2');
select public.admin_unlink_entries(t.id('tony'), array['55555555-5555-5555-5555-555555555555'::uuid]);
reset role;
select set_config('t.unlink_change', (select max(id)::text from private.change_history where table_name = 'entries' and op = 'UPDATE'), false);
select t.as_user('owner', 'aal2');
select t.fails($$select public.admin_undo(current_setting('t.unlink_change')::bigint)$$, '%cannot be undone here%');
reset role;
select t.ok((select created_by is null from public.entries where id = '55555555-5555-5555-5555-555555555555'), 'undoing the unlink did not re-link the entry');

-- Not over-broad: a plain rename of the entry still undoes.
update public.entries set name = 'Tony S' where id = '55555555-5555-5555-5555-555555555555';
select set_config('t.rename_change', (select max(id)::text from private.change_history where table_name = 'entries' and op = 'UPDATE'), false);
select t.as_user('owner', 'aal2');
select public.admin_undo(current_setting('t.rename_change')::bigint);
reset role;
select t.ok((select name = 'Tony Smith' from public.entries where id = '55555555-5555-5555-5555-555555555555'), 'a rename still undoes');
select t.ok((select count(*) from private.admin_actions where action = 'undo') = 1, 'and logs one undo');

-- Still admin-only.
select t.as_user('tony');
select t.fails($$select public.admin_undo(current_setting('t.rename_change')::bigint)$$, '42501');
reset role;

\o
\echo admin_undo_owner: all checks passed
rollback;
