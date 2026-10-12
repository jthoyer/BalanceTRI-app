-- ---------------------------------------------------------------------------
-- Access-request alerts (step B4 of the gated member accounts plan): the
-- database side of the notify-access-request Edge Function.
--
-- Applied to the live project on 12 October 2026, after B3, and named after
-- the version Supabase recorded. The Edge Function is deployed too.
--
-- Before it sends anything, the owner must also (none of this belongs in a
-- migration):
--   1. Create the Vault secret, in the SQL editor:
--        select vault.create_secret('<long random string>', 'notify_access_request_secret');
--   2. Set the same string as the Edge Function secret NOTIFY_SHARED_SECRET.
--   3. Set TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID.
--   Until step 1 exists, the trigger stays silent.
--
-- How it fits together:
--   * An AFTER INSERT trigger on private.access_requests posts the user_id,
--     and nothing else, to the Edge Function through pg_net. The shared secret
--     travels in a header and is read from Vault at the moment of the call.
--   * The function calls notifier_claim(). The database decides whether this
--     request may be announced: it must be pending, never announced, and the
--     Sydney-day count of announced requests must be under 20. The claim
--     stamps notified_at, under a lock, so two requests can't both take the
--     last slot.
--   * If Telegram refuses the message, the function calls notifier_release()
--     to clear notified_at again. The console then shows "notification not
--     sent" for that request.
--   * The trigger can never block or undo a sign-up. If pg_net or Vault
--     misbehaves, the request row still lands, and the console's pending
--     count is the backstop.
-- ---------------------------------------------------------------------------

create extension if not exists pg_net;

create function private.notify_access_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  shared text;
begin
  select decrypted_secret into shared
    from vault.decrypted_secrets
    where name = 'notify_access_request_secret';

  -- Not set up yet: stay quiet. The request is saved either way.
  if shared is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://shkfwuogrldbqldpipxd.supabase.co/functions/v1/notify-access-request',
    body := jsonb_build_object('user_id', new.user_id),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-notify-secret', shared
    )
  );
  return new;
exception when others then
  -- The queue never depends on Telegram. Log, and let the insert stand.
  raise warning 'notify_access_request failed: %', sqlerrm;
  return new;
end;
$$;

revoke all on function private.notify_access_request() from public, anon, authenticated;

-- Pending rows only: the revoked rows B3 makes for existing members who lose
-- their listing are not requests and need no message.
create trigger access_requests_notify
  after insert on private.access_requests
  for each row
  when (new.status = 'pending')
  execute function private.notify_access_request();

-- Claim the right to announce one request. Called by the Edge Function with
-- the service role. Returns {"send": false, ...} or
-- {"send": true, "display_name": ..., "last_of_day": ...}.
create function public.notifier_claim(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  req private.access_requests;
  day_start timestamptz;
  sent_today integer;
  daily_cap constant integer := 20;
begin
  -- One claim at a time, so the cap count below can't race.
  perform pg_advisory_xact_lock(hashtext('notify_access_request'));

  select * into req from private.access_requests where user_id = p_user_id;
  if not found or req.status <> 'pending' or req.notified_at is not null then
    return jsonb_build_object('send', false, 'reason', 'not eligible');
  end if;

  -- Midnight to midnight in Sydney, whatever the server's own time zone is.
  day_start := date_trunc('day', now() at time zone 'Australia/Sydney')
               at time zone 'Australia/Sydney';
  select count(*) into sent_today
    from private.access_requests
    where notified_at >= day_start;

  if sent_today >= daily_cap then
    return jsonb_build_object('send', false, 'reason', 'daily cap');
  end if;

  update private.access_requests set notified_at = now() where user_id = p_user_id;

  return jsonb_build_object(
    'send', true,
    'display_name', req.display_name,
    'last_of_day', sent_today + 1 >= daily_cap
  );
end;
$$;

-- Give a claim back after a failed send.
create function public.notifier_release(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.access_requests set notified_at = null where user_id = p_user_id;
$$;

-- Service role only. The browser's roles must not be able to call these over
-- /rest/v1/rpc/.
revoke all on function public.notifier_claim(uuid) from public, anon, authenticated;
revoke all on function public.notifier_release(uuid) from public, anon, authenticated;
grant execute on function public.notifier_claim(uuid) to service_role;
grant execute on function public.notifier_release(uuid) to service_role;
