create table public.races (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  date date not null,
  location text not null default 'Location TBC',
  url text,
  events text[] not null default '{}',
  club_focus boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  race_id uuid not null references public.races (id) on delete cascade,
  name text not null,
  event text not null,
  level text not null default 'considering',
  created_at timestamptz not null default now(),
  unique (race_id, name)
);

alter table public.races enable row level security;
alter table public.entries enable row level security;

-- This is a public, no-login club tool (members identify themselves by typing
-- their name), matching the previous "Anyone with the link" Google Apps Script
-- deployment. Policies intentionally allow anonymous read/write.
create policy "Public can read races" on public.races for select using (true);
create policy "Public can add races" on public.races for insert with check (true);
create policy "Public can update races" on public.races for update using (true) with check (true);

create policy "Public can read entries" on public.entries for select using (true);
create policy "Public can add entries" on public.entries for insert with check (true);
create policy "Public can update entries" on public.entries for update using (true) with check (true);
create policy "Public can remove entries" on public.entries for delete using (true);
