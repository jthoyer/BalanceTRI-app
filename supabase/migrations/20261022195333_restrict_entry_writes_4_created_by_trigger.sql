-- Owner-only commitments, part 4.
-- entries_set_created_by: on INSERT keep the given created_by when the caller
-- is not an API role AND app.entries_link_ok is on (only admin_undo's re-insert
-- of a removed entry sets it). Everything else is as in 20261016000000: an API
-- insert is stamped with auth.uid(), and a member cannot choose the owner.
create or replace function public.entries_set_created_by()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if current_user not in ('authenticated', 'anon')
       and coalesce(current_setting('app.entries_link_ok', true), '') = 'on' then
      return new;
    end if;
    new.created_by := auth.uid();
  elsif auth.uid() is not null then
    if current_user not in ('authenticated', 'anon')
       and coalesce(current_setting('app.entries_link_ok', true), '') = 'on' then
      return new;
    end if;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
