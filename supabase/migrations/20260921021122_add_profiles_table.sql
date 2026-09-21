create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  justgo_status text not null default 'unverified',
  justgo_member_number text,
  justgo_checked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read their own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "Users can update their own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Seeds a profile row (display name defaulted from the email's local part,
-- editable afterwards) the moment someone completes magic-link sign-in for
-- the first time, so the app never has to create one from the client.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
