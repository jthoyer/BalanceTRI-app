// The logic behind the notify-access-request Edge Function, kept free of Deno
// globals so the tests can run it under plain Node with a fake fetch.
//
// Flow (spec 6.4): an AFTER INSERT trigger on private.access_requests calls
// this through pg_net, sending only the user_id and a shared secret header.
// The function asks the database to claim that request (the database checks it
// is still pending, not yet announced, and under the daily cap), builds the
// text itself, and sends one plain-text Telegram message to a fixed chat.
// If Telegram fails, it hands the claim back so the console can show
// "notification not sent".
//
// Why it is not an open relay (spec F8, test T7):
//   - No shared secret, no work. The anon key proves nothing here.
//   - The chat ID comes from a secret, never from the request.
//   - Nothing the caller sends reaches the message. The name is read from the
//     database, not the request body.

export const DAILY_CAP_NOTICE = 'Daily limit reached. Check the console for more.';
export const DEFAULT_CONSOLE_URL = 'https://jthoyer.github.io/BalanceTRI-app/admin.html#requests';
export const MAX_NAME_LENGTH = 60;
const MAX_BODY_BYTES = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
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

// The database already limits names to 2..40 characters. This is a second
// line of defence: strip control and direction-override characters, squash
// whitespace, cap the length.
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
}

interface Claim {
  send?: boolean;
  display_name?: string;
  last_of_day?: boolean;
}

// Calls a service-role-only database function. Returns null on any failure.
async function rpc(deps: Deps, name: string, args: object): Promise<unknown | null> {
  const url = deps.env('SUPABASE_URL');
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  try {
    const res = await deps.fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

async function sendTelegram(deps: Deps, token: string, chatId: string, text: string) {
  return deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Plain text, and no link preview, so Telegram never fetches the console.
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  const expected = deps.env('NOTIFY_SHARED_SECRET');
  const token = deps.env('TELEGRAM_BOT_TOKEN');
  const chatId = deps.env('TELEGRAM_ADMIN_CHAT_ID');
  // Fail closed: with any secret missing, do nothing rather than guess.
  if (!expected || !token || !chatId) {
    console.error('notify-access-request: a required secret is not set');
    return json(500, { error: 'not configured' });
  }

  const given = req.headers.get('x-notify-secret') ?? '';
  if (!(await sameSecret(given, expected))) return json(401, { error: 'unauthorised' });

  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return json(413, { error: 'payload too large' });
  }
  let userId: unknown;
  try {
    userId = JSON.parse(text)?.user_id;
  } catch {
    return json(400, { error: 'invalid json' });
  }
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    return json(400, { error: 'user_id must be a uuid' });
  }

  // The database decides whether this request may be announced: still pending,
  // not announced before, and under the daily cap. It also stamps notified_at.
  const claim = (await rpc(deps, 'notifier_claim', { p_user_id: userId })) as Claim | null;
  if (claim === null) {
    console.error('notify-access-request: could not claim the request');
    return json(502, { error: 'database unavailable' });
  }
  if (!claim.send) return json(200, { skipped: true });

  const name = cleanName(claim.display_name) || 'Someone';
  const consoleUrl = deps.env('ADMIN_CONSOLE_URL') || DEFAULT_CONSOLE_URL;
  let message = `New Balance Tri request: ${name}. Review it in the console: ${consoleUrl}`;
  if (claim.last_of_day) message += `\n${DAILY_CAP_NOTICE}`;

  let sent = false;
  try {
    const res = await sendTelegram(deps, token, chatId, message);
    sent = res.ok;
    // Log the status only. The URL holds the bot token.
    if (!sent) console.error(`notify-access-request: Telegram answered ${res.status}`);
  } catch {
    console.error('notify-access-request: could not reach Telegram');
  }

  if (!sent) {
    // Hand the claim back, so notified_at stays empty and the console shows
    // "notification not sent". The queue never depends on Telegram.
    await rpc(deps, 'notifier_release', { p_user_id: userId });
    return json(502, { error: 'telegram did not accept the message' });
  }
  return json(200, { sent: true });
}
