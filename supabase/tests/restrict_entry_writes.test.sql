-- Tests for migration 20261022060000_restrict_entry_writes_to_owners.sql:
-- owner-only update and delete on entries, results by created_by only, and
-- mixed-script display names refused. Run with supabase/tests/run.sh.
--
-- Every check about rows is scoped to the test races below, because the
-- replayed migrations carry the club's real data.
begin;
\set QUIET on
\o /dev/null
\i supabase/tests/helpers.sql

insert into t.u values ('owner', 'ff177de1-36e1-44ce-8c7b-3361fcf78054');
select t.mk(n) from unnest(array['amy','ben','cal','adm','outsider','newbie','multi']) n;
select t.list(n) from unnest(array['amy','ben','cal','multi']) n;
update public.profiles set display_name = 'Amy Archer' where id = t.id('amy');
update public.profiles set display_name = 'Ben Baker' where id = t.id('ben');
update public.profiles set display_name = 'Cal Carter' where id = t.id('cal');
update public.profiles set display_name = 'Multi Owner' where id = t.id('multi');
-- An admin who is not on the member allow-list.
insert into private.admins (user_id) values (t.id('adm'));
select t.ok(not t.listed('adm@example.com'), 'the second admin is not on the allow-list');

insert into public.races (id, name, date, balance_bolt, event_type) values
  ('a1000000-0000-0000-0000-000000000001', 'Future Race', '2099-01-01', false, null),
  ('a1000000-0000-0000-0000-000000000002', 'Past Race', '2020-01-01', false, null),
  ('a1000000-0000-0000-0000-000000000003', 'Past Bolt', '2020-01-02', true, 'Balance Bolt');

