-- Tests for the B3 migrations, 20261012042054_add_access_requests_1_tables.sql
-- to 20261012045350_add_access_requests_8_allow_list_remove.sql.
-- Covers spec tests T1 to T6 and T10, plus the request state machine, the
-- display-name rules and the profile changes. Run with supabase/tests/run.sh.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

-- The replayed migrations carry the club's real races and entries, so every
-- check about rows is scoped to the test race below.
--
-- The cast: the owner (admin, from add_admin_console), alice (an existing
-- member, listed, no request row), and a few new accounts.
insert into t.u values ('owner', 'ff177de1-36e1-44ce-8c7b-3361fcf78054');
select t.mk(n) from unnest(array['alice','bob','carol','dave','erin','frank','gina','hank','ivy','jo','kim']) n;
select t.list('alice');
update public.profiles set display_name = 'Alice Archer' where id = t.id('alice');
insert into public.races (id, name, date) values ('11111111-1111-1111-1111-111111111111', 'Test Race', '2027-01-01');
insert into public.entries (race_id, name) values ('11111111-1111-1111-1111-111111111111', 'Seed Entry');

-- ---------------------------------------------------------------------------
-- The private tables are closed to the API roles.
-- ---------------------------------------------------------------------------
select t.as_user('alice');
select t.fails('select * from private.access_requests', '42501');
select t.fails('select * from private.password_resets', '42501');
reset role;
select t.as_anon();
select t.fails('select * from private.access_requests', '42501');
reset role;

-- ---------------------------------------------------------------------------
-- T6: request_access abuse.
-- ---------------------------------------------------------------------------
select t.as_anon();
select t.fails($$select public.request_access('Zed Zane')$$, '42501');
reset role;

select t.as_user('carol');
select t.ok(t.msg($$select public.request_access(repeat('a', 41))$$) = 'Your name needs to be 2 to 40 characters.', 'a 41-character name is refused');
select t.ok(t.msg($$select public.request_access('A')$$) = 'Your name needs to be 2 to 40 characters.', 'a 1-character name is refused');
select t.ok(t.msg($$select public.request_access('   ')$$) = 'Your name needs to be 2 to 40 characters.', 'a blank name is refused');
select t.ok(t.msg($$select public.request_access(null)$$) = 'Your name needs to be 2 to 40 characters.', 'a null name is refused');
select t.ok(t.msg($$select public.request_access('...')$$) = 'Your name needs at least one letter.', 'a punctuation-only name is refused');
select t.ok(t.msg($$select public.request_access('- - -')$$) = 'Your name needs at least one letter.', 'hyphens and spaces alone are refused');
select t.ok(t.msg($$select public.request_access('Sam 123')$$) like 'Use letters, spaces%', 'digits are refused');
select t.ok(t.msg($$select public.request_access('Sam <b>')$$) like 'Use letters, spaces%', 'markup is refused');
select t.ok(t.msg($$select public.request_access('Sam; drop table x')$$) like 'Use letters, spaces%', 'punctuation other than . '' - is refused');
select t.ok(t.msg($$select public.request_access('Sam', repeat('n', 281))$$) = 'Keep the note to 280 characters or fewer.', 'a 281-character note is refused');
reset role;
select t.ok((select count(*) from private.access_requests where user_id = t.id('carol')) = 0, 'refused calls write no request');

select t.as_user('carol');
select t.ok(public.request_access('  zoë   o''neil-smith jr.  ', 'squad B, invited by Jo') ->> 'display_name' = 'zoë o''neil-smith jr.', 'spaces are collapsed and the name kept');
select t.ok(t.msg($$select public.request_access('Someone Else')$$) = 'Your request is already waiting for the club admin.', 'a second call is refused');
reset role;
select t.ok((select count(*) from private.access_requests where user_id = t.id('carol')) = 1, 'one row per user');
select t.ok((select display_name from public.profiles where id = t.id('carol')) = 'zoë o''neil-smith jr.', 'request_access writes the profile name');
select t.ok((select status from private.access_requests where user_id = t.id('carol')) = 'pending', 'the request is pending');
select t.ok((select note from private.access_requests where user_id = t.id('carol')) = 'squad B, invited by Jo', 'the note is kept');
select t.ok(not exists (select 1 from private.change_history where table_name = 'profiles' and row_id = t.id('carol')), 'choosing a name when asking to join is not logged as a rename');

