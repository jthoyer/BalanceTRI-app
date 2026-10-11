-- Tests for the fixes from the R1 and R2 reviews of PR 76 (step B3).
-- Run with supabase/tests/run.sh.
--
-- Note: set_config('request.jwt.claims', ...) lasts to the end of the
-- transaction, so "reset role" alone still leaves the last user's id in
-- auth.uid(). Lines that need to act as the dashboard clear it as well.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

insert into t.u values ('owner', 'ff177de1-36e1-44ce-8c7b-3361fcf78054');
select t.mk(n) from unnest(array['pat','quin','rob','rex','lou','mo','ned','liz','nia','noa','ada','leo','lia','okay']) n;
select t.list(n) from unnest(array['lou','liz','leo','lia']) n;

-- ---------------------------------------------------------------------------
-- R2 H1: an unconfirmed account must not keep a pre-approval alive.
-- ---------------------------------------------------------------------------
insert into private.allowed_emails (email_hash) values (private.email_hash('una@example.com'));
insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), 'una@example.com', null);
insert into t.u select 'una', id from auth.users where email = 'una@example.com';
select t.ok(exists (select 1 from auth.users u where private.email_hash(u.email) = private.email_hash('una@example.com')),
  'the attack: a planted unconfirmed account matches the orphan hash, so a G1 that counts any account would keep it');
delete from private.allowed_emails
 where email_hash not in (
   select private.email_hash(email) from auth.users
    where email is not null and email_confirmed_at is not null
 );
select t.ok(not t.listed('una@example.com'), 'G1 counts confirmed accounts only, so the hash goes');
select t.ok(t.listed('lou@example.com') and t.listed('liz@example.com'), 'G1 keeps hashes of confirmed accounts');
-- With Confirm email off, signing up again confirms the planted account.
update auth.users set email_confirmed_at = now() where email = 'una@example.com';
select t.as_user('una');
select t.ok(not private.is_allow_listed(), 'once confirmed, the planted account is not listed');
select t.fails($$insert into public.races (name, date) values ('Una Race', '2027-03-03')$$, '42501');
reset role;
-- The cutover cleanup of unconfirmed accounts, as given in the migration header.
insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), 'bot@example.com', null);
delete from auth.users where email_confirmed_at is null;
select t.ok(not exists (select 1 from auth.users where email_confirmed_at is null), 'the cleanup removes unconfirmed accounts');
select t.ok(exists (select 1 from auth.users where email = 'una@example.com'), 'and keeps confirmed ones');

-- G2 refuses an unconfirmed account too.
insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), 'uno@example.com', null);
select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_allow_list_add('uno@example.com')$$) = 'That account hasn''t confirmed its email address, so it can''t be approved.', 'G2 refuses an unconfirmed account');
reset role;
select t.ok(not t.listed('uno@example.com'), 'and writes no hash');

-- ---------------------------------------------------------------------------
-- R1 M1 / R2 L1, scenario A: a rename while pending moves the request's name
-- with it, so the name guard covers the new name and frees the old one.
-- ---------------------------------------------------------------------------
select t.as_user('pat');
select public.request_access('Sam Pending');
select t.ok(t.rows($$update public.profiles set display_name = 'Sammy Renamed' where id = t.id('pat')$$) = 1, 'a pending member can rename');
select t.ok(public.my_access_status() ->> 'display_name' = 'Sammy Renamed', 'my_access_status shows the new name');
reset role;
select t.ok((select display_name from private.access_requests where user_id = t.id('pat')) = 'Sammy Renamed', 'the request follows the rename');
select t.as_user('quin');
select t.ok(t.msg($$select public.request_access('sammy renamed')$$) like 'Someone at the club already uses that name.%', 'the new name is reserved');
reset role;
select t.as_user('rob');
select t.ok(public.request_access('Sam Pending') ->> 'state' = 'pending', 'the old name is free again');
reset role;
select t.as_user('owner', 'aal2');
select t.ok((select display_name from public.admin_requests() where user_id = t.id('pat')) = 'Sammy Renamed', 'the console shows the new name');
reset role;

-- Scenario B: an existing member takes a rejected person's name, then the
-- admin tries to reapprove that person.
select t.as_user('rex');
select public.request_access('Rex Rejected');
reset role;
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('rex'), 'reject');
reset role;
select t.as_user('lou');
select t.ok(t.rows($$update public.profiles set display_name = 'Rex Rejected' where id = t.id('lou')$$) = 1, 'a member may take a rejected name');
reset role;
select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_decide_request(t.id('rex'), 'reapprove')$$) = 'Another member now uses that name, so this account can''t be approved as it is.', 'reapprove re-checks the name against existing members');
reset role;
select t.ok((select status from private.access_requests where user_id = t.id('rex')) = 'rejected', 'the refused reapprove changed nothing');
select t.ok(not t.listed('rex@example.com'), 'and listed nothing');

