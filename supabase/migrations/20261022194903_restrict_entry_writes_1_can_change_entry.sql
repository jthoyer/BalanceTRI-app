-- Owner-only commitments, part 1: the check the entries policies call.
-- Owner (created_by = auth.uid()) or an admin with a two-factor session; both
-- need the allow-list. Security definer so it can call private.is_admin(),
-- which members cannot execute. No data is read or written by this file.
create function private.can_change_entry(p_created_by uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.is_allow_listed()
     and (
           (p_created_by is not null and p_created_by = auth.uid())
           or private.is_admin()
         );
$$;

revoke execute on function private.can_change_entry(uuid) from public, anon, authenticated;
grant execute on function private.can_change_entry(uuid) to authenticated;
