-- Balance Bolt races are stored with names like "BALANCE BOLT #1", not a bare
-- number as the add-race form's placeholder suggests, so races_assign_slug()
-- was prepending "balance-bolt-" onto a name that already said "BALANCE BOLT",
-- producing slugs like balance-bolt-balance-bolt-1-2026. Strip any existing
-- "balance bolt" lead-in from the name before prefixing so it's added exactly
-- once, whether the stored name already carries the label or not.

create or replace function public.races_assign_slug()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  base      text;
  candidate text;
  n         integer := 1;
  explicit  boolean := false;
begin
  if tg_op = 'UPDATE' then
    if new.slug is not null and new.slug <> '' and new.slug is distinct from old.slug then
      explicit := true;
    elsif new.slug is not null and new.slug <> ''
      and new.name       is not distinct from old.name
      and new.date       is not distinct from old.date
      and new.event_type is not distinct from old.event_type
    then
      return new;
    end if;
  end if;

  if explicit then
    base := public.slugify(new.slug);
  elsif new.event_type = 'Balance Bolt' then
    -- Strip a leading "balance bolt" (however it's cased/spaced) so a name
    -- that already carries the label doesn't get it twice.
    base := public.slugify(
      'balance-bolt-' || regexp_replace(coalesce(new.name, ''), '^\s*balance\s*bolt\s*', '', 'i')
    );
  else
    base := public.slugify(new.name);
  end if;

  base := coalesce(base, 'race');

  if not explicit and new.date is not null then
    base := base || '-' || to_char(new.date, 'YYYY');
  end if;

  candidate := base;
  while exists (
    select 1 from public.races r
    where r.slug = candidate
      and r.id is distinct from new.id
  ) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;

  new.slug := candidate;
  return new;
end;
$$;

-- Regenerate slugs for the rows affected by the old, buggy logic.
do $$
declare
  r record;
begin
  for r in select id from public.races where event_type = 'Balance Bolt' order by date, created_at, id loop
    update public.races set slug = null where id = r.id;
  end loop;
end;
$$;
