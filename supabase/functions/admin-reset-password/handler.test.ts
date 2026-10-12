// Run with:  node --experimental-strip-types --test supabase/functions/admin-reset-password/handler.test.ts
// The Edge half of spec test T9. The database half (who may begin a reset,
// signing out everywhere, the flag) is in supabase/tests/b5_password_reset.test.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, temporaryPassword, type Deps } from './handler.ts';
import { WORDS } from './words.ts';

const USER_ID = '3f2b8c1e-5a47-4d09-9c1d-7e6a4b2f1a90';
const ENV: Record<string, string | undefined> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};
const SHAPE = /^[a-z]{3,8}-[a-z]{3,8}-[a-z]{3,8}-[a-z]{3,8}-\d{2}$/;

interface Call {
  url: string;
  init?: RequestInit;
}
interface Opts {
  begin?: { status: number; body?: object } | 'throw';
  set?: number | 'throw';
  env?: Record<string, string | undefined>;
}

function setup(opts: Opts = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/rpc/admin_password_reset_begin')) {
      if (opts.begin === 'throw') throw new Error('network');
      const b = opts.begin ?? { status: 200, body: { user_id: USER_ID, expires_at: '2026-10-19T00:00:00Z' } };
      return new Response(JSON.stringify(b.body ?? {}), { status: b.status });
    }
    if (url.includes('/auth/v1/admin/users/')) {
      if (opts.set === 'throw') throw new Error('network');
      return new Response('{}', { status: opts.set ?? 200 });
    }
    throw new Error('unexpected url ' + url);
  }) as unknown as typeof fetch;
  const env = { ...ENV, ...(opts.env ?? {}) };
  const deps: Deps = {
    env: n => env[n],
    fetch: fakeFetch,
    random: n => crypto.getRandomValues(new Uint32Array(n)),
  };
  return {
    deps,
    calls,
    begins: () => calls.filter(c => c.url.endsWith('/rpc/admin_password_reset_begin')),
    sets: () => calls.filter(c => c.url.includes('/auth/v1/admin/users/')),
  };
}

const ADMIN = { authorization: 'Bearer admin-session-jwt', origin: 'https://jthoyer.github.io' };
function post(body: unknown, headers: Record<string, string> = ADMIN) {
  return new Request('https://fn.example/', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('T9: with no session, nothing happens (401)', async () => {
  const t = setup();
  const res = await handle(post({ user_id: USER_ID }, {}), t.deps);
  assert.equal(res.status, 401);
  assert.equal(t.calls.length, 0);
});

test('T9: anon, a member, or an admin without two-factor are refused by the database, and no password is set', async () => {
  for (const status of [401, 403]) {
    const t = setup({ begin: { status, body: { code: '42501', message: 'Admins only.' } } });
    const res = await handle(post({ user_id: USER_ID }), t.deps);
    assert.equal(res.status, status);
    assert.equal((await res.json()).error, 'Admins only.');
    assert.equal(t.sets().length, 0);
  }
});

test('the database is asked as the caller, never with the service key', async () => {
  const t = setup();
  await handle(post({ user_id: USER_ID }), t.deps);
  const h = t.begins()[0].init?.headers as Record<string, string>;
  assert.equal(h.authorization, 'Bearer admin-session-jwt');
  assert.equal(h.apikey, 'anon-key');
  assert.deepEqual(JSON.parse(String(t.begins()[0].init?.body)), { p_user_id: USER_ID });
});

test('T9: with two-factor, a temporary password is set with the service key and returned once', async () => {
  const t = setup();
  const res = await handle(post({ user_id: USER_ID }), t.deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.password, SHAPE);
  assert.equal(body.expires_at, '2026-10-19T00:00:00Z');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const set = t.sets()[0];
  assert.equal(set.url, `https://example.supabase.co/auth/v1/admin/users/${USER_ID}`);
  assert.equal(set.init?.method, 'PUT');
  const h = set.init?.headers as Record<string, string>;
  assert.equal(h.authorization, 'Bearer service-key');
  assert.deepEqual(JSON.parse(String(set.init?.body)), { password: body.password });
});

test('the reset begins in the database before the password changes', async () => {
  const t = setup();
  await handle(post({ user_id: USER_ID }), t.deps);
  assert.ok(t.calls[0].url.endsWith('/rpc/admin_password_reset_begin'));
  assert.ok(t.calls[1].url.includes('/auth/v1/admin/users/'));
});

test('a refusal with a reason passes the reason on (for example, the account is gone)', async () => {
  const t = setup({ begin: { status: 400, body: { message: 'That account no longer exists.' } } });
  const res = await handle(post({ user_id: USER_ID }), t.deps);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'That account no longer exists.');
  assert.equal(t.sets().length, 0);
});

test('if setting the password fails, the admin gets an error, no password, and the log has no password', async () => {
  for (const set of [500, 'throw'] as const) {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(' '));
    let body: Record<string, unknown>;
    let sent = '';
    try {
      const t = setup({ set });
      const res = await handle(post({ user_id: USER_ID }), t.deps);
      assert.equal(res.status, 502);
      body = await res.json();
      sent = JSON.parse(String(t.sets()[0].init?.body)).password;
    } finally {
      console.error = orig;
    }
    assert.equal(body.password, undefined);
    assert.ok(logged.every(l => !l.includes(sent)));
  }
});

