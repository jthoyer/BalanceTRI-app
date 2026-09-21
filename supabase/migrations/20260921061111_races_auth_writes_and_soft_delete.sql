-- ---------------------------------------------------------------------------
-- races: read open, write authenticated — plus soft delete and attribution.
--
-- Until now `races` carried anonymous insert, update AND delete policies. Once
-- `require_auth_for_entries_writes` landed, that was incoherent: a member had
-- to sign in to commit to a race, but a stranger needed no account at all to
-- delete every race on the calendar. This migration closes that, and adds the
-- two things that make a delete survivable when it does happen — an undo and a
-- name against it.
--
-- Sign-in is still not tied to ownership. Any signed-in member can edit or
-- remove any race, exactly as any signed-in member can edit any entry. The
-- honour system continues once you are past the door; the door just exists now.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Soft delete and attribution columns.
--
-- A race carries its roster, so a delete destroys other people's commitments,
-- not just a row. `deleted_at` turns that from unrecoverable into reversible.
-- ---------------------------------------------------------------------------
alter table public.races
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_by uuid references auth.users on delete set null,
  add column if not exists updated_by uuid references auth.users on delete set null;

-- Every query below filters on this, so it earns an index.
create index if not exists races_deleted_at_idx on public.races (deleted_at);

-- ---------------------------------------------------------------------------
-- 2. Attribution trigger.
--
-- auth.uid() is null for the service role and for SQL run from the dashboard,
-- so a hand-edit records null rather than misattributing itself to a member.
-- ---------------------------------------------------------------------------
create or replace function public.races_set_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    -- created_by is write-once: a later edit must not rewrite who added it.
    new.created_by := old.created_by;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists races_audit_biu on public.races;
create trigger races_audit_biu
  before insert or update on public.races
  for each row execute function public.races_set_audit();

-- ---------------------------------------------------------------------------
-- 3. Slug de-duplication must ignore soft-deleted races.
--
-- Otherwise a race removed and re-added next season silently becomes
-- "berlin-marathon-2026-2" — the deleted row still occupies the name. The
-- unique index below is narrowed to match, so the slug is genuinely freed.
--
-- Only the de-duplication SELECT changes; the rest is as
-- `fix_balance_bolt_slug_double_prefix` left it.
-- ---------------------------------------------------------------------------
create or replace function public.races_assign_slug()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  base text;
  candidate text;
  n int := 1;
  explicit boolean;
begin
  explicit := new.slug is not null and new.slug <> '';

  if explicit then
    base := public.slugify(new.slug);
  elsif new.event_type = 'Balance Bolt' then
    base := public.slugify('balance-bolt-' || coalesce(new.name, ''));
  else
    base := public.slugify(new.name);
  end if;

  base := coalesce(base, 'race');

  if not explicit and new.date is not null then
    base := base || '-' || to_char(new.date, 'YYYY');
  end if;

  -- `deleted_at is null` is stated here rather than left to RLS. The select
  -- policy does hide deleted rows from the invoking role, which would give the
  -- same answer today, but a slug collision is a loud failure at write time and
  -- this is too subtle a thing to leave resting on a policy elsewhere.
  candidate := base;
  while exists (
    select 1 from public.races r
    where r.slug = candidate
      and r.deleted_at is null
      and r.id is distinct from new.id
  ) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;

  new.slug := candidate;
  return new;
end;
$$;

-- Partial, so a soft-deleted race releases its slug for re-use.
drop index if exists public.races_slug_key;
create unique index if not exists races_slug_live_key
  on public.races (slug) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 4. Policies: read open, write authenticated.
--
-- The two select policies are deliberate, and the split is not cosmetic.
--
-- A single `for select using (deleted_at is null)` looks right and makes the
-- soft delete impossible. On UPDATE, Postgres checks the *new* row against the
-- table's SELECT policies as well as the UPDATE policy's WITH CHECK — so the
-- statement that sets `deleted_at` produces a row the updater may no longer
-- see, and the write is rejected with "new row violates row-level security
-- policy". Verified against PostgreSQL 16, not reasoned about.
--
-- So: anonymous visitors see live races only, and signed-in members can see
-- every row. Members are the ones who can remove a race, and they are the ones
-- who would restore one. `app.js` filters `deleted_at` on read, because a
-- removed race should not reappear on the calendar just because you signed in.
--
-- update carries `using (deleted_at is null)` (you may only change a live race)
-- and `with check (true)` (the change itself may set deleted_at). Together
-- those make the soft delete work while blocking a resurrection from the
-- client: a deleted row cannot be targeted by an update at all.
--
-- No delete policy is created. Removing a race is an update now.
-- ---------------------------------------------------------------------------
drop policy if exists "Public can read races" on public.races;
drop policy if exists "Public can add races" on public.races;
drop policy if exists "Public can update races" on public.races;
drop policy if exists "Public can remove races" on public.races;

create policy "Anyone can read live races" on public.races
  for select to anon using (deleted_at is null);

create policy "Members can read every race" on public.races
  for select to authenticated using (true);

create policy "Members can add races" on public.races
  for insert to authenticated with check (true);

create policy "Members can update races" on public.races
  for update to authenticated
  using (deleted_at is null) with check (true);
