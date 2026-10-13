// The logic behind the send-feedback Edge Function, kept free of Deno globals
// so the tests can run it under plain Node with a fake fetch and clock.
//
// The calendar's "Send feedback" form calls this from the browser. It emails
// the message to the app's maintainer. The recipient address is a secret
// (FEEDBACK_TO_EMAIL): it is never in the page, the repo, the database, the
// request or the response.
//
// Two calls, both POST with a JSON body:
//   {"action": "start"}  when the form opens. Returns a signed form token that
//                        records when the form was opened.
//   {"action": "send", form_token, captcha_token, message, contact, page,
//    website}           when the member presses Send.
//
// Bot defences, all checked here, none trusted to the browser:
//   1. Origin: only the calendar's own site may call it from a browser.
//   2. Honeypot: `website` is a field people never see. Filled in means a
//      bot; the answer looks like success and nothing is stored or sent.
//   3. Minimum fill time: the form token is signed with a key only this
//      function holds, so its timestamp can't be forged. A send less than
//      MIN_FILL_MS after the form opened, or older than MAX_FORM_AGE_MS,
//      is refused.
//   4. Validation and limits: body size, message 5..2000 characters, contact
//      up to 120, at most 3 links, control characters stripped.
//   5. hCaptcha: the token is checked with hCaptcha's siteverify.
//   6. Rate limits, in the database (feedback_claim): 3 per sender in 10
//      minutes, 10 a day, 50 for the whole app a day. The sender is a keyed
//      hash of the IP address, never the address itself.
//
// The message is stored before it is emailed, so a mail failure loses
// nothing: the row stays with sent_at empty.

export const MIN_FILL_MS = 4_000;
export const MAX_FORM_AGE_MS = 2 * 60 * 60 * 1000;
export const MIN_MESSAGE = 5;
export const MAX_MESSAGE = 2_000;
export const MAX_CONTACT = 120;
export const MAX_PAGE = 200;
export const MAX_LINKS = 3;
const MAX_BODY_BYTES = 12_000;
export const DEFAULT_ORIGINS = ['https://jthoyer.github.io'];
// Public, like the one in shared.js. siteverify checks the token was issued
// for this site.
export const DEFAULT_HCAPTCHA_SITE_KEY = '9ab8d78a-9dc8-4eb4-b1e6-cd4250aeff68';
export const DEFAULT_FROM = 'Balance Tri app <onboarding@resend.dev>';
export const SUBJECT = 'Balance Tri app feedback';

export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
}

const enc = new TextEncoder();

