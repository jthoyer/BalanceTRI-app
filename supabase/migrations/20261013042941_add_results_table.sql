-- ---------------------------------------------------------------------------
-- Results on past races: the table and its rules.
--
-- One result per entry: a member records how their race went (finished, DNF
-- or DNS), with an optional time, places, a personal-best tick and a note.
--
-- Who sees what (decided 13 October 2026):
--   * Visitors, and accounts that are pending, rejected or revoked, see
--     nothing. There is no public view and no counts function: results are
--     members-only, the same gate as full names (private.is_allow_listed()).
--   * Approved members read every result.
--   * A result is written by the entry's owner or by an admin. The owner is
--     the member who created the entry (entries.created_by). Every entry on a
--     past race predates created_by, so for those the owner is the member whose
--     display name matches the entry's name. An unowned entry waits for its
--     person to sign up, or for an admin.
--
-- Other rules:
--   * Results open on the race date (Sydney time) and need a live race.
--     Balance Bolt races have none: sign-up and results live on its own site.
--   * Times run 1 second to 48 hours. A DNF or DNS carries no time or places.
--   * Same defences as entries and races: a 5-row bulk-write guard and the
--     change history. Admin "undo" only knows entries and races, so a result
--     change shows in the admin activity list but cannot be undone there.
--
-- Applied to the live project on 13 October 2026 and named after the version
-- Supabase recorded.
-- ---------------------------------------------------------------------------

create table public.results (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null unique references public.entries (id) on delete cascade,
  status text not null,
  finish_seconds integer,
  place_overall integer,
  place_age_group integer,
  is_pb boolean not null default false,
  note text,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint results_status_check check (status in ('finished', 'dnf', 'dns')),
  -- A finished result needs a time. A check passes on null, so say "is not
  -- null" outright rather than lean on between.
  constraint results_time_check check (
    (status = 'finished' and finish_seconds is not null and finish_seconds between 1 and 172800)
    or (status <> 'finished' and finish_seconds is null)
  ),
  constraint results_places_check check (
    (place_overall is null or (status = 'finished' and place_overall between 1 and 100000))
    and (place_age_group is null or (status = 'finished' and place_age_group between 1 and 100000))
  ),
  constraint results_pb_check check (not is_pb or status = 'finished'),
  constraint results_note_check check (note is null or char_length(note) <= 280)
);

-- ---------------------------------------------------------------------------
-- Who may write a result for this entry.
--
-- security definer so it can read entries, races and profiles whatever the
-- caller's own rights are. Returns false, never raises, so a policy that
-- calls it fails closed.
-- ---------------------------------------------------------------------------
create function private.can_write_result(p_entry_id uuid)
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
                    or (
                         e.created_by is null
                         and exists (
                               select 1
                                 from public.profiles p
                                where p.id = auth.uid()
                                  and lower(btrim(p.display_name)) = lower(btrim(e.name))
                             )
                       )
                  )
         );
$$;

revoke execute on function private.can_write_result(uuid) from public, anon, authenticated;
grant execute on function private.can_write_result(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security. No policy for anon, so a signed-out read returns no rows.
-- ---------------------------------------------------------------------------
alter table public.results enable row level security;

revoke all on public.results from public, anon, authenticated;
grant select, insert, update, delete on public.results to authenticated;

create policy "Members can read results" on public.results
  for select to authenticated
  using (private.is_allow_listed());

create policy "Owners and admins can add results" on public.results
  for insert to authenticated
  with check (private.can_write_result(entry_id));

create policy "Owners and admins can change results" on public.results
  for update to authenticated
  using (private.can_write_result(entry_id))
  with check (private.can_write_result(entry_id));

create policy "Owners and admins can remove results" on public.results
  for delete to authenticated
  using (private.can_write_result(entry_id));

-- ---------------------------------------------------------------------------
-- Stamps. created_by comes from auth.uid(), never from the client, and is
-- write-once. A result stays with its entry. updated_at is the server's.
-- The dashboard and the service role (no auth.uid()) may still move a result.
-- ---------------------------------------------------------------------------
create function private.results_stamp()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
  else
    if new.entry_id is distinct from old.entry_id and auth.uid() is not null then
      raise exception 'A result stays with its entry.';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function private.results_stamp() from public, anon, authenticated;

create trigger results_stamp_biu
  before insert or update on public.results
  for each row execute function private.results_stamp();

-- ---------------------------------------------------------------------------
-- Same defences as entries and races.
-- ---------------------------------------------------------------------------
create trigger results_bulk_guard_insert
  after insert on public.results
  referencing new table as changed_rows
  for each statement execute function private.guard_bulk_write('5');
create trigger results_bulk_guard_update
  after update on public.results
  referencing new table as changed_rows
  for each statement execute function private.guard_bulk_write('5');
create trigger results_bulk_guard_delete
  after delete on public.results
  referencing old table as changed_rows
  for each statement execute function private.guard_bulk_write('5');

create trigger results_history_aiud
  after insert or update or delete on public.results
  for each row execute function private.record_change();
