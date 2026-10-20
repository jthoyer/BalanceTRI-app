-- Tests for migration 20261020030740_add_race_event_function.sql: add_race_event
-- appends a distance once, keeps what is already there, and only approved
-- members can use it. Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

select t.mk('alice');
select t.mk('bob');
select t.list('alice');
insert into public.races (id, name, date, events)
  values ('22222222-2222-2222-2222-222222222222', 'Event Race', '2027-01-01', array['Olympic']);

-- An approved member adds a new distance; the old one stays.
select t.as_user('alice');
select public.add_race_event('22222222-2222-2222-2222-222222222222', 'Sprint');
reset role;
select t.ok((select events from public.races where id = '22222222-2222-2222-2222-222222222222') = array['Olympic','Sprint'], 'a new distance is appended and the old one kept');

-- Adding it again is a no-op, with no error and no second copy.
select t.as_user('alice');
select public.add_race_event('22222222-2222-2222-2222-222222222222', 'Sprint');
select public.add_race_event('22222222-2222-2222-2222-222222222222', 'Olympic');
reset role;
select t.ok((select events from public.races where id = '22222222-2222-2222-2222-222222222222') = array['Olympic','Sprint'], 'a distance already there is not added twice');

-- A signed-in account that is not on the allow-list cannot add one.
select t.as_user('bob');
select t.fails($$select public.add_race_event('22222222-2222-2222-2222-222222222222', 'Ironman')$$, '42501');
reset role;
select t.ok(not ('Ironman' = any (select unnest(events) from public.races where id = '22222222-2222-2222-2222-222222222222')), 'an unlisted account adds nothing');

-- Anonymous callers cannot reach the function.
select t.as_anon();
select t.fails($$select public.add_race_event('22222222-2222-2222-2222-222222222222', 'Ironman')$$, '42501');
reset role;

-- A missing race is refused, not reported as success.
select t.as_user('alice');
select t.fails($$select public.add_race_event(gen_random_uuid(), 'Sprint')$$, '42501');
reset role;

-- A removed race is refused too.
update public.races set deleted_at = now() where id = '22222222-2222-2222-2222-222222222222';
select t.as_user('alice');
select t.fails($$select public.add_race_event('22222222-2222-2222-2222-222222222222', 'Ironman')$$, '42501');
reset role;
update public.races set deleted_at = null where id = '22222222-2222-2222-2222-222222222222';

-- The size limit still applies: the 31st distance is refused.
update public.races set events = (select array_agg('d' || g) from generate_series(1, 30) g)
  where id = '22222222-2222-2222-2222-222222222222';
select t.as_user('alice');
select t.fails($$select public.add_race_event('22222222-2222-2222-2222-222222222222', 'one more')$$, '23514');
reset role;

-- Two callers in a row each keep the other's distance (the row is re-read).
update public.races set events = array['Olympic'] where id = '22222222-2222-2222-2222-222222222222';
select t.as_user('alice');
select public.add_race_event('22222222-2222-2222-2222-222222222222', 'A');
select public.add_race_event('22222222-2222-2222-2222-222222222222', 'B');
reset role;
select t.ok((select events from public.races where id = '22222222-2222-2222-2222-222222222222') = array['Olympic','A','B'], 'consecutive adds keep each other');

\o
\echo 'add_race_event: all checks passed'
rollback;
