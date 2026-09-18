-- The Edit Race screen's "Remove race" action calls
--   db.from('races').delete().eq('id', raceId)
-- from the browser with the anon key. public.races had RLS enabled with
-- select/insert/update policies only, so the delete matched zero rows and
-- returned no error — the race silently stayed on the calendar.
-- This app is a public, no-login club tool, so deletes are permitted for
-- anyone with the link, matching "Public can remove entries" on public.entries.
create policy "Public can remove races" on public.races for delete using (true);
