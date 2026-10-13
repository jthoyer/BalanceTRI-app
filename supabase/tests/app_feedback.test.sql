-- Tests for migration 20261013034715_add_app_feedback.sql: the send-feedback
-- rate limits, and that only the service role can reach any of it.
-- Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

select t.mk('sam');

-- The browser's roles can't call either function, or read the table.
select t.as_anon();
select t.fails($$select public.feedback_claim('a'||repeat('0',31), null, 'hello there', '', '')$$, '42501');
select t.fails($$select public.feedback_mark_sent(1)$$, '42501');
select t.fails($$select count(*) from private.app_feedback$$, '42501');
reset role;
select t.as_user('sam');
select t.fails($$select public.feedback_claim('a'||repeat('0',31), null, 'hello there', '', '')$$, '42501');
select t.fails($$select public.feedback_mark_sent(1)$$, '42501');
select t.fails($$select count(*) from private.app_feedback$$, '42501');
reset role;

set local role service_role;

-- Three per sender in ten minutes; the fourth is refused and stores nothing.
select t.ok((public.feedback_claim(repeat('a',64), null, 'first message', '', '/'))->>'ok' = 'true', 'first send from a sender is accepted');
select t.ok((public.feedback_claim(repeat('a',64), null, 'second message', 'Jo', ''))->>'ok' = 'true', 'second is accepted');
select t.ok((public.feedback_claim(repeat('a',64), null, 'third message', '', ''))->>'ok' = 'true', 'third is accepted');
select t.ok((public.feedback_claim(repeat('a',64), null, 'fourth message', '', ''))->>'reason' = 'sender', 'the fourth in ten minutes is refused');
reset role;
select t.ok((select count(*) from private.app_feedback where source_hash = repeat('a',64)) = 3, 'a refused send stores nothing');
select t.ok((select contact from private.app_feedback where message = 'first message') is null, 'an empty contact is stored as null');
select t.ok((select page from private.app_feedback where message = 'first message') = '/', 'the page is kept');

-- Another sender is not affected.
set local role service_role;
select t.ok((public.feedback_claim(repeat('b',64), null, 'other sender', '', ''))->>'ok' = 'true', 'a different sender still gets through');
reset role;

-- Ten a day per sender, even spread out past the ten-minute window.
update private.app_feedback set created_at = now() - interval '1 hour' where source_hash = repeat('a',64);
insert into private.app_feedback (source_hash, message, created_at)
  select repeat('a',64), 'older message', now() - interval '2 hours' from generate_series(1, 7);
set local role service_role;
select t.ok((public.feedback_claim(repeat('a',64), null, 'eleventh today', '', ''))->>'reason' = 'sender', 'the eleventh in a day is refused');
reset role;
update private.app_feedback set created_at = now() - interval '25 hours' where source_hash = repeat('a',64);
set local role service_role;
select t.ok((public.feedback_claim(repeat('a',64), null, 'a new day', '', ''))->>'ok' = 'true', 'yesterday does not count');
reset role;

-- A signed-in member is also counted by account, whatever network they use.
insert into private.app_feedback (source_hash, user_id, message)
  select repeat('c',64), t.id('sam'), 'from the phone' from generate_series(1, 3);
set local role service_role;
select t.ok((public.feedback_claim(repeat('d',64), t.id('sam'), 'from the laptop', '', ''))->>'reason' = 'sender', 'a member who switches network is still limited by account');
reset role;

-- Fifty a day across the whole app.
delete from private.app_feedback;
insert into private.app_feedback (source_hash, message)
  select md5(g::text) || md5(g::text), 'filler message' from generate_series(1, 50) g;
set local role service_role;
select t.ok((public.feedback_claim(repeat('e',64), null, 'one too many', '', ''))->>'reason' = 'daily', 'the 51st message of the day is refused for everyone');
reset role;

-- Length limits hold in the database too, whatever the function lets through.
delete from private.app_feedback;
set local role service_role;
select t.fails($$select public.feedback_claim(repeat('f',64), null, repeat('x', 2001), '', '')$$, '23514');
select t.fails($$select public.feedback_claim(repeat('f',64), null, 'hey', '', '')$$, '23514');
select t.fails($$select public.feedback_claim(repeat('f',64), null, 'long contact', repeat('c', 121), '')$$, '23514');
select t.fails($$select public.feedback_claim('short', null, 'bad hash', '', '')$$, '23514');

-- Marking sent stamps sent_at once.
select (public.feedback_claim(repeat('f',64), null, 'to be sent', '', ''))->>'id' as sent_id \gset
select public.feedback_mark_sent(:sent_id);
reset role;
select t.ok((select sent_at is not null from private.app_feedback where id = :sent_id), 'mark_sent stamps sent_at');

\o
\echo 'app_feedback: all checks passed'
rollback;