-- Amy's and Ben's entries are owned; "Cal Carter" is typed and unowned.
-- A trigger stamps created_by from auth.uid() on insert, so rows made here
-- start unowned. Owners are set afterwards, as postgres (no auth.uid(), so the
-- write-once rule does not apply).
insert into public.entries (id, race_id, name, level, events) values
  ('e1000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'Amy Archer', 'considering', '{}'),
  ('e1000000-0000-0000-0000-00000000000b', 'a1000000-0000-0000-0000-000000000001', 'Ben Baker', 'considering', '{}'),
  ('e1000000-0000-0000-0000-00000000000c', 'a1000000-0000-0000-0000-000000000001', 'Cal Carter', 'considering', '{}');
update public.entries set created_by = t.id('amy') where id = 'e1000000-0000-0000-0000-00000000000a';
update public.entries set created_by = t.id('ben') where id = 'e1000000-0000-0000-0000-00000000000b';
select t.ok((select created_by is null from public.entries where id = 'e1000000-0000-0000-0000-00000000000c'), 'Cal''s entry starts unowned');

-- AC 1: the owner (a plain member, aal1) updates and deletes their own entry.
select t.as_user('amy');
select t.ok(t.rows($$update public.entries set level = 'locked' where id = 'e1000000-0000-0000-0000-00000000000a'$$) = 1, 'owner updates own entry: 1 row');
select t.ok(t.rows($$update public.entries set events = '{Sprint}' where id = 'e1000000-0000-0000-0000-00000000000a'$$) = 1, 'owner updates own events: 1 row');
reset role;
select t.ok((select level = 'locked' from public.entries where id = 'e1000000-0000-0000-0000-00000000000a'), 'the owner''s update was saved');

-- AC 2: someone else cannot touch it.
select t.as_user('ben');
select t.ok(t.rows($$update public.entries set level = 'not' where id = 'e1000000-0000-0000-0000-00000000000a'$$) = 0, 'another member''s update: 0 rows');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000a'$$) = 0, 'another member''s delete: 0 rows');
reset role;
select t.ok((select level = 'locked' and name = 'Amy Archer' from public.entries where id = 'e1000000-0000-0000-0000-00000000000a'), 'the other member changed nothing');

-- AC 5: an unowned entry is not writable by the member whose name matches it.
select t.as_user('cal');
select t.ok(t.rows($$update public.entries set level = 'locked' where id = 'e1000000-0000-0000-0000-00000000000c'$$) = 0, 'name match no longer lets Cal update: 0 rows');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000c'$$) = 0, 'name match no longer lets Cal delete: 0 rows');
reset role;

-- AC 3: an admin with two-factor and the allow-list may. Without either, may not.
select t.as_user('owner', 'aal2');
select t.ok(t.rows($$update public.entries set level = 'locked' where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 1, 'admin aal2 updates another''s entry: 1 row');
select t.ok(t.rows($$update public.entries set level = 'locked' where id = 'e1000000-0000-0000-0000-00000000000c'$$) = 1, 'AC5: admin aal2 updates an unowned entry: 1 row');
reset role;
select t.ok((select created_by = t.id('ben') from public.entries where id = 'e1000000-0000-0000-0000-00000000000b'), 'an admin edit keeps the owner');
select t.as_user('owner', 'aal1');
select t.ok(t.rows($$update public.entries set level = 'not' where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 0, 'admin aal1 update: 0 rows');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 0, 'admin aal1 delete: 0 rows');
reset role;
select t.as_user('adm', 'aal2');
select t.ok(t.rows($$update public.entries set level = 'not' where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 0, 'admin not on the allow-list update: 0 rows');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 0, 'admin not on the allow-list delete: 0 rows');
reset role;
select t.ok((select level = 'locked' from public.entries where id = 'e1000000-0000-0000-0000-00000000000b'), 'Ben''s entry survived the refused attempts');

-- AC 4: the allow-list still gates the owner.
delete from private.allowed_emails where email_hash = private.email_hash('ben@example.com');
select t.as_user('ben');
select t.ok(t.rows($$update public.entries set level = 'not' where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 0, 'delisted owner update: 0 rows');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 0, 'delisted owner delete: 0 rows');
reset role;
select t.list('ben');

-- AC 3 (delete) and AC 5 (delete): the admin removes an entry; the owner removes theirs.
select t.as_user('owner', 'aal2');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000c'$$) = 1, 'admin aal2 deletes an unowned entry: 1 row');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000b'$$) = 1, 'admin aal2 deletes another''s entry: 1 row');
reset role;
select t.as_user('amy');
select t.ok(t.rows($$delete from public.entries where id = 'e1000000-0000-0000-0000-00000000000a'$$) = 1, 'owner deletes own entry: 1 row');
reset role;

-- AC 6: insert is unchanged.
select t.as_user('amy');
select t.ok(t.rows($$insert into public.entries (race_id, name, level, events) values ('a1000000-0000-0000-0000-000000000001', 'Amy Archer', 'considering', '{}')$$) = 1, 'a member inserts under their own name');
reset role;
select t.ok((select created_by = t.id('amy') from public.entries where race_id = 'a1000000-0000-0000-0000-000000000001' and name = 'Amy Archer'), 'created_by is stamped with the inserter');
select t.as_user('outsider');
select t.fails($$insert into public.entries (race_id, name, level, events) values ('a1000000-0000-0000-0000-000000000001', 'outsider', 'considering', '{}')$$, '42501');
reset role;

-- reset role leaves the last user's claims set; seed as the dashboard would.
select set_config('request.jwt.claims', '', true);

-- AC 7: the bulk guard still applies to an owner of many entries.
insert into public.races (id, name, date)
  select ('b1000000-0000-0000-0000-00000000000' || g)::uuid, 'Bulk ' || g, ('2099-02-0' || g)::date from generate_series(1, 6) g;
insert into public.entries (race_id, name, level, events)
  select ('b1000000-0000-0000-0000-00000000000' || g)::uuid, 'Multi Owner', 'considering', '{}' from generate_series(1, 6) g;
update public.entries set created_by = t.id('multi') where name = 'Multi Owner';
select t.as_user('multi');
select t.fails($$update public.entries set level = 'locked' where created_by = t.id('multi')$$, '%Too many entries rows%');
select t.ok(t.rows($$update public.entries set level = 'locked' where race_id = 'b1000000-0000-0000-0000-000000000001'$$) = 1, 'the owner can still change one at a time');
reset role;

