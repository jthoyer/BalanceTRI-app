-- ---------------------------------------------------------------------------
-- add_race_event: add one distance to a race's events, atomically.
--
-- Applied to the live project (shkfwuogrldbqldpipxd) as version 20261020030740.
--
-- The problem: app.js addEvent read races.events from its cache, appended, and
-- wrote the whole array back. Two members committing to new distances on the
-- same race at the same moment each wrote their own copy, and the second write
-- erased the first one's distance from the race.
--
-- The fix: one UPDATE that appends inside the database. A second caller waits
-- for the row lock, then re-checks the row as the first one left it, so both
-- distances survive. Adding a distance that is already there changes nothing.
--
-- Security invoker (the default), so the existing "Members can update races"
-- policy decides who may do this: approved members, on live races. The
-- races_events_size check, the audit and history triggers and the bulk guard
-- all still run. Execute is granted to authenticated only.
--
-- Errors: 42501 when the call changed nothing and the event is not already on
-- the race (not an approved member, or the race is gone or removed).
-- ---------------------------------------------------------------------------

create function public.add_race_event(p_race_id uuid, p_event text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.races
     set events = array_append(events, p_event)
   where id = p_race_id
     and not (p_event = any (events));
  if found then
    return;
  end if;
  -- Nothing to change. That is fine only if the distance is already there.
  if exists (select 1 from public.races where id = p_race_id and p_event = any (events)) then
    return;
  end if;
  raise exception 'This action is for approved members only.' using errcode = '42501';
end $$;

revoke execute on function public.add_race_event(uuid, text) from public, anon;
grant execute on function public.add_race_event(uuid, text) to authenticated;
