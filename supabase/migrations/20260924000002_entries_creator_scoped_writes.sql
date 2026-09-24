-- PLACEHOLDER TIMESTAMP: drafted 2026-09-24, not yet applied. After
-- apply_migration (project_id shkfwuogrldbqldpipxd), rename this file to the
-- version list_migrations reports, per CLAUDE.md.
--
-- DO NOT APPLY until the behaviour change below has an explicit yes. Requires
-- `entries_created_by_attribution` to be applied first.
--
-- ---------------------------------------------------------------------------
-- entries: only the member who created a commitment can edit or remove it.
--
-- Behaviour change (the reason this is its own migration):
--   * An allow-listed member can no longer correct a teammate's saved level or
--     events. saveEntry() upserts on (race_id, name); over someone else's row
--     the ON CONFLICT DO UPDATE fails the USING check below and Postgres
--     raises an RLS error rather than skipping the row.
--   * Adding a teammate by typing their name still works (INSERT is
--     unchanged), but the adder then owns that row — the teammate cannot edit
--     or remove it themselves when they sign in.
--   * Rows with created_by null — every row that existed before
--     `entries_created_by_attribution`, plus dashboard/service-role writes —
--     stay editable by any allow-listed member, the same pattern races uses.
--     Nobody can claim one: created_by is write-once (see that migration).
--
-- private.is_allow_listed() stays in every clause. The ticket this came from
-- predates `add_email_allow_list`, and its SQL recreated these policies with
-- only the creator check — applying that as written would have silently
-- dropped the allow-list and handed write access back to any throwaway
-- account. The creator check narrows the allow-list; it does not replace it.
--
-- INSERT is deliberately untouched ("Members can add entries", from
-- add_email_allow_list). So is races — see the ticket's open question.
-- ---------------------------------------------------------------------------

drop policy "Members can update entries" on public.entries;
drop policy "Members can remove entries" on public.entries;

create policy "Members can update their own entries" on public.entries
  for update to authenticated
  using (
    private.is_allow_listed()
    and (created_by is null or created_by = auth.uid())
  )
  with check (
    private.is_allow_listed()
    and (created_by is null or created_by = auth.uid())
  );

create policy "Members can remove their own entries" on public.entries
  for delete to authenticated
  using (
    private.is_allow_listed()
    and (created_by is null or created_by = auth.uid())
  );