-- ---------------------------------------------------------------------------
-- R1 L2: listing an address whose request name is now taken gives a clear
-- message and changes nothing.
-- ---------------------------------------------------------------------------
select t.as_user('mo');
select public.request_access('Mo Clash');
reset role;
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('mo'), 'reject');
reset role;
select t.as_user('ned');
select public.request_access('Mo Clash');
reset role;
select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_allow_list_add('mo@example.com')$$) = 'Another member now uses that name, so this account can''t be approved as it is.', 'add refuses a name clash in plain words');
reset role;
select t.ok(not t.listed('mo@example.com'), 'the refused add listed nothing');
select t.as_user('owner', 'aal2');
select public.admin_allow_list_add('ned@example.com');
reset role;
select t.ok((select target ->> 'request_from' from private.admin_actions where action = 'allow_list_add' order by id desc limit 1) = 'pending', 'the log records what the request was before');
select t.ok((select target ->> 'user_id' from private.admin_actions where action = 'allow_list_add' order by id desc limit 1) = t.id('ned')::text, 'and whose it was');

-- ---------------------------------------------------------------------------
-- R2 M1 / R1 M2: the history logs real renames only, and renames are capped.
-- ---------------------------------------------------------------------------
select count(*) as h0 from private.change_history where table_name = 'profiles' \gset
select t.mk('newbie');
delete from auth.users where id = t.id('newbie');
select t.ok((select count(*) from private.change_history where table_name = 'profiles') = :h0, 'a sign-up and a deletion log no profile history');
select t.as_user('liz');
select t.ok(t.rows($$update public.profiles set display_name = display_name where id = t.id('liz')$$) = 1, 'a no-op update is allowed');
reset role;
select t.ok((select count(*) from private.change_history where table_name = 'profiles') = :h0, 'and logs nothing');
select t.as_user('liz');
select t.rows(format($$update public.profiles set display_name = 'Liz %s' where id = t.id('liz')$$, w))
  from unnest(array['One','Two','Three','Four','Five']) w;
select t.ok((select display_name from public.profiles where id = t.id('liz')) = 'Liz Five', 'five renames in a day are allowed');
select t.ok(t.msg($$update public.profiles set display_name = 'Liz Six' where id = t.id('liz')$$) = 'You can change your name 5 times a day. Try again tomorrow.', 'the sixth is refused');
reset role;
select set_config('request.jwt.claims', '', true);
select t.ok(t.rows($$update public.profiles set display_name = 'Liz Dashboard' where id = t.id('liz')$$) = 1, 'the dashboard is not capped');

-- ---------------------------------------------------------------------------
-- Look-alikes: the same letters in a different Unicode form are one name.
-- ---------------------------------------------------------------------------
select t.as_user('nia');
select public.request_access('Zoë Nfc');
reset role;
select t.as_user('noa');
select t.ok(t.msg(format('select public.request_access(%L)', 'Zoe' || chr(776) || ' Nfc')) like 'Someone at the club already uses that name.%', 'a decomposed accent clashes with the composed one');
reset role;
select t.as_user('ada');
select public.request_access('Ade' || chr(769) || 'le');
reset role;
select t.ok((select display_name from private.access_requests where user_id = t.id('ada')) = 'Adéle', 'names are stored composed (NFC)');

-- ---------------------------------------------------------------------------
-- R1 L3: an existing member who loses their listing sees revoked, not the join
-- form, and the admin can reapprove them.
-- ---------------------------------------------------------------------------
select t.as_user('owner', 'aal2');
select public.admin_allow_list_remove('leo@example.com');
reset role;
select t.as_user('leo');
select t.ok(public.my_access_status() ->> 'state' = 'revoked', 'a removed existing member sees revoked');
select t.ok(t.msg($$select public.request_access('Leo Again')$$) = 'This account can''t send another request. Contact the club.', 'and cannot slip back into the queue');
reset role;
select t.ok((select reason from private.access_requests where user_id = t.id('leo')) = 'Removed from the allow-list', 'the row says why');
select t.as_user('owner', 'aal2');
select public.admin_decide_request(t.id('leo'), 'reapprove');
reset role;
select t.ok(t.listed('leo@example.com'), 'reapprove lists them again');

update auth.users set email = 'lia.new@example.com' where id = t.id('lia');
select t.ok((select status from private.access_requests where user_id = t.id('lia')) = 'revoked', 'an existing member who changes email gets a revoked row');
select t.ok((select reason from private.access_requests where user_id = t.id('lia')) = 'Email address changed', 'with the reason');
select t.ok(not t.listed('lia@example.com') and not t.listed('lia.new@example.com'), 'and neither address is listed');

-- An account that was never listed gets no row from an email change.
update auth.users set email = 'okay.new@example.com' where id = t.id('okay');
select t.ok(not exists (select 1 from private.access_requests where user_id = t.id('okay')), 'an unlisted account gets no revoked row');

-- The helpers stay closed to the API roles.
select t.ok(not has_function_privilege('authenticated', 'private.lock_account(uuid)', 'execute'), 'lock_account is closed to members');
select t.ok(not has_function_privilege('authenticated', 'private.fallback_name(uuid)', 'execute'), 'fallback_name is closed to members');

\o
\echo B3 review-fix checks passed
rollback;
