-- ---------------------------------------------------------------------------
-- Privacy: visitors see the race card only, with no names.
--
-- Before: visitors, and accounts that are pending, rejected or revoked, read
--         public_entries(): every commitment with its first name. A first
--         name can still identify someone, and some older display names were
--         made from the start of an email address ("sam.lee87"), so the
--         "first word" was the whole thing.
-- Now:    they read public_race_counts(): for each live race, how many
--         members have a commitment and how many are locked in. Rows with
--         level 'not' (old imported data, never shown on the roster) are left
--         out, the same as on the page. No names, no events, no levels per
--         person. Names stay with approved members (the "Members can read
--         entries" policy, private.is_allow_listed()).
--
-- Apply this AFTER the matching app.js is live on GitHub Pages. The new page
-- falls back to public_entries() while this migration is missing, and keeps
-- only the counts. The old page needs public_entries(), and would show
-- empty counts once it is dropped.
--
-- Not yet applied to the live project. After applying, rename this file to
-- the version Supabase records (see CLAUDE.md).
-- ---------------------------------------------------------------------------

create function public.public_race_counts()
returns table (race_id uuid, committed integer, locked integer)
language sql
security definer
stable
set search_path = ''
as $$
  select e.race_id,
         (count(*) filter (where e.level <> 'not'))::integer,
         (count(*) filter (where e.level = 'locked'))::integer
    from public.entries e
    join public.races r on r.id = e.race_id
   where r.deleted_at is null
   group by e.race_id;
$$;

revoke all on function public.public_race_counts() from public;
grant execute on function public.public_race_counts() to anon, authenticated;

drop function public.public_entries();
