-- Tests for migration 20261012050100_add_admin_password_reset.sql (step B5).
-- The database half of spec test T9. Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

insert into t.u values ('owner', 'ff177de1-36e1-44ce-8c7b-3361fcf78054');
select t.mk(n) from unnest(array['sam','kit']) n;
select t.list('sam');
-- Sam is signed in on two devices; Kit on one.
insert into auth.sessions (id, user_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', t.id('sam')),
  ('aaaaaaaa-0000-0000-0000-000000000002', t.id('sam')),
  ('aaaaaaaa-0000-0000-0000-000000000003', t.id('kit'));
insert into auth.refresh_tokens (token, user_id, session_id) values
  ('r1', t.id('sam')::text, 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('r2', t.id('sam')::text, 'aaaaaaaa-0000-0000-0000-000000000002'),
  ('r3', t.id('kit')::text, 'aaaaaaaa-0000-0000-0000-000000000003');

-- T9: anon, a member, and the admin without two-factor are all refused.
select t.as_anon();
select t.fails($$select public.admin_password_reset_begin(t.id('sam'))$$, '42501');
reset role;
select t.as_user('kit');
select t.fails($$select public.admin_password_reset_begin(t.id('sam'))$$, '42501');
reset role;
select t.as_user('owner', 'aal1');
select t.fails($$select public.admin_password_reset_begin(t.id('sam'))$$, '42501');
reset role;
select t.ok((select count(*) from private.password_resets) = 0, 'refused calls flag nobody');
select t.ok((select count(*) from auth.sessions where user_id = t.id('sam')) = 2, 'refused calls sign nobody out');

-- With two-factor it works.
select t.as_user('owner', 'aal2');
select t.ok((public.admin_password_reset_begin(t.id('sam')) ->> 'user_id') = t.id('sam')::text, 'the admin with two-factor can begin a reset');
select t.ok(t.msg($$select public.admin_password_reset_begin(t.id('owner'))$$) = 'Use Change password for your own account.', 'an admin cannot reset their own password here');
select t.ok(t.msg($$select public.admin_password_reset_begin(gen_random_uuid())$$) = 'That account no longer exists.', 'an unknown account is refused');
reset role;

select t.ok((select reset_by from private.password_resets where user_id = t.id('sam')) = t.id('owner'), 'the flag records who reset');
select t.ok((select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute' from private.password_resets where user_id = t.id('sam')), 'the flag expires in 7 days');
select t.ok((select cleared_at is null from private.password_resets where user_id = t.id('sam')), 'the flag is set');
select t.ok((select count(*) from auth.sessions where user_id = t.id('sam')) = 0, 'every session of the member is gone (signed out everywhere)');
select t.ok((select count(*) from auth.refresh_tokens where user_id = t.id('sam')::text) = 0, 'and every refresh token');
select t.ok((select count(*) from auth.sessions where user_id = t.id('kit')) = 1, 'other members stay signed in');
select t.ok((select count(*) from auth.refresh_tokens where user_id = t.id('kit')::text) = 1, 'and keep their refresh tokens');
select t.ok(exists (select 1 from private.admin_actions where action = 'password_reset' and target ->> 'user_id' = t.id('sam')::text), 'the reset is logged');
select t.ok(not exists (select 1 from private.admin_actions where action = 'password_reset' and target::text ~* 'password"\s*:'), 'the log holds no password field');

-- The member sees the flag, and clearing it works (password_changed, from B3).
select t.as_user('sam');
select t.ok((public.my_access_status() ->> 'password_change_due')::boolean, 'the member must change their password');
select public.password_changed();
select t.ok(not (public.my_access_status() ->> 'password_change_due')::boolean, 'setting a new one clears it');
reset role;
select t.ok((select cleared_at is not null from private.password_resets where user_id = t.id('sam')), 'cleared_at is set');

-- A second reset re-arms a cleared flag.
select t.as_user('owner', 'aal2');
select public.admin_password_reset_begin(t.id('sam'));
reset role;
select t.ok((select cleared_at is null from private.password_resets where user_id = t.id('sam')), 'a new reset sets the flag again');
select t.ok((select count(*) from private.password_resets where user_id = t.id('sam')) = 1, 'still one row per member');

-- L1 (R2 on B5): a sign-in that lands between begin and the new password is
-- ended by finish.
insert into auth.sessions (id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000004', t.id('sam'));
insert into auth.refresh_tokens (token, user_id, session_id) values ('r4', t.id('sam')::text, 'aaaaaaaa-0000-0000-0000-000000000004');
select t.as_user('owner', 'aal2');
select public.admin_password_reset_finish(t.id('sam'));
reset role;
select t.ok((select count(*) from auth.sessions where user_id = t.id('sam')) = 0, 'finish ends a session opened during the reset');
select t.ok((select count(*) from auth.refresh_tokens where user_id = t.id('sam')::text) = 0, 'and its refresh token');
select t.ok((select count(*) from auth.sessions where user_id = t.id('kit')) = 1, 'and no one else''s');
select t.as_user('kit');
select t.fails($$select public.admin_password_reset_finish(t.id('sam'))$$, '42501');
reset role;

-- L2 (R2 on B5): an admin can't reset another admin.
select t.mk('second_admin');
insert into private.admins (user_id, mfa_required) values (t.id('second_admin'), true);
select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_password_reset_begin(t.id('second_admin'))$$) = 'Admins can''t reset another admin''s password here. Use the dashboard.', 'begin refuses another admin');
select t.ok(t.msg($$select public.admin_password_reset_finish(t.id('second_admin'))$$) = 'Admins can''t reset another admin''s password here. Use the dashboard.', 'finish refuses another admin');
reset role;
select t.ok(not exists (select 1 from private.password_resets where user_id = t.id('second_admin')), 'no flag for the other admin');

select t.ok(not has_function_privilege('anon', 'public.admin_password_reset_begin(uuid)', 'execute'), 'anon cannot call begin');
select t.ok(not has_function_privilege('anon', 'public.admin_password_reset_finish(uuid)', 'execute'), 'anon cannot call finish');

-- L1 (R1 on B5): a failed set is undone, and the log says so.
select t.as_user('owner', 'aal2');
select public.admin_password_reset_begin(t.id('kit'));
select public.admin_password_reset_abort(t.id('kit'));
reset role;
select t.ok(not exists (select 1 from private.password_resets where user_id = t.id('kit') and cleared_at is null), 'abort removes the flag');
select t.ok(exists (select 1 from private.admin_actions where action = 'password_reset_failed' and target ->> 'user_id' = t.id('kit')::text), 'abort logs the failure');
select t.as_user('kit');
select t.ok(not (public.my_access_status() ->> 'password_change_due')::boolean, 'the member is not asked for a new password');
select t.fails($$select public.admin_password_reset_abort(t.id('sam'))$$, '42501');
reset role;
select t.ok(not has_function_privilege('anon', 'public.admin_password_reset_abort(uuid)', 'execute'), 'anon cannot call abort');

\o
\echo B5 checks passed
rollback;
