-- ---------------------------------------------------------------------------
-- admin_undo refuses to undo an owner change on an entry.
--
-- Applied to the live project (shkfwuogrldbqldpipxd) as version 20261016043135.
--
-- The gap (accepted when Link entries shipped, 20261016000000): Link renames an
-- entry and sets created_by. admin_undo restores every column of the old row
-- except created_by, which the triggers own. Undoing a link therefore put the
-- old typed name back and left the entry owned by the account, with a name that
-- no longer matched its owner. The console hid the Undo button, but an RPC call
-- still went through.
--
-- The fix: admin_undo raises a clear message for any UPDATE on entries where
-- created_by differs between the old and new row. That covers Link, Unlink and
-- the set-null when an account is deleted. Nothing is written and nothing is
-- logged. The alternative, restoring the owner as well, would be a link by
-- another route: it would skip the approved-account rule Link enforces
-- (confirmed email and on the allow-list), its clash check and its log row. So
-- the way back is the Link entries panel, whose Unlink keeps the name and whose
-- Link renames to the display name.
--
-- Unchanged: undo of renames, inserts, deletes and race changes. The function
-- keeps its signature, so the existing grants (execute for authenticated, none
-- for public or anon) carry over; they are repeated below to be explicit.
-- ---------------------------------------------------------------------------

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
      execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', tbl, tbl)
        using h.old_row;
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