select t.as_user('dave');
select t.ok(t.msg($$select public.request_access('ZOË O''NEIL-SMITH JR.')$$) like 'Someone at the club already uses that name.%', 'a name clash ignores case');
select t.ok(t.msg($$select public.request_access('alice archer')$$) like 'Someone at the club already uses that name.%', 'a name clash with an existing member is refused');
select t.ok(public.request_access('山田 太郎') ->> 'state' = 'pending', 'letters in any language are allowed');
reset role;

select t.as_user('bob');
select t.ok(public.request_access('bob') ->> 'state' = 'pending', 'the seeded name of an unlisted account does not block anyone');
reset role;

select t.as_user('alice');
select t.ok(t.msg($$select public.request_access('Alice Again')$$) = 'You already have access.', 'a listed member cannot request');
reset role;

-- The unique index is the guard when two people ask at the same instant.
select t.fails($$insert into private.access_requests (user_id, display_name, status) values (t.id('erin'), 'ZOË O''NEIL-SMITH JR.', 'pending')$$, '23505');

-- ---------------------------------------------------------------------------
-- my_access_status: every state.
-- ---------------------------------------------------------------------------
select t.as_anon();
select t.fails('select public.my_access_status()', '42501');
reset role;
select t.as_user('erin');
select t.ok(public.my_access_status() ->> 'state' = 'none', 'no request is none');
reset role;
select t.as_user('carol');
select t.ok(public.my_access_status() ->> 'state' = 'pending', 'a waiting request is pending');
reset role;
select t.as_user('alice');
select t.ok(public.my_access_status() ->> 'state' = 'approved', 'an existing member is approved with no request row');
select t.ok((public.my_access_status() ->> 'password_change_due')::boolean = false, 'no reset means no password change due');
reset role;

-- ---------------------------------------------------------------------------
-- Admin decisions. The owner needs a two-factor (aal2) session.
-- ---------------------------------------------------------------------------
select t.as_user('owner', 'aal2');
select t.ok(public.admin_pending_count() = 3, 'three requests are pending (carol, dave, bob)');
select t.ok(public.admin_decide_request(t.id('carol'), 'approve', 'Known from squad B') ->> 'status' = 'approved', 'approve works');
reset role;
select t.ok(t.listed('carol@example.com'), 'approving adds the address to the allow-list');
select t.ok((select decided_by from private.access_requests where user_id = t.id('carol')) = t.id('owner'), 'the decision records who decided');
select t.ok((select reason from private.access_requests where user_id = t.id('carol')) = 'Known from squad B', 'the decision records the reason');
select t.ok(exists (select 1 from private.admin_actions where action = 'access_approve' and target ->> 'user_id' = t.id('carol')::text and target ->> 'reason' = 'Known from squad B'), 'the decision is logged');
select t.as_user('carol');
select t.ok(public.my_access_status() ->> 'state' = 'approved', 'the member now sees approved');
select t.ok(private.is_allow_listed(), 'the member is on the allow-list');
reset role;

select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_decide_request(t.id('carol'), 'approve')$$) = 'That request is approved, so you can''t approve it.', 'approving twice is refused');
select t.ok(t.msg($$select public.admin_decide_request(t.id('carol'), 'reapprove')$$) = 'That request is approved, so you can''t reapprove it.', 'reapprove needs a revoked or rejected request');
select t.ok(t.msg($$select public.admin_decide_request(t.id('dave'), 'revoke')$$) = 'That request is pending, so you can''t revoke it.', 'revoke needs an approved request');
select t.ok(t.msg($$select public.admin_decide_request(t.id('dave'), 'banana')$$) = 'Unknown decision.', 'an unknown decision is refused');
select t.ok(t.msg($$select public.admin_decide_request(t.id('owner'), 'approve')$$) = 'You can''t change your own access.', 'an admin cannot decide on themselves');
select t.ok(t.msg($$select public.admin_decide_request(t.id('erin'), 'approve')$$) = 'No request from that account.', 'no request, no decision');
select t.ok(t.msg($$select public.admin_decide_request(t.id('dave'), 'reject', repeat('r', 201))$$) = 'Keep the reason to 200 characters or fewer.', 'a long reason is refused');