test('a database outage sets no password', async () => {
  const t = setup({ begin: 'throw' });
  const res = await handle(post({ user_id: USER_ID }), t.deps);
  assert.equal(res.status, 502);
  assert.equal(t.sets().length, 0);
});

test('bad input is refused before anything happens', async () => {
  const t = setup();
  assert.equal((await handle(post('{nope'), t.deps)).status, 400);
  assert.equal((await handle(post({ user_id: 'x' }), t.deps)).status, 400);
  assert.equal((await handle(post('x'.repeat(1_001)), t.deps)).status, 413);
  assert.equal((await handle(new Request('https://fn.example/', { method: 'GET' }), t.deps)).status, 405);
  assert.equal(t.calls.length, 0);
});

test('fails closed when a setting is missing', async () => {
  for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const t = setup({ env: { [name]: undefined } });
    assert.equal((await handle(post({ user_id: USER_ID }), t.deps)).status, 500);
    assert.equal(t.calls.length, 0);
  }
});

test('CORS: only the console origin is allowed', async () => {
  const pre = (origin: string) =>
    new Request('https://fn.example/', { method: 'OPTIONS', headers: { origin } });
  const ok = await handle(pre('https://jthoyer.github.io'), setup().deps);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://jthoyer.github.io');
  const bad = await handle(pre('https://evil.example'), setup().deps);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const other = setup({ env: { ADMIN_ORIGIN: 'https://club.example' } });
  const res = await handle(post({ user_id: USER_ID }, { ...ADMIN, origin: 'https://club.example' }), other.deps);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://club.example');
});

test('temporary passwords: four words and two digits, about 24 characters, all different', () => {
  const deps = setup().deps;
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const p = temporaryPassword(deps);
    assert.match(p, SHAPE);
    assert.ok(p.length >= 12, 'meets the 12-character minimum');
    seen.add(p);
  }
  assert.equal(seen.size, 2000);
});

test('temporary passwords reject draws that would favour the first words', () => {
  // A fake random source that walks through every 32-bit value's top end, to
  // show the rejection step: values at or above the last whole multiple of
  // the list size are skipped, not folded onto the first words.
  const n = WORDS.length;
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const draws = [0xffff_ffff, limit, n + 3];
  let i = 0;
  const deps: Deps = {
    env: () => undefined,
    fetch: (async () => new Response()) as unknown as typeof fetch,
    random: () => Uint32Array.of(draws[i++ % draws.length]),
  };
  const word = temporaryPassword(deps).split('-')[0];
  assert.equal(word, WORDS[3], 'the two out-of-range draws were rejected');
  assert.equal(new Set(WORDS).size, n, 'the word list has no duplicates');
});
