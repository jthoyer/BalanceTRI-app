-- Tests for migration 20261012210000_add_batch_approve.sql: approving several
-- waiting requests in one go. Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

insert into t.u values ('owner', 'ff177de1-36e1-44ce-8c7b-3361fcf78054');
select t.mk(n) from unnest(array['ana','ben','cal','dee','eve']) n;
-- Dee never confirmed her address, so she can't be approved.
update auth.users set email_confirmed_at = null where id = t.id('dee');
insert into private.access_requests (user_id, display_name, status)
select t.id(n), initcap(n) || ' Test', 'pending' from unnest(array['ana','ben','cal','dee']) n;
-- Eve was already rejected.
insert into private.access_requests (user_id, display_name, status)
values (t.id('eve'), 'Eve Test', 'rejected');

-- Anon, a member, and the admin without two-factor are all refused.
select t.as_anon();
select t.fails($$select public.admin_approve_requests(array[t.id('ana')])$$, '42501');
reset role;
select t.as_user('ana');
select t.fails($$select public.admin_approve_requests(array[t.id('ana')])$$, '42501');
reset role;
select t.as_user('owner', 'aal1');
select t.fails($$select public.admin_approve_requests(array[t.id('ana')])$$, '42501');
reset role;
select t.ok((select count(*) from private.access_requests where status = 'approved') = 0, 'refused calls approve nobody');

-- The admin with two-factor approves a batch. Ana and Ben go through; Ana is
-- listed twice and counted once. Dee (unconfirmed), Eve (rejected) and an
-- unknown id are skipped with a reason, and don't stop the rest.
select t.as_user('owner', 'aal2');
create temp table out as
select public.admin_approve_requests(array[t.id('ana'), t.id('ben'), t.id('ana'), t.id('dee'), t.id('eve'), gen_random_uuid()]) as r;
reset role;
select t.ok((select (r ->> 'approved')::int from out) = 2, 'two requests were approved');
select t.ok((select jsonb_array_length(r -> 'results') from out) = 5, 'one result per distinct id');
select t.ok((select count(*) from out, jsonb_array_elements(r -> 'results') e where (e ->> 'ok')::boolean = false) = 3, 'three were skipped');
select t.ok((select e ->> 'error' from out, jsonb_array_elements(r -> 'results') e where e ->> 'user_id' = t.id('dee')::text) like '%confirmed%', 'the unconfirmed account says why');
select t.ok((select status from private.access_requests where user_id = t.id('ana')) = 'approved', 'Ana is approved');
select t.ok((select status from private.access_requests where user_id = t.id('ben')) = 'approved', 'Ben is approved');
select t.ok(t.listed('ana@example.com') and t.listed('ben@example.com'), 'both are on the allow-list');
select t.ok((select status from private.access_requests where user_id = t.id('cal')) = 'pending', 'Cal, not chosen, still waits');
select t.ok((select status from private.access_requests where user_id = t.id('dee')) = 'pending', 'Dee still waits');
select t.ok(not t.listed('dee@example.com'), 'and is not listed');
select t.ok((select status from private.access_requests where user_id = t.id('eve')) = 'rejected', 'Eve stays rejected');
select t.ok((select count(*) from private.admin_actions where action = 'access_approve') = 2, 'one log row per approval');

-- Limits.
select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_approve_requests(array[]::uuid[])$$) = 'Choose at least one request.', 'an empty batch is refused');
select t.ok(t.msg($$select public.admin_approve_requests(null)$$) = 'Choose at least one request.', 'a null batch is refused');
select t.ok(t.msg($$select public.admin_approve_requests(array(select gen_random_uuid() from generate_series(1, 51)))$$) = 'Approve at most 50 at a time.', 'more than 50 is refused');
reset role;
select t.ok(not has_function_privilege('anon', 'public.admin_approve_requests(uuid[])', 'execute'), 'anon cannot call it');

\o
\echo batch approval checks passed
rollback;