select public.admin_decide_request(t.id('dave'), 'reject', 'Not a member');
reset role;
select t.ok(not t.listed('dave@example.com'), 'a rejected account is not listed');
select t.as_user('dave');
select t.ok(public.my_access_status() ->> 'state' = 'rejected', 'the member sees rejected');
select t.ok(t.msg($$select public.request_access('Dave Again')$$) = 'This account can''t send another request. Contact the club.', 'a rejected account cannot ask again');
reset role;

select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('dave'), 'reapprove');
reset role;
select t.ok(t.listed('dave@example.com'), 'reapprove lists a rejected account');
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('dave'), 'revoke', 'Left the club');
reset role;
select t.ok(not t.listed('dave@example.com'), 'revoke removes the address');
select t.as_user('dave');
select t.ok(public.my_access_status() ->> 'state' = 'revoked', 'the member sees revoked');
reset role;
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('dave'), 'reapprove');
reset role;
select t.ok(t.listed('dave@example.com'), 'reapprove lists a revoked account');
select t.ok((select count(*) from private.admin_actions where action in ('access_approve','access_reject','access_revoke','access_reapprove')) = 5, 'every decision is logged');

-- Reapproving into a name someone else now holds.
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('bob'), 'reject');
reset role;
select t.as_user('erin');
select public.request_access('bob');
reset role;
select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_decide_request(t.id('bob'), 'reapprove')$$) = 'Another member now uses that name. Rename this account in the dashboard, then try again.', 'reapprove into a taken name is refused');
reset role;
select t.ok((select status from private.access_requests where user_id = t.id('bob')) = 'rejected', 'the refused reapprove changed nothing');

-- A request that says approved while the address is no longer listed.
delete from private.allowed_emails where email_hash = private.email_hash('dave@example.com');
select t.as_user('dave');
select t.ok(public.my_access_status() ->> 'state' = 'revoked', 'approved but unlisted is reported as revoked');
reset role;

-- ---------------------------------------------------------------------------
-- admin_requests and admin_pending_count.
-- ---------------------------------------------------------------------------
select t.as_user('owner', 'aal2');
select t.ok((select count(*) from public.admin_requests()) = 4, 'admin_requests lists every request');
select t.ok((select count(*) from public.admin_requests('pending')) = 1, 'admin_requests filters by status');
select t.ok((select email from public.admin_requests('pending')) = 'erin@example.com', 'admin_requests includes the email from auth.users');
select t.ok((select status from public.admin_requests() limit 1) = 'pending', 'pending requests come first');
select t.ok((select listed from public.admin_requests() where email = 'carol@example.com'), 'listed is true for an approved account');
select t.ok(not (select listed from public.admin_requests() where email = 'bob@example.com'), 'listed is false for a rejected account');
select t.ok((select notified_at is null from public.admin_requests('pending')), 'notified_at is exposed, empty until the notifier runs');
select t.ok(t.msg($$select * from public.admin_requests('bogus')$$) = 'Unknown status.', 'an unknown status is refused');
select t.ok(public.admin_pending_count() = 1, 'the pending count follows');
reset role;

-- ---------------------------------------------------------------------------
-- T2 and the allow-list admin functions (G2).
-- ---------------------------------------------------------------------------
select count(*) as before_n from private.allowed_emails \gset
select t.as_user('owner', 'aal2');
select t.fails($$select public.admin_allow_list_add('nobody@example.com')$$, 'No account uses that address.');
select t.fails($$select public.admin_allow_list_add('not an email')$$, 'That doesn''t look like an email address.');
reset role;
select t.ok((select count(*) from private.allowed_emails) = :before_n, 'a refused add writes no hash');
select t.as_user('owner', 'aal2');
select t.ok((public.admin_allow_list_add('GINA@example.com') ->> 'added')::boolean, 'an add for an existing account works, whatever the case');
reset role;
select t.ok(t.listed('gina@example.com'), 'the address is listed');
-- Adding an address settles its request, so the panel and the list agree.
select t.as_user('owner', 'aal2');
select public.admin_allow_list_add('erin@example.com');
reset role;
select t.ok((select status from private.access_requests where user_id = t.id('erin')) = 'approved', 'listing an address approves its pending request');
select t.as_user('owner', 'aal2');
select public.admin_allow_list_remove('erin@example.com');
reset role;
select t.ok((select status from private.access_requests where user_id = t.id('erin')) = 'revoked', 'unlisting an address revokes its approved request');
select t.ok(not t.listed('erin@example.com'), 'the address is no longer listed');

