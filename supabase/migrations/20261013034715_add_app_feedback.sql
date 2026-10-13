-- ---------------------------------------------------------------------------
-- App feedback: the database side of the send-feedback Edge Function.
--
-- Applied to project shkfwuogrldbqldpipxd on 2026-10-13 (version 20261013034715).
--
-- What it holds:
--   * private.app_feedback keeps every message the function accepts, before
--     it tries to email it. If the mail provider refuses, the text is still
--     here (sent_at stays null), so nothing a member wrote is lost.
--   * public.feedback_claim() is the rate limit and the insert in one step,
--     under a lock, so two requests can't both take the last slot:
--       - 3 per sender in 10 minutes, 10 per sender in a day,
--       - 50 for the whole app in a day, which also caps the mail bill.
--     "Sender" is a keyed hash of the caller's IP address, made by the
--     function. The address itself is never stored. A signed-in member is
--     also counted by account, so changing networks doesn't reset them.
--   * public.feedback_mark_sent() stamps sent_at once the email has gone.
--
-- Both functions are callable by the service role only. Nothing here is
-- reachable from the browser: the private schema is not exposed, the table
-- has RLS on and no policies, and the anon and authenticated roles have no
-- grant on either function.
--
-- The recipient address is NOT in this file, or anywhere in the database.
-- It lives only in the Edge Function secret FEEDBACK_TO_EMAIL.
-- ---------------------------------------------------------------------------

create table private.app_feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  source_hash text not null check (char_length(source_hash) between 16 and 128),
  user_id uuid references auth.users (id) on delete set null,
  message text not null check (char_length(message) between 5 and 2000),
  contact text check (contact is null or char_length(contact) <= 120),
  page text check (page is null or char_length(page) <= 200),
  sent_at timestamptz
);

alter table private.app_feedback enable row level security;
revoke all on table private.app_feedback from public, anon, authenticated;

create index app_feedback_source_recent on private.app_feedback (source_hash, created_at);
create index app_feedback_user_recent on private.app_feedback (user_id, created_at)
  where user_id is not null;
create index app_feedback_recent on private.app_feedback (created_at);

-- Rate-limit, then store. Returns {"ok": true, "id": <id>} or
-- {"ok": false, "reason": "sender" | "daily"}.
create function public.feedback_claim(
  p_source_hash text,
  p_user_id uuid,
  p_message text,
  p_contact text,
  p_page text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  per_ten_minutes constant integer := 3;
  per_day constant integer := 10;
  app_per_day constant integer := 50;
  recent integer;
  today integer;
  everyone integer;
  new_id bigint;
begin
  -- One claim at a time, so the counts below can't race.
  perform pg_advisory_xact_lock(hashtext('app_feedback_claim'));

  select count(*) filter (where created_at > now() - interval '10 minutes'),
         count(*)
    into recent, today
    from private.app_feedback
    where created_at > now() - interval '1 day'
      and (source_hash = p_source_hash
           or (p_user_id is not null and user_id = p_user_id));

  if recent >= per_ten_minutes or today >= per_day then
    return jsonb_build_object('ok', false, 'reason', 'sender');
  end if;

  select count(*) into everyone
    from private.app_feedback
    where created_at > now() - interval '1 day';
  if everyone >= app_per_day then
    return jsonb_build_object('ok', false, 'reason', 'daily');
  end if;

  insert into private.app_feedback (source_hash, user_id, message, contact, page)
    values (p_source_hash, p_user_id, p_message, nullif(p_contact, ''), nullif(p_page, ''))
    returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

create function public.feedback_mark_sent(p_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.app_feedback set sent_at = now() where id = p_id and sent_at is null;
$$;

-- Service role only. The browser's roles must not be able to call these over
-- /rest/v1/rpc/.
revoke all on function public.feedback_claim(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.feedback_mark_sent(bigint) from public, anon, authenticated;
grant execute on function public.feedback_claim(text, uuid, text, text, text) to service_role;
grant execute on function public.feedback_mark_sent(bigint) to service_role;
