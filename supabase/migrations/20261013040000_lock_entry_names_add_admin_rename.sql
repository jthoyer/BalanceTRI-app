-- A commitment now carries the member's display name, and only an admin can
-- change it.
--
-- Before: members typed a name on every commitment and could rename any
-- entry they opened from the roster.
-- Now:    the app fills the name from the profile and shows it read-only, and
--         this migration enforces the same rule in the database.
--
-- Not applied to the live project yet. When it is, rename this file to the
-- version Supabase records (see CLAUDE.md).

-- ---------------------------------------------------------------------------
-- 1. Entry names follow the profile.
--
-- Insert: the name must be the caller's own display name. Update: the name
-- cannot change. Admins, the dashboard and the service role are exempt, which
-- keeps admin_rename_member, admin_undo and bulk fixes working.
-- ---------------------------------------------------------------------------
create function private.guard_entry_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  -- No auth.uid() means the dashboard or the service role.
  if auth.uid() is null or private.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    select p.display_name into v_name from public.profiles p where p.id = auth.uid();
    if new.name is distinct from v_name then
      raise exception 'Commitments use your display name. Ask a club admin if it needs changing.';
    end if;
  elsif new.name is distinct from old.name then
    raise exception 'Only a club admin can change a name.';
  end if;
  return new;
end;
$$;

revoke execute on function private.guard_entry_name() from public, anon, authenticated;

create trigger entries_name_guard_biu
  before insert or update of name on public.entries
  for each row execute function private.guard_entry_name();

-- ---------------------------------------------------------------------------
-- 2. admin_rename_member: one rename, everywhere.
--
-- Changes the profile's display name and the name on every entry that member
-- created. The profile trigger still applies the sign-up rules (2 to 40
-- characters, letters only, unique among members) and writes the history row.
-- Entries typed under another name are renamed too: they were the member's.
-- ---------------------------------------------------------------------------
create function public.admin_rename_member(p_user_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_new text;
  v_entries int;
begin
  perform private.require_admin();
  perform private.lock_account(p_user_id);
  select display_name into v_old from public.profiles where id = p_user_id;
  if not found then
    raise exception 'That account has no profile.';
  end if;
  v_new := private.clean_display_name(p_name);
  if v_new is not distinct from v_old then
    return jsonb_build_object('renamed', false, 'entries', 0);
  end if;

  update public.profiles set display_name = v_new where id = p_user_id;
  update public.entries set name = v_new
   where created_by = p_user_id and name is distinct from v_new;
  get diagnostics v_entries = row_count;

  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'rename_member', jsonb_build_object(
    'user_id', p_user_id, 'old_name', v_old, 'new_name', v_new, 'entries', v_entries
  ));
  return jsonb_build_object('renamed', true, 'entries', v_entries);
exception when unique_violation then
  raise exception 'That name is already on a race this member entered. Choose a different name.';
end;
$$;

revoke execute on function public.admin_rename_member(uuid, text) from public, anon;
grant execute on function public.admin_rename_member(uuid, text) to authenticated;