select set_config('request.jwt.claims', '', true);
-- AC 8: results belong to created_by alone.
insert into public.entries (id, race_id, name, level, events) values
  ('e2000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000002', 'Amy Archer', 'considering', '{}'),
  ('e2000000-0000-0000-0000-00000000000c', 'a1000000-0000-0000-0000-000000000002', 'Cal Carter', 'considering', '{}'),
  ('e2000000-0000-0000-0000-00000000000d', 'a1000000-0000-0000-0000-000000000003', 'Amy Archer', 'considering', '{}');
update public.entries set created_by = t.id('amy') where id in ('e2000000-0000-0000-0000-00000000000a', 'e2000000-0000-0000-0000-00000000000d');
select t.as_user('amy');
select t.ok(t.rows($$insert into public.results (entry_id, status, finish_seconds) values ('e2000000-0000-0000-0000-00000000000a', 'finished', 3600)$$) = 1, 'the owner inserts a result');
select t.fails($$insert into public.results (entry_id, status, finish_seconds) values ('e2000000-0000-0000-0000-00000000000d', 'finished', 3600)$$, '42501');
reset role;
select t.as_user('cal');
select t.fails($$insert into public.results (entry_id, status, finish_seconds) values ('e2000000-0000-0000-0000-00000000000c', 'finished', 3600)$$, '42501');
reset role;
select t.as_user('owner', 'aal2');
select t.ok(t.rows($$insert into public.results (entry_id, status, finish_seconds) values ('e2000000-0000-0000-0000-00000000000c', 'finished', 3700)$$) = 1, 'an admin inserts a result on the unowned entry');
reset role;

-- AC 9 and 10: mixed scripts.
select t.as_user('newbie');
select t.ok(t.msg($$select public.request_access(U&'S\0430m Lee')$$) like 'Your name mixes letters from different alphabets%', 'request_access refuses Latin plus Cyrillic');
select t.ok(t.msg($$select public.request_access(U&'Sam \0393')$$) like 'Your name mixes letters from different alphabets%', 'request_access refuses Latin plus Greek');
select t.ok(t.msg($$select public.request_access(U&'\0393\0430')$$) like 'Your name mixes letters from different alphabets%', 'request_access refuses Greek plus Cyrillic');
reset role;
select t.ok((select count(*) from private.access_requests where user_id = t.id('newbie')) = 0, 'refused requests write no row');
select t.as_user('amy');
select t.ok(t.msg($$update public.profiles set display_name = U&'Am\0443 Archer' where id = t.id('amy')$$) like 'Your name mixes letters from different alphabets%', 'a member rename refuses mixed scripts');
reset role;
select t.ok((select display_name = 'Amy Archer' from public.profiles where id = t.id('amy')), 'the profile name is unchanged');
select t.as_user('owner', 'aal2');
select t.ok(t.msg($$select public.admin_rename_member(t.id('cal'), U&'Cal \0416')$$) like 'Your name mixes letters from different alphabets%', 'admin_rename_member refuses mixed scripts');
reset role;
select t.ok((select display_name = 'Cal Carter' from public.profiles where id = t.id('cal')), 'Cal''s name is unchanged');

