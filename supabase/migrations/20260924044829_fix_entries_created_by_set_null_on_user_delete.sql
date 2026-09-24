-- entries.created_by references auth.users on delete set null, but the
-- write-once branch below unconditionally restored old.created_by on every
-- UPDATE -- including the internal UPDATE Postgres issues to carry out that
-- ON DELETE SET NULL action. Net effect: deleting a member's auth account
-- left their entries' created_by pointing at the now-nonexistent id
-- forever, instead of clearing it, silently defeating the FK's own
-- referential action and permanently locking those rows once any policy
-- ever reads created_by. auth.uid() is null during that internal action (it
-- isn't a member's own authenticated write, same as a dashboard or
-- service-role write), so gate the write-once behaviour on that instead of
-- applying it to every UPDATE regardless of actor.
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
  elsif auth.uid() is not null then
    -- Write-once, but only against a member's own authenticated write.
    -- Leaves a non-member write (dashboard, service role, or the FK's own
    -- ON DELETE SET NULL action) alone, so SET NULL actually takes effect.
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
