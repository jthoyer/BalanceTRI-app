// The logic behind the notify-access-request Edge Function, kept free of Deno
// globals so the tests can run it under plain Node with a fake fetch.
//
// A Database Webhook on INSERT into public.access_requests calls this. It sends
// the club admin one Telegram message: the person's display name and a link to
// the admin console. Nothing else crosses the wire.
//
// Why it is built the way it is (the plan's "notifier as an open relay" test):
//   - The chat ID comes from a secret, never from the request. A caller cannot
//     aim the bot at anyone else.
//   - The request must carry the shared secret. Anyone who finds the URL still
//     cannot trigger a message.
//   - The message is plain text with fixed wording, so a display name can't
//     inject markup or links.
//   - A daily cap bounds the damage if the table is ever flooded.

export const ACCESS_REQUEST_TABLE = 'access_requests';
export const MAX_NAME_LENGTH = 60;
export const DEFAULT_DAILY_CAP = 20;
const MAX_BODY_BYTES = 10_000;
const DEFAULT_CONSOLE_URL = 'https://jthoyer.github.io/BalanceTRI-app/admin.html';

export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => Date;
}

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Compare digests, not the raw strings, so the check takes the same time
// whatever the caller sends.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Strip control and direction-override characters, squash whitespace, cap the
// length. The name is user-typed, so it is treated as hostile.
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
}

// How many requests arrived in the last 24 hours, this one included. Returns
// null if it can't be worked out; the caller then sends rather than going quiet.
async function requestsLastDay(deps: Deps): Promise<number | null> {
  const url = deps.env('SUPABASE_URL');
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  const since = new Date(deps.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await deps.fetch(
      `${url}/rest/v1/${ACCESS_REQUEST_TABLE}?select=id&created_at=gte.${encodeURIComponent(since)}`,
      {
        method: 'HEAD',
        headers: { apikey: key, authorization: `Bearer ${key}`, prefer: 'count=exact' },
      },
    );
    if (!res.ok) return null;
    const total = Number((res.headers.get('content-range') ?? '').split('/')[1]);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

async function sendTelegram(deps: Deps, token: string, chatId: string, text: string) {
  return deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  const expected = deps.env('NOTIFY_WEBHOOK_SECRET');
  const token = deps.env('TELEGRAM_BOT_TOKEN');
  const chatId = deps.env('TELEGRAM_CHAT_ID');
  // Fail closed: with any secret missing, do nothing rather than guess.
  if (!expected || !token || !chatId) {
    console.error('notify-access-request: a required secret is not set');
    return json(500, { error: 'not configured' });
  }

  const given = req.headers.get('x-webhook-secret') ?? '';
  if (!(await sameSecret(given, expected))) return json(401, { error: 'unauthorised' });

  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return json(413, { error: 'payload too large' });
  }
  let payload: { type?: unknown; schema?: unknown; table?: unknown; record?: unknown };
  try {
    payload = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid json' });
  }

  // A webhook for some other table or event is not an error, just not ours.
  if (
    payload.type !== 'INSERT' ||
    payload.schema !== 'public' ||
    payload.table !== ACCESS_REQUEST_TABLE
  ) {
    return json(200, { ignored: true });
  }

  const record = (payload.record ?? {}) as { display_name?: unknown };
  const name = cleanName(record.display_name) || 'Someone';
  const consoleUrl = deps.env('ADMIN_CONSOLE_URL') || DEFAULT_CONSOLE_URL;

  const cap = Number(deps.env('DAILY_ALERT_CAP')) || DEFAULT_DAILY_CAP;
  const count = await requestsLastDay(deps);
  let message = `New access request: ${name}\nReview it in the admin console: ${consoleUrl}`;
  if (count !== null && count > cap) {
    if (count > cap + 1) return json(200, { skipped: 'daily cap reached' });
    // The first request over the cap gets one notice, then silence.
    message = `Access requests have passed ${cap} in 24 hours. Alerts are paused until the count drops. Check the admin console: ${consoleUrl}`;
  }

  try {
    const res = await sendTelegram(deps, token, chatId, message);
    if (!res.ok) {
      // Log the status only. The URL holds the bot token.
      console.error(`notify-access-request: Telegram answered ${res.status}`);
      return json(502, { error: 'telegram rejected the message' });
    }
  } catch {
    console.error('notify-access-request: could not reach Telegram');
    return json(502, { error: 'telegram unreachable' });
  }
  return json(200, { sent: true });
}
