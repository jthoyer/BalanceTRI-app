-- Tests for migration 20261013011548_first_names_for_visitors.sql: visitors and
-- unapproved accounts see first names only; approved members see full names.
-- Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

insert into public.races (id, name, date) values
  ('22222222-2222-2222-2222-222222222222', 'Live Race', '2027-01-01'),
  ('33333333-3333-3333-3333-333333333333', 'Removed Race', '2027-01-02');
insert into public.entries (race_id, name) values
  ('22222222-2222-2222-2222-222222222222', 'Sam Lee'),
  ('22222222-2222-2222-2222-222222222222', '  Jo  van der Berg '),
  ('22222222-2222-2222-2222-222222222222', 'Kim'),
  ('33333333-3333-3333-3333-333333333333', 'Hidden Person');
update public.races set deleted_at = now() where id = '33333333-3333-3333-3333-333333333333';

select t.mk(n) from unnest(array['mem','pen']) n;
select t.list('mem');
insert into private.access_requests (user_id, display_name, status) values (t.id('pen'), 'Pen Ding', 'pending');

-- A visitor can't read the table at all, so no full name reaches them.
select t.as_anon();
select t.ok((select count(*) from public.entries) = 0, 'a visitor reads no rows from entries');
select t.ok((select count(*) from public.public_entries() where race_id = '22222222-2222-2222-2222-222222222222') = 3, 'a visitor sees the three entries on the live race');
select t.ok((select array_agg(name order by name) from public.public_entries() where race_id = '22222222-2222-2222-2222-222222222222') = array['Jo','Kim','Sam'], 'first names only, trimmed');
select t.ok(not exists (select 1 from public.public_entries() where name like '% %'), 'no surname or second word reaches a visitor');
select t.ok(not exists (select 1 from public.public_entries() where race_id = '33333333-3333-3333-3333-333333333333'), 'removed races stay hidden');
reset role;

-- A pending account is no better off than a visitor.
select t.as_user('pen');
select t.ok((select count(*) from public.entries) = 0, 'a pending account reads no rows from entries');
select t.ok((select count(*) from public.public_entries() where race_id = '22222222-2222-2222-2222-222222222222') = 3, 'a pending account gets first names');
reset role;

-- An approved member reads full names, and writes still work.
select t.as_user('mem');
select t.ok((select count(*) from public.entries where name = 'Sam Lee') = 1, 'a member reads full names');
select t.ok(t.rows($$insert into public.entries (race_id, name) values ('22222222-2222-2222-2222-222222222222', 'Mem Ber')$$) = 1, 'a member can still add an entry');
select t.ok(t.rows($$update public.entries set level = 'locked' where name = 'Mem Ber'$$) = 1, 'and update it');
select t.ok(t.rows($$delete from public.entries where name = 'Mem Ber'$$) = 1, 'and remove it');
reset role;

select t.ok(not exists (select 1 from pg_policies where tablename = 'entries' and cmd = 'SELECT' and 'public' = any(roles)), 'no select policy is open to the public role');

\o
\echo first-name checks passed
rollback;