-- ---------------------------------------------------------------------------
-- T5: pending and unlisted accounts cannot write. Alice, listed, can.
-- ---------------------------------------------------------------------------
select t.as_user('hank');
select public.request_access('Hank Hill');
-- Insert under the account's own display name so the name guard passes and the
-- write-access rule (42501) is what refuses it.
select t.fails($$insert into public.entries (race_id, name) values ('11111111-1111-1111-1111-111111111111', (select display_name from public.profiles where id = auth.uid()))$$, '42501');
select t.fails($$insert into public.races (name, date) values ('Hank Race', '2027-02-02')$$, '42501');
select t.ok(t.rows($$update public.entries set level = 'locked'$$) = 0, 'a pending account updates no entries');
select t.ok(t.rows($$delete from public.entries$$) = 0, 'a pending account deletes no entries');
select t.ok(t.rows($$update public.races set name = 'Hacked'$$) = 0, 'a pending account updates no races');
reset role;
select t.as_user('jo');
select t.fails($$insert into public.entries (race_id, name) values ('11111111-1111-1111-1111-111111111111', (select display_name from public.profiles where id = auth.uid()))$$, '42501');
reset role;
select t.as_user('alice');
select t.ok(t.rows($$insert into public.entries (race_id, name) values ('11111111-1111-1111-1111-111111111111', 'Alice Archer')$$) = 1, 'an existing member can still add an entry');
select t.ok(t.rows($$update public.entries set level = 'locked' where name = 'Alice Archer'$$) = 1, 'an existing member can still update an entry');
select t.ok(t.rows($$delete from public.entries where name = 'Alice Archer'$$) = 1, 'an existing member can still delete an entry');
reset role;
select t.ok((select count(*) from public.entries where race_id = '11111111-1111-1111-1111-111111111111') = 1, 'the seed entry is untouched');
select t.ok((select name from public.races where id = '11111111-1111-1111-1111-111111111111') = 'Test Race', 'the seed race is untouched');
-- An approved account can write at once.
select t.as_user('carol');
select t.ok(t.rows($$insert into public.entries (race_id, name) values ('11111111-1111-1111-1111-111111111111', (select display_name from public.profiles where id = auth.uid()))$$) = 1, 'an approved account can write');
reset role;

-- ---------------------------------------------------------------------------
-- T3: G3, account deleted. The hash goes, and a new account on the same address
-- starts from nothing.
-- ---------------------------------------------------------------------------
select t.as_user('ivy');
select public.request_access('Ivy Iverson');
reset role;
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('ivy'), 'approve');
reset role;
select t.ok(t.listed('ivy@example.com'), 'ivy is listed');
delete from auth.users where id = t.id('ivy');
select t.ok(not t.listed('ivy@example.com'), 'deleting the account removes its hash');
select t.ok((select count(*) from private.access_requests where user_id = t.id('ivy')) = 0, 'and its request');
update t.u set id = gen_random_uuid() where name = 'ivy';
insert into auth.users (id, email, email_confirmed_at) values (t.id('ivy'), 'ivy@example.com', now());
select t.as_user('ivy');
select t.ok(not private.is_allow_listed(), 'a new account on the same address is not listed');
select t.ok(public.my_access_status() ->> 'state' = 'none', 'it starts with no request');
select t.ok(public.request_access('Ivy Iverson') ->> 'state' = 'pending', 'and can ask again, landing in pending');
reset role;

