-- Gated member accounts, step B3, part 6 of 8: the Requests panel's functions.
-- The design notes are at the top of part 1 (20261012042054).

-- ---------------------------------------------------------------------------
-- Admin functions. Each starts with private.require_admin(), which also needs
-- a two-factor (aal2) session. Every decision is logged in private.admin_actions.
-- ---------------------------------------------------------------------------

-- The Requests panel. Emails are read from auth.users here, so the app never
-- reads that table. 'listed' says whether the address is on the allow-list now;
-- for a revoked or rejected request it should be false.
create function public.admin_requests(p_status text default null)
returns table (
  user_id uuid,
  email text,
  display_name text,
  note text,
  status text,
  requested_at timestamptz,
  decided_at timestamptz,
  decided_by_label text,
  reason text,
  notified_at timestamptz,
  listed boolean,
  reset_pending boolean,
  reset_expires_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'revoked') then
    raise exception 'Unknown status.';
  end if;
  return query
    select r.user_id, u.email::text, r.display_name, r.note, r.status,
           r.requested_at, r.decided_at, private.user_label(r.decided_by), r.reason,
           r.notified_at,
           exists (select 1 from private.allowed_emails a where a.email_hash = private.email_hash(u.email)),
           pr.user_id is not null,
           pr.expires_at
      from private.access_requests r
      left join auth.users u on u.id = r.user_id
      left join private.password_resets pr on pr.user_id = r.user_id and pr.cleared_at is null
     where p_status is null or r.status = p_status
     order by (r.status = 'pending') desc, r.requested_at desc;
end;
$$;

-- Approve, reject, revoke or re-approve, moving the allow-list and the request
-- together. Writes stop at once on a revoke or reject, because the RLS policies
-- check the allow-list on every write. Signing the person out is the app's job.
--   approve    pending            -> approved
--   reject     pending            -> rejected
--   revoke     approved           -> revoked
--   reapprove  revoked, rejected  -> approved
create function public.admin_decide_request(p_user_id uuid, p_decision text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  req private.access_requests;
  v_email text;
  v_hash text;
  v_new text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  perform private.require_admin();
  if p_user_id = auth.uid() then
    raise exception 'You can''t change your own access.';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'Keep the reason to 200 characters or fewer.';
  end if;

  -- Taken before the email is read, so an email change or deletion either
  -- finishes first (and is seen below) or waits for this decision to commit.
  perform private.lock_account(p_user_id);
  select * into req from private.access_requests where user_id = p_user_id for update;
  if not found then
    raise exception 'No request from that account.';
  end if;
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then
    raise exception 'That account no longer exists.';
  end if;
  -- As in admin_allow_list_add: an unconfirmed account proves nothing.
  if p_decision in ('approve', 'reapprove')
     and not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
    raise exception 'That account hasn''t confirmed its email address, so it can''t be approved.';
  end if;

  v_new := case
    when p_decision = 'approve'   and req.status = 'pending'               then 'approved'
    when p_decision = 'reject'    and req.status = 'pending'               then 'rejected'
    when p_decision = 'revoke'    and req.status = 'approved'              then 'revoked'
    when p_decision = 'reapprove' and req.status in ('revoked', 'rejected') then 'approved'
  end;
  if v_new is null then
    if p_decision not in ('approve', 'reject', 'revoke', 'reapprove') then
      raise exception 'Unknown decision.';
    end if;
    raise exception 'That request is %, so you can''t % it.', req.status, p_decision;
  end if;

  -- The unique index covers requests only. A member who joined before requests
  -- existed may have taken this name since it was rejected or revoked.
  if v_new = 'approved' and private.display_name_taken(req.display_name, p_user_id) then
    raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
  end if;

  v_hash := private.email_hash(v_email);
  if v_new = 'approved' then
    insert into private.allowed_emails (email_hash) values (v_hash) on conflict do nothing;
  else
    delete from private.allowed_emails where email_hash = v_hash;
  end if;

  update private.access_requests
     set status = v_new, decided_by = auth.uid(), decided_at = now(), reason = v_reason
   where user_id = p_user_id;

  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'access_' || p_decision, jsonb_build_object(
    'user_id', p_user_id, 'from', req.status, 'to', v_new, 'reason', v_reason
  ));

  return jsonb_build_object('status', v_new);
exception when unique_violation then
  raise exception 'Another member now uses that name. Rename this account in the dashboard, then try again.';
end;
$$;

-- The badge in the console header and on the calendar's Admin link.
create function public.admin_pending_count()
returns integer
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  perform private.require_admin();
  return (select count(*)::integer from private.access_requests where status = 'pending');
end;
$$;

-- Signed-in users only; each function refuses non-admins inside.
revoke execute on function public.admin_requests(text) from public, anon;
revoke execute on function public.admin_decide_request(uuid, text, text) from public, anon;
revoke execute on function public.admin_pending_count() from public, anon;
grant execute on function public.admin_requests(text) to authenticated;
grant execute on function public.admin_decide_request(uuid, text, text) to authenticated;
grant execute on function public.admin_pending_count() to authenticated;
