-- Owner-only commitments, results by owner only, and mixed-script names refused.
--
-- 1. entries: update and delete need the caller to own the entry
--    (created_by = auth.uid()), or to be an admin with a two-factor session.
--    Both still need the allow-list. Insert is unchanged.
-- 2. results: private.can_write_result() loses its name-match branch. An entry
--    with created_by null is now writable by an admin only.
-- 3. private.clean_display_name() refuses a name that mixes Latin, Greek and
--    Cyrillic letters, and a name holding a letter that draws nothing.
-- 4. admin_undo of a deleted entry keeps the original created_by (one INSERT
--    history row, no second update).
--
-- This reverses a standing decision. Entry writes used to be an honour system:
-- any allow-listed member could change any commitment, because old entries had
-- no owner. On 22 October 2026 every commitment and result was deleted (done by
-- hand in the dashboard, not by this file), so every entry now has an owner.
-- The "honour system anyway" comment in 20261012042109 no longer holds.
--
-- Why a wrapper and not private.is_admin() in the policy: is_admin() has
-- EXECUTE revoked from authenticated. A policy runs with the caller's rights,
-- so calling it directly would fail every member's update and delete with
-- "permission denied for function". can_change_entry() is security definer
-- (as can_write_result is) and granted to authenticated; it calls is_admin()
-- as its owner.
--
-- No data is read or written by this file.

