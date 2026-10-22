-- Owner-only commitments, part 2: entries update and remove go through
-- private.can_change_entry(). Insert and read are unchanged.
-- This ends the honour system: on 22 October 2026 every commitment was
-- cleared, so every entry now has an owner. No data is read or written.
-- The policies are altered in place (same command, same role), which leaves
-- the same end state as replacing them.
alter policy "Members can update entries" on public.entries
  rename to "Owners and admins can update entries";
alter policy "Owners and admins can update entries" on public.entries
  using (private.can_change_entry(created_by))
  with check (private.can_change_entry(created_by));

alter policy "Members can remove entries" on public.entries
  rename to "Owners and admins can remove entries";
alter policy "Owners and admins can remove entries" on public.entries
  using (private.can_change_entry(created_by));
