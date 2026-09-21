-- Saving, editing or removing a commitment now requires being signed in
-- (see requireSignIn() and the auth sheet in app.js) — reading the
-- calendar and every race's roster stays anonymous. This narrows the
-- anonymous write policies from create_races_and_entries.sql to
-- authenticated-only on entries; races keep allowing anonymous writes
-- (unchanged — races aren't gated by this feature), and entries reads
-- stay public. Sign-in still isn't tied to ownership: any authenticated
-- member can add or edit any entry by typed name, matching the
-- honour-system model the app already has.
drop policy "Public can add entries" on public.entries;
drop policy "Public can update entries" on public.entries;
drop policy "Public can remove entries" on public.entries;

create policy "Members can add entries" on public.entries
  for insert to authenticated with check (true);

create policy "Members can update entries" on public.entries
  for update to authenticated using (true) with check (true);

create policy "Members can remove entries" on public.entries
  for delete to authenticated using (true);