create function private.can_change_entry(p_created_by uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.is_allow_listed()
     and (
           (p_created_by is not null and p_created_by = auth.uid())
           or private.is_admin()
         );
$$;

revoke execute on function private.can_change_entry(uuid) from public, anon, authenticated;
grant execute on function private.can_change_entry(uuid) to authenticated;

drop policy "Members can update entries" on public.entries;
drop policy "Members can remove entries" on public.entries;

create policy "Owners and admins can update entries" on public.entries
  for update to authenticated
  using (private.can_change_entry(created_by))
  with check (private.can_change_entry(created_by));

create policy "Owners and admins can remove entries" on public.entries
  for delete to authenticated
  using (private.can_change_entry(created_by));

-- Results: created_by only. Same body as 20261013042941 minus the name branch.
create or replace function private.can_write_result(p_entry_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.is_allow_listed()
     and exists (
           select 1
             from public.entries e
             join public.races r on r.id = e.race_id
            where e.id = p_entry_id
              and r.deleted_at is null
              and not r.balance_bolt
              and r.date <= (now() at time zone 'Australia/Sydney')::date
              and (
                    private.is_admin()
                    or e.created_by = auth.uid()
                  )
         );
$$;

-- Display names: refuse two or more of Latin, Greek and Cyrillic.
-- The ranges are fixed code points, mirrored in app.js cleanDisplayName().
-- Marks, spaces, punctuation, CJK, Arabic and the rest belong to no group.
-- Not caught: a whole name in one look-alike script ("Сам" for "Cam").
-- Same body as 20261012042109 plus the new check.
create or replace function private.clean_display_name(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := normalize(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), NFC);
begin
  v := trim(regexp_replace(v, '͏', '', 'g'));
  if char_length(v) < 2 or char_length(v) > 40 then
    raise exception 'Your name needs to be 2 to 40 characters.';
  end if;
  if v !~ '^([[:alpha:]̀-ͯ]|[ ''.’-])+$' then
    raise exception 'Use letters, spaces, apostrophes, hyphens and full stops in your name.';
  end if;
  -- Letters that draw nothing (Hangul fillers, braille blank, Khmer inherent
  -- vowels): "Alex Smith" plus U+3164 would look like "Alex Smith" yet be a
  -- different name to the uniqueness check. Same message as any other
  -- character that is not allowed.
  if v ~ '[\u115f\u1160\u3164\uffa0\u2800\u17b4\u17b5]' then
    raise exception 'Use letters, spaces, apostrophes, hyphens and full stops in your name.';
  end if;
  if v !~ '[[:alpha:]]' then
    raise exception 'Your name needs at least one letter.';
  end if;
  if (case when v ~ '[A-Za-zªºÀ-ÖØ-öø-ʯḀ-ỿⱠ-Ɀ꜠-ꟿꬰ-꭯Ａ-Ｚａ-ｚ]' then 1 else 0 end)
   + (case when v ~ '[Ͱ-Ͽἀ-῿]' then 1 else 0 end)
   + (case when v ~ '[Ѐ-ԯᲀ-᲏ⷠ-ⷿꙀ-ꚟ]' then 1 else 0 end) >= 2 then
    raise exception 'Your name mixes letters from different alphabets, such as Latin and Cyrillic. Use one alphabet.';
  end if;
  return v;
end;
$$;

-- admin_undo of a deleted entry keeps its original owner. Same body as
-- 20261016043135, plus the created_by restore after the re-insert. Without it
-- the insert trigger stamps the admin, and the member loses their entry (it
-- would then be the admin's, and the member could not change it).
create or replace function public.admin_undo(p_change_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h private.change_history%rowtype;
  tbl text;
  cur jsonb;
  cols text;
  rec jsonb;
begin
  perform private.require_admin();

  select * into h from private.change_history where id = p_change_id;
  if not found then
    raise exception 'No such change.';
  end if;
  if h.table_name not in ('entries', 'races') then
    raise exception 'Changes to % cannot be undone here.', h.table_name;
  end if;
  if exists (select 1 from private.admin_actions where change_id = h.id and action = 'undo') then
    raise exception 'That change has already been undone.';
  end if;
  -- An owner change (Link, Unlink, or the set-null when an account is deleted)
  -- cannot be undone here. Undo restores every column except created_by, so it
  -- would put the old name back and leave the entry on the account. Reversing
  -- the owner too would be a link by another route, and Link has rules of its
  -- own (an approved account, a clash check, one log row). Use the Link entries
  -- panel instead.
  if h.table_name = 'entries'
     and h.op = 'UPDATE'
     and (h.old_row ->> 'created_by') is distinct from (h.new_row ->> 'created_by') then
    raise exception 'That change moved the entry to or from an account, so it cannot be undone here. Use Accounts → Manage → Link entries to link or unlink it.';
  end if;

  tbl := format('public.%I', h.table_name);
  execute format('select to_jsonb(t) from %s t where t.id = $1', tbl) into cur using h.row_id;

  begin
    if h.op = 'DELETE' then
      if cur is not null then
        raise exception 'That row exists again, so there is nothing to restore.';
      end if;
      -- Put the original owner back. The insert trigger stamps auth.uid() (the
      -- admin) unless this setting is on and the caller is not an API role, the
      -- same guard Link uses. One INSERT row in the history, owner intact. An
      -- owner whose account is gone becomes null, so the foreign key does not
      -- raise a misleading error.
      rec := h.old_row;
      if h.table_name = 'entries'
         and not exists (select 1 from auth.users u where u.id = (rec ->> 'created_by')::uuid) then
        rec := jsonb_set(rec, '{created_by}', 'null'::jsonb);
      end if;
      if h.table_name = 'entries' then
        perform set_config('app.entries_link_ok', 'on', true);
      end if;
      execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', tbl, tbl)
        using rec;
      perform set_config('app.entries_link_ok', '', true);
    elsif cur is null then
      raise exception 'That row no longer exists. Undo its deletion first.';
    elsif cur is distinct from h.new_row then
      raise exception 'That row has changed since. Undo the later change first.';
    elsif h.op = 'INSERT' then
      if h.table_name = 'races' then
        update public.races set deleted_at = now() where id = h.row_id;
      else
        delete from public.entries where id = h.row_id;
      end if;
    else
      -- Every column but the identity and the audit columns the triggers own.
      select string_agg(format('%I = o.%I', c.column_name, c.column_name), ', ')
        into cols
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = h.table_name
         and c.column_name not in ('id', 'created_at', 'created_by', 'updated_at', 'updated_by');
      execute format(
        'update %s t set %s from jsonb_populate_record(null::%s, $1) o where t.id = $2',
        tbl, cols, tbl
      ) using h.old_row, h.row_id;
    end if;
  exception
    when unique_violation then
      raise exception 'Undoing this would clash with a live row: a race with the same name and date, or an entry with the same name on that race.';
    when foreign_key_violation then
      raise exception 'The race this entry belonged to no longer exists.';
  end;

  insert into private.admin_actions (admin_id, action, change_id, target)
  values (auth.uid(), 'undo', h.id,
          jsonb_build_object('table', h.table_name, 'row_id', h.row_id, 'op', h.op));
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.admin_undo(bigint) from public, anon;
grant execute on function public.admin_undo(bigint) to authenticated;

-- entries_set_created_by: on INSERT keep the given created_by when the caller
-- is not an API role AND app.entries_link_ok is on (only admin_undo's re-insert
-- of a deleted entry sets it). Everything else is as in 20261016000000: an API
-- insert is stamped with auth.uid(), and a member cannot choose the owner.
create or replace function public.entries_set_created_by()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if current_user not in ('authenticated', 'anon')
       and coalesce(current_setting('app.entries_link_ok', true), '') = 'on' then
      return new;
    end if;
    new.created_by := auth.uid();
  elsif auth.uid() is not null then
    if current_user not in ('authenticated', 'anon')
       and coalesce(current_setting('app.entries_link_ok', true), '') = 'on' then
      return new;
    end if;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
