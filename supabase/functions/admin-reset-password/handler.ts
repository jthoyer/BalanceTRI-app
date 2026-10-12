// The logic behind the admin-reset-password Edge Function (step B5, spec 5.5),
// kept free of Deno globals so the tests can run it under plain Node.
//
// The console's Reset password button calls this with the admin's own session.
// Flow:
//   0. Check the caller's own session is still live with Auth. A stolen admin
//      token whose session was revoked fails here, though the token itself
//      would pass PostgREST until it expires.
//   1. Ask the database, AS THE CALLER, to begin the reset. That function
//      refuses anyone who isn't an admin with a two-factor (aal2) session, then
//      flags "must change password" for 7 days, signs the member out on every
//      device, and logs password_reset. So the admin check lives in the same
//      place as every other admin check, not in this file.
//   2. Make a temporary password: four random words and two digits.
//   3. Set it with the service role (the Auth admin API).
//   4. Ask the database, as the caller, to sign the member out once more. The
//      old password worked until step 3, so a session opened in between must
//      not survive the reset.
//   5. Return the password once. It is never stored, logged or emailed.
//
// If step 3 fails, the member is still flagged and signed out, and their old
// password still works: they'll be asked for a new one when they next sign in.
// The admin sees an error and can try again.

import { WORDS } from './words.ts';

export const DEFAULT_ORIGIN = 'https://jthoyer.github.io';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_000;

export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  random: (n: number) => Uint32Array;
}

function cors(origin: string | null, allowed: string): Record<string, string> {
  // Only the console's own site may call this from a browser.
  if (origin !== allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    vary: 'origin',
  };
}

// A uniform pick from 0..n-1: reject draws that would favour the low end.
function pick(deps: Deps, n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const [x] = deps.random(1);
    if (x < limit) return x % n;
  }
}

// e.g. "maple-river-swift-cloud-47": about 24 characters, easy to read out.
export function temporaryPassword(deps: Deps): string {
  const words = Array.from({ length: 4 }, () => WORDS[pick(deps, WORDS.length)]);
  const digits = String(pick(deps, 100)).padStart(2, '0');
  return `${words.join('-')}-${digits}`;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const allowed = deps.env('ADMIN_ORIGIN') || DEFAULT_ORIGIN;
  const corsHeaders = cors(req.headers.get('origin'), allowed);
  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsHeaders },
    });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

  const url = deps.env('SUPABASE_URL');
  const anonKey = deps.env('SUPABASE_ANON_KEY');
  const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    console.error('admin-reset-password: a required setting is missing');
    return json(500, { error: 'not configured' });
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer \S+$/.test(auth)) return json(401, { error: 'Sign in first.' });

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

  // 0. The caller's session must still exist.
  try {
    const me = await deps.fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: auth },
    });
    if (!me.ok) return json(401, { error: 'Your session has ended. Sign in again.' });
  } catch {
    return json(502, { error: 'Could not reach Auth. Try again.' });
  }

  // 1. The database decides, as the caller, whether this is allowed.
  let begin: Response;
  try {
    begin = await deps.fetch(`${url}/rest/v1/rpc/admin_password_reset_begin`, {
      method: 'POST',
      headers: { apikey: anonKey, authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ p_user_id: userId }),
    });
  } catch {
    return json(502, { error: 'Could not reach the database. Try again.' });
  }
  if (!begin.ok) {
    let message = 'The reset was refused.';
    try {
      message = (await begin.json())?.message || message;
    } catch {
      // keep the default
    }
    // 401 and 403 pass through: not signed in, not an admin, or no two-factor.
    const status = begin.status === 401 || begin.status === 403 ? begin.status : 400;
    return json(status, { error: message });
  }
  const started = (await begin.json().catch(() => ({}))) as { expires_at?: string };

  // 2 and 3. Make the password and set it with the service role.
  const password = temporaryPassword(deps);
  let set: Response;
  try {
    set = await deps.fetch(`${url}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
  } catch {
    set = new Response(null, { status: 599 });
  }
  if (!set.ok) {
    // Log the status only, never the password.
    console.error(`admin-reset-password: Auth answered ${set.status}`);
    return json(502, {
      error:
        'The member is signed out and will be asked for a new password, but the temporary password was not set. Try again.',
    });
  }

  // 4. Sign the member out again, now the old password no longer works.
  let signedOut = false;
  try {
    const finish = await deps.fetch(`${url}/rest/v1/rpc/admin_password_reset_finish`, {
      method: 'POST',
      headers: { apikey: anonKey, authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ p_user_id: userId }),
    });
    signedOut = finish.ok;
  } catch {
    // reported below
  }
  if (!signedOut) console.error('admin-reset-password: the second sign-out failed');

  // 5. Shown once by the console, then gone. signed_out false means a session
  // opened during the reset may survive it: the console says so.
  return json(200, { password, expires_at: started.expires_at ?? null, signed_out: signedOut });
}