-- Letters that draw nothing are refused on all three paths.
select t.as_user('newbie');
select t.ok(t.msg(format($$select public.request_access(%L)$$, 'Alex Smith' || U&'\3164')) like 'Use letters, spaces%', 'request_access refuses a Hangul filler');
select t.ok(t.msg(format($$select public.request_access(%L)$$, 'Alex' || U&'\115f' || 'Smith')) like 'Use letters, spaces%', 'request_access refuses a Hangul choseong filler');
reset role;
select t.as_user('amy');
select t.ok(t.msg(format($$update public.profiles set display_name = %L where id = t.id('amy')$$, 'Amy Archer' || U&'\ffa0')) like 'Use letters, spaces%', 'a member rename refuses a halfwidth filler');
select t.ok(t.msg(format($$update public.profiles set display_name = %L where id = t.id('amy')$$, 'Amy Archer' || U&'\2800')) like 'Use letters, spaces%', 'a member rename refuses a braille blank');
reset role;
select t.ok((select display_name = 'Amy Archer' from public.profiles where id = t.id('amy')), 'the profile name is unchanged by the refused renames');
select t.as_user('owner', 'aal2');
select t.ok(t.msg(format($$select public.admin_rename_member(t.id('cal'), %L)$$, 'Cal Carter' || U&'\1160')) like 'Use letters, spaces%', 'admin_rename_member refuses a Hangul jungseong filler');
reset role;
select t.ok(private.clean_display_name(U&'\d55c\ae00') is not null, 'ordinary Hangul still passes');

-- admin_undo of a delete keeps the original owner.
select set_config('request.jwt.claims', '', true);
insert into public.entries (id, race_id, name, level, events) values
  ('e3000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000002', 'Ben Baker', 'considering', '{}');
update public.entries set created_by = t.id('ben') where id = 'e3000000-0000-0000-0000-00000000000a';
select t.as_user('owner', 'aal2');
select t.ok(t.rows($$delete from public.entries where id = 'e3000000-0000-0000-0000-00000000000a'$$) = 1, 'an admin deletes Ben''s entry');
reset role;
select set_config('t.del_change', (select max(id)::text from private.change_history where table_name = 'entries' and op = 'DELETE'), false);
select t.as_user('owner', 'aal2');
select public.admin_undo(current_setting('t.del_change')::bigint);
reset role;
select t.ok((select created_by = t.id('ben') from public.entries where id = 'e3000000-0000-0000-0000-00000000000a'), 'undoing the delete restores the entry to its original owner, not the admin');
select t.as_user('ben');
select t.ok(t.rows($$update public.entries set level = 'locked' where id = 'e3000000-0000-0000-0000-00000000000a'$$) = 1, 'and Ben can change it again');
reset role;
select t.ok((select count(*) from private.change_history where table_name = 'entries' and row_id = 'e3000000-0000-0000-0000-00000000000a' and op = 'INSERT' and id > current_setting('t.del_change')::bigint) = 1, 'the undo wrote exactly one INSERT history row');
select t.ok((select (new_row ->> 'created_by')::uuid = t.id('ben') from private.change_history where table_name = 'entries' and row_id = 'e3000000-0000-0000-0000-00000000000a' and op = 'INSERT' order by id desc limit 1), 'and it carries the original owner');
select t.ok(not exists (select 1 from private.change_history where table_name = 'entries' and row_id = 'e3000000-0000-0000-0000-00000000000a' and op = 'UPDATE' and id > current_setting('t.del_change')::bigint and old_row ->> 'created_by' is distinct from new_row ->> 'created_by'), 'with no owner-change UPDATE row');
-- A member's direct insert still cannot choose the owner.
select t.as_user('multi');
select t.ok(t.rows(format($$insert into public.entries (race_id, name, level, events, created_by) values ('a1000000-0000-0000-0000-000000000001', 'Multi Owner', 'considering', '{}', %L)$$, t.id('amy'))) = 1, 'a member inserts naming someone else as owner');
reset role;
select t.ok((select created_by = t.id('multi') from public.entries where race_id = 'a1000000-0000-0000-0000-000000000001' and name = 'Multi Owner'), 'and is stamped as the owner anyway');

-- The restore is undoable: delete, undo (restore), then undo the restore.
select set_config('request.jwt.claims', '', true);
insert into public.entries (id, race_id, name, level, events) values
  ('e3000000-0000-0000-0000-00000000000b', 'a1000000-0000-0000-0000-000000000003', 'Cal Carter', 'considering', '{}');
