-- ---------------------------------------------------------------------------
-- Admin console: link and unlink orphan entries to an account.
--
-- NOT APPLIED to the live project. Apply with apply_migration (project
-- shkfwuogrldbqldpipxd), then rename this file to the version Supabase
-- recorded (list_migrations), as CLAUDE.md requires. The verification
-- queries a human runs afterwards are at the end of this file.
--
-- The problem: entries written before attribution existed, or from the
-- dashboard, have created_by = null. Nobody owns them, so the member they
-- were typed for cannot write that commitment's result (can_write_result
-- needs created_by = auth.uid()), and admin_rename_member skips them. An admin
-- needs to attach them to the right account.
--
-- What this adds (all security definer, search_path '', first statement
-- private.require_admin(), so aal2 is enforced; execute revoked from
-- public/anon and granted to authenticated):
--   admin_link_candidates(user)         read: unowned entries on live races
--                                       plus entries already linked to user
--   admin_link_entries(user, ids)       set created_by = user, rename the entry
--                                       to the account's display name
--   admin_unlink_entries(user, ids)     set created_by = null, keep the name
--   admin_orphan_match_counts()         optional: per account, how many
--                                       unowned entries match its name
--
-- Decisions (recorded here because this file is the decision log):
--   * Unlink does NOT restore the previous name. It clears created_by only.
--     Restoring could hit unique (race_id, name) or overwrite a name an admin
--     has since corrected. The old name stays recoverable from
--     private.admin_actions.target.entries[].old_name and from
--     private.change_history.old_row. Consequence: after Unlink the entry
--     still carries the member's display name, so by the name rule
--     (lower(btrim(name)) = lower(btrim(display_name)), the same comparison
--     can_write_result uses) it still looks like theirs. Fully detaching it
--     needs a rename in the dashboard.
--   * Bulk-write guard exemption. private.guard_bulk_write() only limits
--     current_user in ('authenticated','anon'). Inside a security definer
--     function owned by postgres, current_user is the owner, so the 5-row
--     guard does not apply (as for admin_rename_member and
--     admin_approve_requests). Link and Unlink cap themselves at 50 distinct
--     ids per call instead, mirroring batch approval. The guard is unchanged.
--   * Link requires an approved target: email confirmed and on the
--     allow-list. A pending sign-up called "Tony Smith" is unverified; handing
--     it real entries would hand a stranger attribution and result rights.
--     Unlink has no such rule (it must work for a revoked account).
--   * Link is all-or-nothing: one bad id or clash refuses the whole call.
--   * Name guard: private.guard_entry_name() returns early when
--     private.is_admin(), which holds inside these functions. Not changed.
--
-- The entries_set_created_by change (amends write-once):
--   20260924044305_entries_created_by_attribution.sql made created_by
--   "stamped from auth.uid(), never trusted from the client, and write-once",
--   and the trigger below enforces write-once with
--   `new.created_by := old.created_by` whenever auth.uid() is not null.
--   Inside a security definer function called by an admin auth.uid() is still
--   the admin (it reads the JWT claims, not current_user), so without a change
--   Link/Unlink would rename the entry and silently leave created_by alone.
--   This migration reverses write-once for these two functions ONLY.
--
--   Mechanism: the write-once branch is skipped only when BOTH hold:
--     (a) current_user not in ('authenticated','anon'), and
--     (b) the transaction-local setting app.entries_link_ok = 'on'.
--   Why it is safe:
--     (a) PostgREST runs every request as `authenticated` or `anon` (SET LOCAL
--         ROLE), so any write arriving through the API, by a member or by an
--         admin using app.js, fails (a) no matter what else it does. The
--         trigger is security invoker, so current_user inside it is the role
--         of the function that issued the UPDATE: postgres inside the
--         definer functions, the API role for a direct PATCH. A client cannot
--         change current_user to postgres: role switching is not exposed.
--     (b) is defence in depth: it narrows (a) to the two functions below, so
--         other definer functions (admin_undo, admin_rename_member, ...) keep
--         write-once. Only admin_link_entries / admin_unlink_entries set it,
--         with set_config(..., is_local => true), and clear it straight after
--         the UPDATE. A client cannot reach set_config over PostgREST (it is
--         in pg_catalog, which is not an exposed schema, and PostgREST only
--         lets requests set the pgrst.* GUCs via headers/claims, not
--         arbitrary ones). Even if a client did set it, (a) still blocks it.
--   Unchanged: INSERT still stamps auth.uid(); a dashboard/service-role write
--   and the FK's own ON DELETE SET NULL (auth.uid() is null) are left alone.
--   The function keeps its name, security invoker and search_path ''. The
--   trigger entries_created_by_biu is not touched.
-- ---------------------------------------------------------------------------

