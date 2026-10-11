-- B3 and B4 together: a real request_access() call fires the notifier trigger,
-- the trigger sends only the user_id, and the claim and cap work on rows made
-- by the real functions. Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

select t.mk(n) from unnest(array['ann','ben']) n;

-- Without the Vault secret the trigger stays quiet, and the request is saved.
select t.as_user('ann');
select public.request_access('Ann Archer');
reset role;
select t.ok((select count(*) from net.calls) = 0, 'no Vault secret, no call');
select t.ok((select count(*) from private.access_requests) = 1, 'the request is saved anyway');

-- With the secret, one request makes one call that carries the user_id only.
insert into vault.secrets values ('notify_access_request_secret', 'shh');
select t.as_user('ben');
select public.request_access('Ben Bishop');
reset role;
select t.ok((select count(*) from net.calls) = 1, 'one request, one call');
select t.ok((select body from net.calls) = jsonb_build_object('user_id', t.id('ben')), 'the body is the user_id and nothing else');
select t.ok((select headers ->> 'x-notify-secret' from net.calls) = 'shh', 'the shared secret travels in a header');
select t.ok(not ((select body::text from net.calls) ilike '%Bishop%'), 'the name never leaves the database in the call');

-- The function's claim works on the row the real function made.
select t.ok(public.notifier_claim(t.id('ben')) ->> 'display_name' = 'Ben Bishop', 'the claim returns the name from the database');
select t.ok((select notified_at is not null from private.access_requests where user_id = t.id('ben')), 'and stamps notified_at');
select t.ok(public.notifier_claim(t.id('ben')) ->> 'send' = 'false', 'a second claim is refused');

-- A request decided before the call lands is not announced.
select t.mk('cat');
select t.as_user('cat');
select public.request_access('Cat Carter');
reset role;
update private.access_requests set status = 'rejected' where user_id = t.id('cat');
select t.ok(public.notifier_claim(t.id('cat')) ->> 'send' = 'false', 'a decided request is not announced');

\o
\echo B3 and B4 notifier checks passed
rollback;
