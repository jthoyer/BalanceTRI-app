-- Tests for migrations 20261013011548_first_names_for_visitors.sql and
-- 20261018000000_visitors_see_counts_not_names.sql: visitors and unapproved
-- accounts see counts only, with no names; approved members see full names.
-- Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

insert into public.races (id, name, date) values
  ('22222222-2222-2222-2222-222222222222', 'Live Race', '2027-01-01'),
  ('33333333-3333-3333-3333-333333333333', 'Removed Race', '2027-01-02');
insert into public.entries (race_id, name, level) values
  ('22222222-2222-2222-2222-222222222222', 'Sam Lee', 'locked'),
  ('22222222-2222-2222-2222-222222222222', 'Jo van der Berg', 'considering'),
  ('22222222-2222-2222-2222-222222222222', 'Kim', 'locked'),
  ('22222222-2222-2222-2222-222222222222', 'Old Import', 'not'),
  ('33333333-3333-3333-3333-333333333333', 'Hidden Person', 'locked');
update public.races set deleted_at = now() where id = '33333333-3333-3333-3333-333333333333';

select t.mk(n) from unnest(array['mem','pen']) n;
select t.list('mem');
insert into private.access_requests (user_id, display_name, status) values (t.id('pen'), 'Pen Ding', 'pending');

-- The old first-names function is gone, and the counts function has no name column.
select t.ok(to_regprocedure('public.public_entries()') is null, 'public_entries() no longer exists');
select t.ok(
  (select array_agg(a order by a) from unnest((select proargnames from pg_proc where oid = 'public.public_race_counts()'::regprocedure)) a)
    = array['committed','locked','race_id'],
  'public_race_counts() returns race_id, committed and locked only');

-- A visitor can't read the table at all, and gets counts with no names.
select t.as_anon();
select t.ok((select count(*) from public.entries) = 0, 'a visitor reads no rows from entries');
select t.ok((select committed from public.public_race_counts() where race_id = '22222222-2222-2222-2222-222222222222') = 3, 'a visitor sees three commitments, leaving out the ''not'' row');
select t.ok((select locked from public.public_race_counts() where race_id = '22222222-2222-2222-2222-222222222222') = 2, 'and two locked in');
select t.ok(not exists (select 1 from public.public_race_counts() where race_id = '33333333-3333-3333-3333-333333333333'), 'removed races stay hidden');
reset role;

-- A pending account is no better off than a visitor.
select t.as_user('pen');
select t.ok((select count(*) from public.entries) = 0, 'a pending account reads no rows from entries');
select t.ok((select committed from public.public_race_counts() where race_id = '22222222-2222-2222-2222-222222222222') = 3, 'a pending account gets the counts');
reset role;

-- An approved member reads full names, and writes still work.
-- Commitments carry the member's display name (lock_entry_names_add_admin_rename).
insert into public.profiles (id, display_name) values (t.id('mem'), 'Mem Ber')
  on conflict (id) do update set display_name = excluded.display_name;
select t.as_user('mem');
select t.ok((select count(*) from public.entries where name = 'Sam Lee') = 1, 'a member reads full names');
select t.ok(t.rows($$insert into public.entries (race_id, name) values ('22222222-2222-2222-2222-222222222222', 'Mem Ber')$$) = 1, 'a member can still add an entry');
select t.ok(t.rows($$update public.entries set level = 'locked' where name = 'Mem Ber'$$) = 1, 'and update it');
select t.ok(t.rows($$delete from public.entries where name = 'Mem Ber'$$) = 1, 'and remove it');
reset role;

select t.ok(not exists (select 1 from pg_policies where tablename = 'entries' and cmd = 'SELECT' and 'public' = any(roles)), 'no select policy is open to the public role');

\o
\echo visitor-count checks passed
rollback;
