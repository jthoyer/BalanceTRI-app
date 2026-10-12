-- ---------------------------------------------------------------------------
-- Batch approval: approve several waiting requests in one go.
--
-- NOT APPLIED. Apply it only after the owner's go, and after the B3
-- migrations (admin_decide_request, part 6). It doesn't depend on B5. Then rename this file to the
-- version Supabase recorded (list_migrations), as CLAUDE.md says.
--
-- Why: at cutover, G1 removes about 159 pre-approvals, so nearly every member
-- joins and waits for the owner. One at a time, that's an evening's work.
--
-- Each request still goes through admin_decide_request(), so every rule stays
-- in one place: an admin with two-factor, a confirmed account, the name check,
-- the allow-list and the request moving together, and one admin_actions row
-- per person. A request that fails is skipped and reported; the rest still go
-- through. At most 50 at a time, so a mis-tap can't approve the whole queue.
-- ---------------------------------------------------------------------------

create function public.admin_approve_requests(p_user_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_ids uuid[];
  v_approved integer := 0;
  v_results jsonb := '[]'::jsonb;
begin
  perform private.require_admin();
  select array_agg(distinct x) into v_ids from unnest(p_user_ids) x where x is not null;
  if v_ids is null then
    raise exception 'Choose at least one request.';
  end if;
  if cardinality(v_ids) > 50 then
    raise exception 'Approve at most 50 at a time.';
  end if;

  foreach v_id in array v_ids loop
    -- Each one in its own subtransaction: a refusal undoes only that person.
    begin
      perform public.admin_decide_request(v_id, 'approve', null);
      v_approved := v_approved + 1;
      v_results := v_results || jsonb_build_object('user_id', v_id, 'ok', true);
    exception when others then
      v_results := v_results || jsonb_build_object('user_id', v_id, 'ok', false, 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('approved', v_approved, 'results', v_results);
end;
$$;

-- Signed-in users only; the function refuses non-admins inside.
revoke execute on function public.admin_approve_requests(uuid[]) from public, anon;
grant execute on function public.admin_approve_requests(uuid[]) to authenticated;
