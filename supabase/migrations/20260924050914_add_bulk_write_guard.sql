-- ---------------------------------------------------------------------------
-- Bulk-write guard on entries and races.
--
-- RLS decides *whether* a member may write a row, not *how many* at once. Any
-- allow-listed session could wipe every commitment with one request:
--   DELETE /rest/v1/entries?id=not.is.null
-- and blank the calendar the same way with a bulk soft-delete on races.
--
-- app.js only ever writes one row per request (saveEntry, removeEntry,
-- addRace, updateRace, deleteRace, addEvent), so a statement from the API
-- that touches more than 5 rows is never the app. These statement-level
-- triggers count the rows through a transition table and reject the whole
-- statement above that.
--
-- Only API roles are limited. current_user is 'authenticated' or 'anon' when
-- PostgREST runs a request; the dashboard (postgres) and the service role are
-- left alone, so bulk fixes and restores still work there.
-- ---------------------------------------------------------------------------
create or replace function private.guard_bulk_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  max_rows int := tg_argv[0]::int;
  n int;
begin
  if current_user not in ('authenticated', 'anon') then
    return null;
  end if;

  select count(*) into n from changed_rows;

  if n > max_rows then
    raise exception 'Too many % rows changed in one request (% of at most %).',
      tg_table_name, n, max_rows
      using errcode = 'P0001', hint = 'Change one row at a time.';
  end if;

  return null;
end;
$$;

revoke execute on function private.guard_bulk_write() from public, anon, authenticated;

-- One trigger per event: a trigger with transition tables can only name one.
create trigger entries_bulk_guard_insert
  after insert on public.entries
  referencing new table as changed_rows
  for each statement execute function private.guard_bulk_write('5');
create trigger entries_bulk_guard_update
  after update on public.entries
  referencing new table as changed_rows
  for each statement execute function private.guard_bulk_write('5');
create trigger entries_bulk_guard_delete
  after delete on public.entries
  referencing old table as changed_rows
  for each statement execute function private.guard_bulk_write('5');

create trigger races_bulk_guard_insert
  after insert on public.races
  referencing new table as changed_rows
  for each statement execute function private.guard_bulk_write('5');
create trigger races_bulk_guard_update
  after update on public.races
  referencing new table as changed_rows
  for each statement execute function private.guard_bulk_write('5');
create trigger races_bulk_guard_delete
  after delete on public.races
  referencing old table as changed_rows
  for each statement execute function private.guard_bulk_write('5');