-- ---------------------------------------------------------------------------
-- T4: G3, email changed. The old hash goes and the request is revoked. A change
-- of letter case alone is the same address and changes nothing.
-- ---------------------------------------------------------------------------
select t.as_user('frank');
select public.request_access('Frank Furter');
reset role;
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('frank'), 'approve');
reset role;
update auth.users set email = 'FRANK@Example.com' where id = t.id('frank');
select t.ok(t.listed('frank@example.com'), 'a case-only email change keeps the hash');
select t.ok((select status from private.access_requests where user_id = t.id('frank')) = 'approved', 'and the approval');
update auth.users set email = 'frank.new@example.com' where id = t.id('frank');
select t.ok(not t.listed('frank@example.com'), 'an email change removes the old hash');
select t.ok(not t.listed('frank.new@example.com'), 'and does not list the new address');
select t.ok((select status from private.access_requests where user_id = t.id('frank')) = 'revoked', 'the request is revoked');
select t.ok((select reason from private.access_requests where user_id = t.id('frank')) = 'Email address changed', 'with the reason');
select t.as_user('frank');
select t.ok(not private.is_allow_listed(), 'the account with the new address is not listed');
select t.ok(public.my_access_status() ->> 'state' = 'revoked', 'and sees revoked');
reset role;
select t.mk('frank_squatter');
update auth.users set email = 'frank@example.com' where id = t.id('frank_squatter');
select t.as_user('frank_squatter');
select t.ok(not private.is_allow_listed(), 'a new account on the old address is not listed');
reset role;

-- ---------------------------------------------------------------------------
-- T1: the claimable pre-approval (the 5.2 attack) and the G1 cleanup. With
-- Confirm email off a new account is confirmed at once, so a hash with no
-- account behind it can be claimed by signing up with that address.
-- ---------------------------------------------------------------------------
insert into private.allowed_emails (email_hash) values (private.email_hash('ghost@example.com'));
select t.mk('ghost');
select t.as_user('ghost');
select t.ok(private.is_allow_listed(), 'BEFORE G1: signing up with an orphan address is listed (the attack)');
reset role;
delete from auth.users where id = t.id('ghost');   -- G3 removes that hash again, so put it back
insert into private.allowed_emails (email_hash) values (private.email_hash('ghost@example.com'));
-- The G1 cleanup, as given in the migration header.
delete from private.allowed_emails
 where email_hash not in (
   select private.email_hash(email) from auth.users
    where email is not null and email_confirmed_at is not null
 );
