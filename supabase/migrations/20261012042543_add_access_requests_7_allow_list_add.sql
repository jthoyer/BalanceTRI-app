-- Gated member accounts, step B3, part 7 of 8: G2, the Allow-list box. create or replace
-- keeps the existing grants.
-- The design notes are at the top of part 1 (20261012042054).

-- ---------------------------------------------------------------------------
-- G2: approving an address with no account created a pre-approval that anyone
-- could claim by signing up with it. Refuse it. Where the address does have a
-- request that is not approved, listing it settles that request, so the
-- Requests panel and the allow-list never disagree.
-- ---------------------------------------------------------------------------
create or replace function public.admin_allow_list_add(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
  added boolean;
  v_uid uuid;
  v_confirmed boolean;
  req private.access_requests;
begin
  perform private.require_admin();
  if coalesce(trim(p_email), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That doesn''t look like an email address.';
  end if;
  select id, email_confirmed_at is not null into v_uid, v_confirmed
    from auth.users where lower(trim(email)) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No account uses that address.';
  end if;
  -- An unconfirmed account proves nothing: anyone can make one on any address.
  if not v_confirmed then
    raise exception 'That account hasn''t confirmed its email address, so it can''t be approved.';
  end if;
  -- Lock, then check the address still belongs to that account: an email
  -- change that finished while this waited must not leave a hash behind.
  perform private.lock_account(v_uid);
  if not exists (
    select 1 from auth.users
     where id = v_uid and lower(trim(email)) = lower(trim(p_email)) and email_confirmed_at is not null
  ) then
    raise exception 'That account''s email address just changed. Try again.';
  end if;

  select * into req from private.access_requests where user_id = v_uid for update;
  if req.status is not null and req.status <> 'approved'
     and private.display_name_taken(req.display_name, v_uid) then
    raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
  end if;
  -- No request row (signed up but never asked, or listed before requests
  -- existed): listing them makes their profile name an approved name.
  -- Compare the name as it would be cleaned: old profile names were never
  -- normalised, and "Sam  Smith" must clash with "Sam Smith".
  if req.user_id is null and private.display_name_taken(
       (select normalize(trim(regexp_replace(coalesce(p.display_name, ''), '\s+', ' ', 'g')), NFC)
          from public.profiles p where p.id = v_uid), v_uid) then
    raise exception 'Another member uses this account''s name. Rename the account in the dashboard, then try again.';
  end if;

  h := private.email_hash(p_email);
  insert into private.allowed_emails (email_hash) values (h) on conflict do nothing;
  added := found;
  update private.access_requests
     set status = 'approved', decided_by = auth.uid(), decided_at = now()
   where user_id = v_uid and status <> 'approved';
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'allow_list_add', jsonb_build_object(
    'email_hash', h, 'added', added, 'user_id', v_uid, 'request_from', req.status
  ));
  return jsonb_build_object('added', added);
exception when unique_violation then
  raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
end;
$$;