function allowedOrigins(deps: Deps): string[] {
  const raw = deps.env('FEEDBACK_ORIGINS');
  if (!raw) return DEFAULT_ORIGINS;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function cors(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

async function hmacHex(key: string, label: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(`${label}\u0000${key}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare of two hex strings of the same expected length.
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The signing key: FEEDBACK_SIGNING_KEY if set, otherwise the service role key
// (which Supabase provides and only server code holds). Each use gets its own
// label, so the form token and the sender hash never share a key.
function signingKey(deps: Deps): string | undefined {
  return deps.env('FEEDBACK_SIGNING_KEY') || deps.env('SUPABASE_SERVICE_ROLE_KEY');
}

export async function makeFormToken(key: string, issuedAt: number): Promise<string> {
  const ts = String(issuedAt);
  return `${ts}.${await hmacHex(key, 'feedback-form-token-v1', ts)}`;
}

// Returns the time the form was opened, or null if the token is not ours.
export async function readFormToken(key: string, token: unknown): Promise<number | null> {
  if (typeof token !== 'string' || token.length > 100) return null;
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const expected = await hmacHex(key, 'feedback-form-token-v1', m[1]);
  return sameHex(m[2], expected) ? Number(m[1]) : null;
}

// Strip control and direction-override characters (keeping newlines and
// tabs), normalise line endings, squash runs of blank lines, trim.
export function cleanText(raw: unknown, { multiline }: { multiline: boolean }): string {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  if (multiline) {
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\s+/g, ' ');
  }
  return s.trim();
}

const length = (s: string) => Array.from(s).length;

export function countLinks(s: string): number {
  return (s.match(/https?:\/\/|www\./gi) || []).length;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// A path on the calendar site, or nothing. Only used to say where the member
// was; never fetched.
export function cleanPage(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (s.length > MAX_PAGE || !/^\/[A-Za-z0-9\-._~/#?=&%]*$/.test(s)) return '';
  return s;
}

// The caller's IP, for the rate-limit hash only. cf-connecting-ip is set by
// the edge in front of Supabase and can't be supplied by the caller; the
// first x-forwarded-for entry can be, if a proxy appends rather than
// replaces, so it is the last resort. The daily cap for the whole app bounds
// what a forged header could win.
function clientIp(req: Request): string {
  const direct = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip');
  if (direct) return direct.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

// Calls a service-role-only database function. Returns null on any failure.
async function rpc(deps: Deps, name: string, args: object): Promise<unknown | null> {
  const url = deps.env('SUPABASE_URL');
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  try {
    const res = await deps.fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

async function captchaPasses(deps: Deps, secret: string, token: unknown, ip: string) {
  if (typeof token !== 'string' || !token || token.length > 4_000) return false;
  const form = new URLSearchParams({
    secret,
    response: token,
    sitekey: deps.env('HCAPTCHA_SITE_KEY') || DEFAULT_HCAPTCHA_SITE_KEY,
  });
  if (ip !== 'unknown') form.set('remoteip', ip);
  try {
    const res = await deps.fetch('https://api.hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) return false;
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}

// Who is signed in, if anyone. The browser sends the member's own access
// token; Auth says whose it is. Anything else (the anon key, a bad or expired
// token) counts as a visitor — feedback doesn't need an account.
async function signedInUser(
  deps: Deps,
  req: Request,
): Promise<{ id: string; email: string } | null> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token.split('.').length !== 3 || token.length > 4_000) return null;
  const url = deps.env('SUPABASE_URL');
  const apikey = deps.env('SUPABASE_ANON_KEY');
  if (!url || !apikey) return null;
  try {
    const res = await deps.fetch(`${url}/auth/v1/user`, {
      headers: { apikey, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: string; email?: string };
    if (typeof user.id !== 'string' || typeof user.email !== 'string') return null;
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}

function sydneyTime(ms: number): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

export function emailText(f: {
  id: number;
  message: string;
  contact: string;
  member: string | null;
  page: string;
  when: string;
}): string {
  const lines = [
    `Feedback #${f.id}, ${f.when} (Sydney time)`,
    '',
    f.message,
    '',
    '---',
    `Signed in as: ${f.member ?? 'not signed in'}`,
    `Contact they typed (unverified): ${f.contact || 'none'}`,
    `Page: ${f.page || 'unknown'}`,
  ];
  return lines.join('\n');
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const origins = allowedOrigins(deps);
  const origin = req.headers.get('origin');
  const corsHeaders = cors(origin, origins);
  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsHeaders },
    });
  const fail = (status: number, code: string) => json(status, { error: code });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed');
  // A browser always sends Origin on this cross-site POST. No match, no work.
  if (!origin || !origins.includes(origin)) return fail(403, 'origin');

  const key = signingKey(deps);
  if (!key) {
    console.error('send-feedback: no signing key');
    return fail(503, 'not_configured');
  }

  // Refuse an oversized body before reading it, where the size is declared.
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    return fail(413, 'too_large');
  }
  const raw = await req.text();
  if (enc.encode(raw).length > MAX_BODY_BYTES) return fail(413, 'too_large');
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'bad_request');
  }

  const now = deps.now();
  if (body.action === 'start') {
    return json(200, { form_token: await makeFormToken(key, now) });
  }
  if (body.action !== 'send') return fail(400, 'bad_request');

  // Honeypot: answer as if it worked, so a bot learns nothing. No row, no mail.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json(200, { sent: true });
  }

  const opened = await readFormToken(key, body.form_token);
  if (opened === null) return fail(400, 'form_expired');
  const age = now - opened;
  if (age < MIN_FILL_MS) return fail(400, 'too_fast');
  if (age > MAX_FORM_AGE_MS) return fail(400, 'form_expired');

  const message = cleanText(body.message, { multiline: true });
  const contact = cleanText(body.contact, { multiline: false });
  const page = cleanPage(body.page);
  if (length(message) < MIN_MESSAGE) return fail(400, 'too_short');
  if (length(message) > MAX_MESSAGE) return fail(400, 'too_long');
  if (length(contact) > MAX_CONTACT) return fail(400, 'contact_too_long');
  if (countLinks(message) + countLinks(contact) > MAX_LINKS) return fail(400, 'too_many_links');

  // Everything below needs the secrets. Fail closed if any is missing.
  const to = deps.env('FEEDBACK_TO_EMAIL');
  const mailKey = deps.env('RESEND_API_KEY');
  const captchaSecret = deps.env('HCAPTCHA_SECRET');
  if (!to || !mailKey || !captchaSecret || !deps.env('SUPABASE_URL')) {
    console.error('send-feedback: a required secret is not set');
    return fail(503, 'not_configured');
  }

  const ip = clientIp(req);
  if (!(await captchaPasses(deps, captchaSecret, body.captcha_token, ip))) {
    return fail(403, 'captcha');
  }

  const member = await signedInUser(deps, req);
  const sourceHash = await hmacHex(key, 'feedback-sender-v1', ip);

  const claim = (await rpc(deps, 'feedback_claim', {
    p_source_hash: sourceHash,
    p_user_id: member?.id ?? null,
    p_message: message,
    p_contact: contact,
    p_page: page,
  })) as { ok?: boolean; id?: number; reason?: string } | null;
  if (claim === null) {
    console.error('send-feedback: could not store the message');
    return fail(502, 'unavailable');
  }
  if (!claim.ok || typeof claim.id !== 'number') {
    return fail(429, claim.reason === 'daily' ? 'daily_limit' : 'rate_limited');
  }

  // Reply-To: the member's verified address if signed in, otherwise what they
  // typed, but only if it looks like an address.
  const replyTo = member?.email || (EMAIL.test(contact) ? contact : undefined);
  const mail: Record<string, unknown> = {
    from: deps.env('FEEDBACK_FROM_EMAIL') || DEFAULT_FROM,
    to: [to],
    subject: `${SUBJECT} #${claim.id}`,
    text: emailText({
      id: claim.id,
      message,
      contact,
      member: member?.email ?? null,
      page,
      when: sydneyTime(now),
    }),
  };
  if (replyTo) mail.reply_to = replyTo;

  let sent = false;
  try {
    const res = await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${mailKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(mail),
    });
    sent = res.ok;
    // The status only: the request carries the API key and the recipient.
    if (!sent) console.error(`send-feedback: mail provider answered ${res.status}`);
  } catch {
    console.error('send-feedback: could not reach the mail provider');
  }
  if (!sent) return fail(502, 'mail_failed');

  await rpc(deps, 'feedback_mark_sent', { p_id: claim.id });
  return json(200, { sent: true });
}