create or replace function public.entries_set_created_by()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Overwrites whatever the client sent: a caller cannot insert a row
    -- attributed to someone else.
    new.created_by := auth.uid();
  elsif auth.uid() is not null then
    -- Write-once against any authenticated write, except one made from inside
    -- admin_link_entries / admin_unlink_entries (see the migration header for
    -- why both conditions are required).
    if current_user not in ('authenticated', 'anon')
       and coalesce(current_setting('app.entries_link_ok', true), '') = 'on' then
      return new;
    end if;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_link_candidates: what the Link entries panel lists for one account.
-- ---------------------------------------------------------------------------
create function public.admin_link_candidates(p_user_id uuid)
returns table (
  entry_id uuid,
  race_id uuid,
  race_name text,
  race_date date,
  name text,
  events text[],
  level text,
  linked boolean,
  name_match boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name text;
begin
  perform private.require_admin();
  select lower(btrim(p.display_name)) into v_name
    from public.profiles p where p.id = p_user_id;
  if v_name = '' then
    v_name := null;
  end if;
  return query
    select e.id, r.id, r.name, r.date, e.name, e.events, e.level,
           e.created_by is not null,
           v_name is not null and lower(btrim(e.name)) = v_name
      from public.entries e
      join public.races r on r.id = e.race_id
     where e.created_by = p_user_id
        or (e.created_by is null and r.deleted_at is null)
     order by (e.created_by is not null) desc,
              (v_name is not null and lower(btrim(e.name)) = v_name) desc,
              r.date desc, e.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_link_entries
-- ---------------------------------------------------------------------------
create function public.admin_link_entries(p_user_id uuid, p_entry_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_display text;
  v_found int;
  v_owned int;
  v_renamed int;
  v_audit jsonb;
  v_clash text;
begin
  perform private.require_admin();

  select array_agg(distinct x) into v_ids from unnest(p_entry_ids) x where x is not null;
  if v_ids is null then
    raise exception 'Choose at least one entry.';
  end if;
  if cardinality(v_ids) > 50 then
    raise exception 'Link at most 50 at a time.';
  end if;

  -- Same lock as the access-request functions, so an email change or a
  -- revoke either finishes first (and is seen below) or waits for this.
  perform private.lock_account(p_user_id);

  select btrim(p.display_name) into v_display from public.profiles p where p.id = p_user_id;
  if v_display is null or v_display = '' then
    raise exception 'That account has no display name to link entries to.';
  end if;
  if not exists (
    select 1
      from auth.users u
     where u.id = p_user_id
       and u.email_confirmed_at is not null
       and exists (
             select 1 from private.allowed_emails a
              where a.email_hash = private.email_hash(u.email))
  ) then
    raise exception 'Approve this account before linking entries to it.';
  end if;

  -- Lock the chosen rows, then check them. Under READ COMMITTED a row another
  -- admin just linked is re-read after the lock, so only one of two racing
  -- calls can see created_by is null.
  select count(*), count(*) filter (where s.created_by is not null),
         count(*) filter (where s.name is distinct from v_display),
         jsonb_agg(jsonb_build_object(
           'entry_id', s.id, 'race_id', s.race_id,
           'old_name', s.name, 'new_name', v_display) order by s.id)
    into v_found, v_owned, v_renamed, v_audit
    from (
      select e.id, e.race_id, e.name, e.created_by
        from public.entries e
       where e.id = any (v_ids)
       order by e.id
         for update
    ) s;
  if v_found <> cardinality(v_ids) or v_owned > 0 then
    raise exception 'One of those entries is missing or already linked. Refresh and try again.';
  end if;

  -- Name the race when the rename would break unique (race_id, name): another
  -- row on the race already has the name, or two chosen entries share a race.
  select format('"%s" on %s (%s) would clash with another entry named "%s". Untick it, or remove the duplicate first.',
                e.name, r.name, to_char(r.date, 'FMDD Mon YYYY'), v_display)
    into v_clash
    from public.entries e
    join public.races r on r.id = e.race_id
   where e.id = any (v_ids)
     and exists (
           select 1 from public.entries x
            where x.race_id = e.race_id
              and x.id <> e.id
              and (x.name = v_display or x.id = any (v_ids)))
   order by r.date desc, r.name
   limit 1;
  if v_clash is not null then
    raise exception '%', v_clash;
  end if;

  perform set_config('app.entries_link_ok', 'on', true);
  update public.entries
     set created_by = p_user_id, name = v_display
   where id = any (v_ids);
  perform set_config('app.entries_link_ok', '', true);

  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'link_entries', jsonb_build_object(
    'user_id', p_user_id, 'display_name', v_display, 'entries', v_audit));

  return jsonb_build_object('linked', v_found, 'renamed', v_renamed);
exception when unique_violation then
  -- Only a concurrent insert can get here; the pre-check names the race.
  raise exception 'A name clash appeared while linking. Refresh and try again.';
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_unlink_entries: created_by back to null; the name stays.
-- ---------------------------------------------------------------------------
create function public.admin_unlink_entries(p_user_id uuid, p_entry_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_found int;
  v_audit jsonb;
  v_display text;
begin
  perform private.require_admin();

  select array_agg(distinct x) into v_ids from unnest(p_entry_ids) x where x is not null;
  if v_ids is null then
    raise exception 'Choose at least one entry.';
  end if;
  if cardinality(v_ids) > 50 then
    raise exception 'Unlink at most 50 at a time.';
  end if;

  perform private.lock_account(p_user_id);

  select count(*),
         jsonb_agg(jsonb_build_object(
           'entry_id', s.id, 'race_id', s.race_id, 'name', s.name) order by s.id)
    into v_found, v_audit
    from (
      select e.id, e.race_id, e.name
        from public.entries e
       where e.id = any (v_ids) and e.created_by = p_user_id
       order by e.id
         for update
    ) s;
  if v_found <> cardinality(v_ids) then
    raise exception 'That entry isn''t linked to this account. Refresh and try again.';
  end if;

  perform set_config('app.entries_link_ok', 'on', true);
  update public.entries set created_by = null where id = any (v_ids);
  perform set_config('app.entries_link_ok', '', true);

  select p.display_name into v_display from public.profiles p where p.id = p_user_id;
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'unlink_entries', jsonb_build_object(
    'user_id', p_user_id, 'display_name', v_display, 'entries', v_audit));

  return jsonb_build_object('unlinked', v_found);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_orphan_match_counts (optional, for the badge on waiting requests).
-- ---------------------------------------------------------------------------
create function public.admin_orphan_match_counts()
returns table (user_id uuid, matches int)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_admin();
  return query
    select p.id, count(*)::int
      from public.profiles p
      join public.entries e on lower(btrim(e.name)) = lower(btrim(p.display_name))
      join public.races r on r.id = e.race_id
     where e.created_by is null
       and r.deleted_at is null
       and btrim(p.display_name) <> ''
     group by p.id;
end;
$$;

revoke execute on function public.admin_link_candidates(uuid) from public, anon;
grant execute on function public.admin_link_candidates(uuid) to authenticated;
revoke execute on function public.admin_link_entries(uuid, uuid[]) from public, anon;
grant execute on function public.admin_link_entries(uuid, uuid[]) to authenticated;
revoke execute on function public.admin_unlink_entries(uuid, uuid[]) from public, anon;
grant execute on function public.admin_unlink_entries(uuid, uuid[]) to authenticated;
revoke execute on function public.admin_orphan_match_counts() from public, anon;
grant execute on function public.admin_orphan_match_counts() to authenticated;

-- ---------------------------------------------------------------------------
-- Verification after applying (NOT executed by this migration). Run in the
-- SQL editor; each block is in its own transaction and rolls back. Replace
-- <ADMIN>, <MEMBER>, <ORPHAN>, <RACE> with real ids. The impersonation form is
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     '{"sub":"<ADMIN>","role":"authenticated","aal":"aal2","email":"..."}', true);
--
-- (4) Non-admin / non-aal2 refused with 'Admins only.' (42501):
--   begin; set local role authenticated;
--   select set_config('request.jwt.claims','{"sub":"<MEMBER>","role":"authenticated","aal":"aal2"}',true);
--   select * from public.admin_link_candidates('<MEMBER>');   -- expect error
--   rollback;
--
-- (5) Link happy path, as admin (aal2):
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<ADMIN>","role":"authenticated","aal":"aal2"}', true);
--   select public.admin_link_entries('<MEMBER>', array['<ORPHAN>']::uuid[]);  -- {"linked":1,"renamed":0|1}
--   reset role;
--   select id, name, created_by from public.entries where id = '<ORPHAN>';    -- created_by = <MEMBER>, name = display name
--   select action, target from private.admin_actions order by id desc limit 1;  -- link_entries with old_name
--   select op, changed_by from private.change_history where row_id = '<ORPHAN>' order by id desc limit 1; -- UPDATE, <ADMIN>
--   rollback;
--
-- (6) Refusals. Each is its own transaction as admin (aal2); expect the quoted
--   message, then confirm nothing moved (see the last query).
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<ADMIN>","role":"authenticated","aal":"aal2"}', true);
--   select public.admin_link_entries('<MEMBER>', '{}');                      -- Choose at least one entry.
--   select public.admin_link_entries('<MEMBER>', array[null]::uuid[]);       -- Choose at least one entry.
--   select public.admin_link_entries('<MEMBER>', (select array_agg(gen_random_uuid()) from generate_series(1,51)));  -- Link at most 50 at a time.
--   select public.admin_link_entries('<ADMIN_WITHOUT_PROFILE>', array['<ORPHAN>']::uuid[]);  -- no display name
--   select public.admin_link_entries('<UNCONFIRMED_OR_UNLISTED>', array['<ORPHAN>']::uuid[]); -- Approve this account before linking entries to it.
--   select public.admin_link_entries('<MEMBER>', array[gen_random_uuid()]);  -- missing or already linked
--   select public.admin_link_entries('<MEMBER>', array['<OWNED>']::uuid[]);  -- missing or already linked
--   rollback;   -- (run each select in its own transaction: an error aborts the rest)
--   select count(*) from private.admin_actions where action = 'link_entries' and at > now() - interval '5 minutes'; -- 0 for refusals
--
-- (7) Clash: <ORPHAN_ON_RACE> is an orphan on a race where <MEMBER> already has an entry named as their display name.
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<ADMIN>","role":"authenticated","aal":"aal2"}', true);
--   select public.admin_link_entries('<MEMBER>', array['<ORPHAN_ON_RACE>']::uuid[]);  -- "..." on <race> (<date>) would clash ... Untick it, or remove the duplicate first.
--   rollback;
--
-- (8) Same-name entry: <ORPHAN_SAME_NAME> already has exactly the member's display name.
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<ADMIN>","role":"authenticated","aal":"aal2"}', true);
--   select public.admin_link_entries('<MEMBER>', array['<ORPHAN_SAME_NAME>']::uuid[]);  -- {"linked":1,"renamed":0}
--   rollback;
--
-- (9) Unlink: link first, then in the same transaction:
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<ADMIN>","role":"authenticated","aal":"aal2"}', true);
--   select public.admin_link_entries('<MEMBER>', array['<ORPHAN>']::uuid[]);
--   select public.admin_unlink_entries('<MEMBER>', array['<ORPHAN>']::uuid[]);  -- {"unlinked":1}
--   reset role; select id, name, created_by from public.entries where id = '<ORPHAN>';  -- created_by null, name = display name
--   select public.admin_unlink_entries('<MEMBER>', array['<ORPHAN>']::uuid[]);  -- That entry isn't linked to this account.
--   rollback;
--
-- (10) Write-once preserved, as the admin AND as a member, through the API role:
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<ADMIN>","role":"authenticated","aal":"aal2"}', true);
--   update public.entries set created_by = '<MEMBER>' where id = '<ORPHAN>';   -- created_by must NOT change
--   update public.entries set created_by = null where id = '<OWNED>';          -- must NOT change
--   select id, created_by from public.entries where id in ('<ORPHAN>','<OWNED>');
--   rollback;
--
-- (11) Name guard, as a non-admin member (their own entry <OWN>):
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<MEMBER>","role":"authenticated","aal":"aal1"}', true);
--   update public.entries set name = 'x' where id = '<OWN>';   -- Only a club admin can change a name.
--   rollback;
--   Then, as admin (aal2): select public.admin_rename_member('<MEMBER>', '<same or new name>');  -- still works
-- (12) Bulk guard, as a member: update more than 5 entries in one statement.
--   begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<MEMBER>","role":"authenticated","aal":"aal1"}', true);
--   update public.entries set level = level where created_by is not distinct from created_by;  -- Too many entries rows changed ... (needs more than 5 rows visible)
--   rollback;
--   select tgname from pg_trigger where tgrelid = 'public.entries'::regclass and not tgisinternal;
--   -- expect the unchanged set, including entries_created_by_biu and entries_bulk_guard_*.
-- ---------------------------------------------------------------------------
