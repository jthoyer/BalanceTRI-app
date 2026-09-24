-- ---------------------------------------------------------------------------
-- Change history for entries and races.
--
-- Entries are hard-deleted: removeEntry() issues a real DELETE, so a
-- commitment removed by mistake, or by an abusive member, was simply gone.
-- Race edits overwrite the old name, date and URL with no trace. This keeps
-- the previous and new version of every row, who changed it and when.
--
-- private.change_history is invisible to the app: RLS on with no policies,
-- every grant revoked, and the private schema is never exposed over the API.
-- Read and restore from the dashboard. For example, to put back entries
-- deleted in the last day:
--
--   insert into public.entries
--   select (jsonb_populate_record(null::public.entries, old_row)).*
--     from private.change_history
--    where table_name = 'entries' and op = 'DELETE'
--      and changed_at > now() - interval '1 day';
--
-- changed_by is auth.uid(): null for the dashboard and the service role, as
-- with races.created_by. changed_role is the JWT role claim for the same
-- reason ('authenticated', 'anon', 'service_role', or null).
-- ---------------------------------------------------------------------------
create table private.change_history (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_id uuid not null,
  op text not null,
  old_row jsonb,
  new_row jsonb,
  changed_by uuid,
  changed_role text,
  changed_at timestamptz not null default now()
);

create index change_history_row_idx on private.change_history (table_name, row_id);
create index change_history_changed_at_idx on private.change_history (changed_at);

alter table private.change_history enable row level security;
revoke all on private.change_history from public, anon, authenticated;

-- security definer so the trigger can write a table no API role can touch.
create or replace function private.record_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.change_history
    (table_name, row_id, op, old_row, new_row, changed_by, changed_role)
  values (
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    tg_op,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    auth.uid(),
    auth.role()
  );
  return null;
end;
$$;

revoke execute on function private.record_change() from public, anon, authenticated;

create trigger entries_history_aiud
  after insert or update or delete on public.entries
  for each row execute function private.record_change();

create trigger races_history_aiud
  after insert or update or delete on public.races
  for each row execute function private.record_change();
