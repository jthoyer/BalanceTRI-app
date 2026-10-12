-- Gated member accounts, step B3, part 3 of 8: rename rules and history on profiles (F7);
-- members may update their display name only (F6).
-- The design notes are at the top of part 1 (20261012042054).

-- F7: profiles.display_name was freely editable by its owner, so a rename could
-- impersonate another member. Renames now follow the sign-up rules.
create function private.check_profile_rename()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.display_name := private.clean_display_name(new.display_name);
  if new.display_name is not distinct from old.display_name then
    return new;
  end if;
  if private.display_name_taken(new.display_name, new.id) then
    raise exception 'Someone at the club already uses that name. Add a surname or initial.';
  end if;
  -- request_access() replaces the seeded name (the email's local part) with
  -- the chosen one. That is joining, not renaming: no cap, and no history row
  -- (see the history trigger's WHEN clause).
  if current_setting('app.naming', true) = 'request_access' then
    return new;
  end if;
  -- Each rename writes a history row, so cap them. Without a cap any signed-up
  -- account could fill the database by renaming itself in a loop. The
  -- dashboard and the service role (no auth.uid()) are not capped.
  if auth.uid() is not null and (
    select count(*) from private.change_history h
     where h.table_name = 'profiles' and h.row_id = new.id
       and h.changed_at > now() - interval '1 day'
  ) >= 5 then
    raise exception 'You can change your name 5 times a day. Try again tomorrow.';
  end if;
  -- Keep the request on the same name as the profile, so the unique index on
  -- active requests guards renames too, and the console shows the real name.
  begin
    update private.access_requests set display_name = new.display_name where user_id = new.id;
  exception when unique_violation then
    raise exception 'Someone at the club already uses that name. Add a surname or initial.';
  end;
  return new;
end;
$$;

create trigger profiles_rename_biu
  before update of display_name on public.profiles
  for each row
  when (new.display_name is distinct from old.display_name)
  execute function private.check_profile_rename();

-- F7: keep who renamed whom, the way entries and races are kept. Renames
-- only: sign-ups and deletions are not profile edits, and logging them would
-- crowd the console's activity feed.
create trigger profiles_history_au
  after update of display_name on public.profiles
  for each row
  when (old.display_name is distinct from new.display_name
        and current_setting('app.naming', true) is distinct from 'request_access')
  execute function private.record_change();

-- F6: the update policy covers every column, so a member could mark their own
-- profiles.justgo_status as verified. Members may change their display name
-- and nothing else. (Revoking only the justgo columns would do nothing while a
-- table-wide UPDATE grant stands, so replace the grant.)
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;


revoke execute on function private.check_profile_rename() from public, anon, authenticated;