update public.entries set created_by = t.id('cal') where id = 'e3000000-0000-0000-0000-00000000000b';
select t.as_user('owner', 'aal2');
select t.rows($$delete from public.entries where id = 'e3000000-0000-0000-0000-00000000000b'$$);
reset role;
select set_config('t.del2', (select max(id)::text from private.change_history where table_name = 'entries' and op = 'DELETE'), false);
select t.as_user('owner', 'aal2');
select public.admin_undo(current_setting('t.del2')::bigint);
reset role;
select set_config('t.ins2', (select max(id)::text from private.change_history where table_name = 'entries' and op = 'INSERT'), false);
select t.as_user('owner', 'aal2');
select public.admin_undo(current_setting('t.ins2')::bigint);
reset role;
select t.ok(not exists (select 1 from public.entries where id = 'e3000000-0000-0000-0000-00000000000b'), 'the restore itself can be undone');

-- An owner whose account is gone: the restore leaves the entry unowned.
select set_config('request.jwt.claims', '', true);
select t.mk('ghost');
insert into public.entries (id, race_id, name, level, events) values
  ('e3000000-0000-0000-0000-00000000000c', 'a1000000-0000-0000-0000-000000000002', 'Ghost Rider', 'considering', '{}');
update public.entries set created_by = t.id('ghost') where id = 'e3000000-0000-0000-0000-00000000000c';
delete from public.entries where id = 'e3000000-0000-0000-0000-00000000000c';
select set_config('t.del3', (select max(id)::text from private.change_history where table_name = 'entries' and op = 'DELETE'), false);
delete from auth.users where id = t.id('ghost');
select t.as_user('owner', 'aal2');
select public.admin_undo(current_setting('t.del3')::bigint);
reset role;
select t.ok((select created_by is null from public.entries where id = 'e3000000-0000-0000-0000-00000000000c'), 'an owner whose account is gone: restored unowned, no error');

-- Each condition of the keep-owner branch of entries_set_created_by, alone.
-- (a) Not an API role, flag OFF: the chosen owner is ignored. Amy's claims are
-- set but the role stays the table owner, so the only thing missing is the flag.
select set_config('app.entries_link_ok', '', true);
select set_config('request.jwt.claims', json_build_object('sub', t.id('amy'), 'role', 'authenticated')::text, true);
insert into public.entries (id, race_id, name, level, events, created_by) values
  ('e4000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-000000000001', 'Amy Archer', 'considering', '{}', t.id('ben'));
select t.ok((select created_by = t.id('amy') from public.entries where id = 'e4000000-0000-0000-0000-00000000000a'), 'flag off, not an API role: created_by is stamped, the chosen owner is ignored');
-- (b) API role, flag ON: still stamped as the caller. The member can set the
-- setting themselves, so the role check alone must hold.
select set_config('request.jwt.claims', '', true);
select t.as_user('multi');
select set_config('app.entries_link_ok', 'on', true);
select t.ok(t.rows(format($$insert into public.entries (id, race_id, name, level, events, created_by) values ('e4000000-0000-0000-0000-00000000000b', 'a1000000-0000-0000-0000-000000000003', 'Multi Owner', 'considering', '{}', %L)$$, t.id('amy'))) = 1, 'an API role inserts with the flag on');
reset role;
select set_config('app.entries_link_ok', '', true);
select t.ok((select created_by = t.id('multi') from public.entries where id = 'e4000000-0000-0000-0000-00000000000b'), 'API role, flag on: created_by is still the caller, not the chosen owner');

-- AC 10: names that must still pass.
select t.ok(private.clean_display_name(n) = n, 'passes: ' || n)
  from unnest(array['Sam Lee', 'Zoë', 'José Núñez', 'O’Brien', U&'\0421\0435\0440\0433\0435\0439',
                    U&'\0393\03b9\03ce\03c1\03b3\03bf\03c2', U&'Sam \5c71\7530', 'Anne-Marie St. John']) n;
select t.ok(private.clean_display_name(U&'Zoe\0308') = U&'Zo\00eb', 'decomposed Zoë passes and is normalised');
select t.ok(private.clean_display_name(U&'\0421\0430\043c\0301') is not null, 'Cyrillic with a combining mark passes');

\o
\echo restrict_entry_writes: all checks passed
rollback;
