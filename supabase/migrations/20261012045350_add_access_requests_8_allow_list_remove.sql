-- Gated member accounts, step B3, part 8 of 8: removing a listing revokes access. create or
-- replace keeps the existing grants.
-- The design notes are at the top of part 1 (20261012042054).

-- The mirror of the above: removing a listing revokes the account's access.
create or replace function public.admin_allow_list_remove(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
  removed boolean;
  v_uid uuid;
begin
  perform private.require_admin();
  select id into v_uid from auth.users where lower(trim(email)) = lower(trim(p_email));
  if v_uid is not null then
    perform private.lock_account(v_uid);
  end if;
  h := private.email_hash(p_email);
  delete from private.allowed_emails where email_hash = h;
  removed := found;
  if v_uid is not null then
    update private.access_requests
       set status = 'revoked', decided_by = auth.uid(), decided_at = now()
     where user_id = v_uid and status = 'approved';
    -- A member who joined before requests existed has no row: give them a
    -- revoked one, so they see "access removed" rather than the join form.
    if removed and not found then
      insert into private.access_requests (user_id, display_name, status, decided_by, decided_at, reason)
      values (v_uid, private.fallback_name(v_uid), 'revoked', auth.uid(), now(), 'Removed from the allow-list')
      on conflict (user_id) do nothing;
    end if;
  end if;
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'allow_list_remove', jsonb_build_object('email_hash', h, 'removed', removed, 'user_id', v_uid));
  return jsonb_build_object('removed', removed);
end;
$$;
