-- ---------------------------------------------------------------------------
-- Privacy: visitors see first names only. Full names are for approved members.
--
-- NOT APPLIED. Apply it only after the owner's go, then rename this file to
-- the version Supabase recorded (list_migrations), as CLAUDE.md says.
--
-- Until now "Public can read entries" let anyone with the public anon key read
-- every full name over the API, so hiding names in the page alone would have
-- protected nothing. Since cutover anyone can also make an account in seconds,
-- so "signed in" is no bar either: full names go to approved members only
-- (private.is_allow_listed(), the same gate the write policies use).
--
-- Everyone else (visitors, and accounts that are pending, rejected or revoked)
-- reads public_entries(): the same rows for live races, with the name cut to
-- its first word ("Sam Lee" becomes "Sam"). The full name never leaves the
-- database for them.
-- ---------------------------------------------------------------------------

alter policy "Public can read entries" on public.entries
  to authenticated
  using (private.is_allow_listed());
alter policy "Public can read entries" on public.entries
  rename to "Members can read entries";

create function public.public_entries()
returns table (race_id uuid, name text, events text[], level text)
language sql
security definer
stable
set search_path = ''
as $$
  select e.race_id, split_part(btrim(e.name), ' ', 1), e.events, e.level
    from public.entries e
    join public.races r on r.id = e.race_id
   where r.deleted_at is null
   order by e.created_at, e.id;
$$;

revoke all on function public.public_entries() from public;
grant execute on function public.public_entries() to anon, authenticated;