select t.ok(not t.listed('ghost@example.com'), 'G1 removes a hash with no account');
select t.ok(t.listed('alice@example.com') and t.listed('carol@example.com'), 'G1 keeps hashes that have accounts');
insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), 'ghost@example.com', now());
update t.u set id = (select id from auth.users where email = 'ghost@example.com') where name = 'ghost';
select t.as_user('ghost');
select t.ok(not private.is_allow_listed(), 'AFTER G1: signing up with that address is not listed');
select t.fails($$insert into public.entries (race_id, name) values ('11111111-1111-1111-1111-111111111111', (select display_name from public.profiles where id = auth.uid()))$$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- password_resets: the flag and password_changed().
-- ---------------------------------------------------------------------------
insert into private.password_resets (user_id, reset_by, expires_at) values (t.id('alice'), t.id('owner'), now() + interval '7 days');
insert into private.password_resets (user_id, reset_by, expires_at) values (t.id('gina'), t.id('owner'), now() - interval '1 day');
select t.as_user('alice');
select t.ok((public.my_access_status() ->> 'password_change_due')::boolean, 'a reset makes a password change due');
select t.ok(not (public.my_access_status() ->> 'reset_expired')::boolean, 'within 7 days it is not expired');
reset role;
select t.as_user('gina');
select t.ok((public.my_access_status() ->> 'reset_expired')::boolean, 'past its expiry it is expired');
reset role;
select t.as_user('bob');
select public.password_changed();
reset role;
select t.ok((select cleared_at is null from private.password_resets where user_id = t.id('alice')), 'another account cannot clear the flag');
select t.as_user('alice');
select public.password_changed();
select t.ok(not (public.my_access_status() ->> 'password_change_due')::boolean, 'password_changed clears the flag');
reset role;
select t.ok((select cleared_at is not null from private.password_resets where user_id = t.id('alice')), 'cleared_at is set');
select t.as_anon();
select t.fails('select public.password_changed()', '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Profiles (F6, F7): renames follow the rules, and members can change nothing
-- but their display name.
-- ---------------------------------------------------------------------------
select t.as_user('alice');
select t.ok(t.msg($$update public.profiles set display_name = 'zoë o''neil-smith jr.' where id = t.id('alice')$$) like 'Someone at the club already uses that name.%', 'a rename into a taken name is refused');
select t.ok(t.msg($$update public.profiles set display_name = '12345' where id = t.id('alice')$$) like 'Use letters, spaces%', 'a rename must follow the name rules');
select t.ok(t.rows($$update public.profiles set display_name = '  Alice   A. Archer ' where id = t.id('alice')$$) = 1, 'a valid rename works');
select t.fails($$update public.profiles set justgo_status = 'verified' where id = t.id('alice')$$, '42501');
select t.fails($$update public.profiles set justgo_member_number = '123' where id = t.id('alice')$$, '42501');
select t.ok(t.rows($$update public.profiles set display_name = 'Mallory' where id = t.id('bob')$$) = 0, 'a member cannot rename someone else');
reset role;
select t.ok((select display_name from public.profiles where id = t.id('alice')) = 'Alice A. Archer', 'the rename was cleaned');
select t.ok((select new_row ->> 'display_name' from private.change_history where table_name = 'profiles' and row_id = t.id('alice') order by id desc limit 1) = 'Alice A. Archer', 'the rename is in the change history');
select t.ok((select old_row ->> 'display_name' from private.change_history where table_name = 'profiles' and row_id = t.id('alice') order by id desc limit 1) = 'Alice Archer', 'with the old name beside it');
set local role service_role;
select t.ok(t.rows($$update public.profiles set justgo_status = 'verified' where id = t.id('alice')$$) = 1, 'the service role can still set justgo_status');
reset role;

-- ---------------------------------------------------------------------------
-- T10: every admin function, as anon, as a member and as an admin without
-- two-factor. All refused with 42501. (admin_status is the one function a
-- non-admin may call, by design: it only describes the caller.)
-- ---------------------------------------------------------------------------
create temp table admin_calls (stmt text);
insert into admin_calls values
  ('select public.admin_stats()'),
  ('select * from public.admin_activity(30, 10)'),
  ('select public.admin_undo(1)'),
  ('select * from public.admin_removed_races()'),
  ('select public.admin_restore_race(gen_random_uuid())'),
  ('select * from public.admin_users()'),
  ('select public.admin_allow_list_check(''x@example.com'')'),
  ('select public.admin_allow_list_add(''x@example.com'')'),
  ('select public.admin_allow_list_remove(''x@example.com'')'),
  ('select * from public.admin_requests()'),
  ('select * from public.admin_requests(''pending'')'),
  ('select public.admin_decide_request(gen_random_uuid(), ''approve'')'),
  ('select public.admin_pending_count()'),
  ('select public.admin_password_reset_begin(gen_random_uuid())'),
  ('select public.admin_password_reset_finish(gen_random_uuid())'),
  ('select public.admin_password_reset_abort(gen_random_uuid())'),
  ('select public.admin_approve_requests(array[gen_random_uuid()])'),
  ('select public.admin_rename_member(gen_random_uuid(), ''Test Name'')'),
  ('select * from public.admin_link_candidates(gen_random_uuid())'),
  ('select public.admin_link_entries(gen_random_uuid(), array[gen_random_uuid()])'),
  ('select public.admin_unlink_entries(gen_random_uuid(), array[gen_random_uuid()])'),
  ('select * from public.admin_orphan_match_counts()');
grant select on admin_calls to anon, authenticated;
select t.ok((select count(*) from admin_calls) = (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'admin\_%' and p.proname <> 'admin_status') + 1, 'every admin function is in the list (admin_requests appears twice)');

select t.as_anon();
select t.fails(stmt, '42501') from admin_calls;
reset role;
select t.as_user('alice');
select t.fails(stmt, '42501') from admin_calls;
reset role;
select t.as_user('carol');
select t.fails(stmt, '42501') from admin_calls;
reset role;
select t.as_user('owner', 'aal1');
select t.fails(stmt, '42501') from admin_calls;
reset role;

-- No API role holds a grant it should not have.
select t.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('my_access_status','request_access','password_changed','admin_requests','admin_decide_request','admin_pending_count')
     and has_function_privilege('anon', p.oid, 'execute')
), 'anon cannot execute any new function');
select t.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('clean_display_name','display_name_taken','check_profile_rename','forget_deleted_account','forget_changed_email')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
), 'no API role can execute a new private function');

\o
\echo B3 checks passed
rollback;
