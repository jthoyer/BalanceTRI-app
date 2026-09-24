-- PLACEHOLDER TIMESTAMP: drafted 2026-09-24, not yet applied. After
-- apply_migration (project_id shkfwuogrldbqldpipxd), rename this file to the
-- version list_migrations reports, per CLAUDE.md.
--
-- ---------------------------------------------------------------------------
-- entries: record who created each commitment. Attribution only — no policy
-- changes here, so this migration does not change what any member can do.
--
-- `add_email_allow_list` closed the throwaway-account case: a bot's disposable
-- inbox is not on the list, so it gets no write access at all. What is left
-- is one allow-listed member (or a compromised member account) editing or
-- deleting a *different* member's commitment. entries.name is free text with
-- no link to an account, so today that cannot even be traced afterwards.
-- This migration adds the link. Whether to *enforce* it is a separate,
-- deliberate decision — see `entries_creator_scoped_writes`, which depends on
-- this migration but can be left unapplied.
--
-- Same shape as races.created_by (`races_auth_writes_and_soft_delete`):
-- stamped by a trigger from auth.uid(), never trusted from the client, and
-- write-once.
-- ---------------------------------------------------------------------------

-- Null for every row that predates this migration, and for rows written from
-- the dashboard or the service role (auth.uid() is null there), so a hand-edit
-- records null rather than misattributing itself to a member.
alter table public.entries
  add column if not exists created_by uuid references auth.users on delete set null;

create or replace function public.entries_set_created_by()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Overwrites whatever the client sent: a caller cannot insert a row
    -- attributed to someone else.
    new.created_by := auth.uid();
  else
    -- Write-once. Without this an owner could PATCH created_by to null (making
    -- their row editable by everyone) or to another member's id — and in an
    -- upsert (saveEntry's INSERT ... ON CONFLICT DO UPDATE) the DO UPDATE path
    -- must not re-stamp the row with the second writer's id.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists entries_created_by_biu on public.entries;
create trigger entries_created_by_biu
  before insert or update on public.entries
  for each row execute function public.entries_set_created_by();
