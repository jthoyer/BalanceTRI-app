// Run with:  node --experimental-strip-types --test supabase/functions/notify-access-request/handler.test.ts
// The database side (claim, release, the daily cap, the trigger) is tested in
// notifier.test.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, cleanName, DAILY_CAP_NOTICE, type Deps } from './handler.ts';

const USER_ID = '3f2b8c1e-5a47-4d09-9c1d-7e6a4b2f1a90';

const ENV: Record<string, string | undefined> = {
  NOTIFY_SHARED_SECRET: 'shh',
  TELEGRAM_BOT_TOKEN: 'TOKEN123',
  TELEGRAM_ADMIN_CHAT_ID: '4242',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
};

interface Call {
  url: string;
  init?: RequestInit;
}

interface Opts {
  claim?: object | 'fail' | 'throw';
  telegram?: number | 'throw';
  env?: Record<string, string | undefined>;
}

// A fake fetch: PostgREST rpc calls return `claim`, Telegram returns `telegram`.
function setup(opts: Opts = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.telegram.org/')) {
      if (opts.telegram === 'throw') throw new Error('network');
      return new Response('{}', { status: opts.telegram ?? 200 });
    }
    if (url.endsWith('/rpc/notifier_release')) return new Response(null, { status: 204 });
    if (opts.claim === 'throw') throw new Error('network');
    if (opts.claim === 'fail') return new Response('{}', { status: 500 });
    const claim = opts.claim ?? { send: true, display_name: 'Sam Lee', last_of_day: false };
    return new Response(JSON.stringify(claim), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { ...ENV, ...(opts.env ?? {}) };
  const deps: Deps = { env: n => env[n], fetch: fakeFetch };
  return {
    deps,
    calls,
    telegram: () => calls.filter(c => c.url.startsWith('https://api.telegram.org/')),
    rpcs: (name: string) => calls.filter(c => c.url.endsWith(`/rpc/${name}`)),
  };
}

function post(body: unknown, headers: Record<string, string> = { 'x-notify-secret': 'shh' }) {
  return new Request('https://fn.example/', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const sentText = (t: ReturnType<typeof setup>) => JSON.parse(String(t.telegram()[0].init?.body));

test('sends the name and console link to the fixed chat', async () => {
  const t = setup();
  const res = await handle(post({ user_id: USER_ID }), t.deps);
  assert.equal(res.status, 200);
  assert.equal(t.telegram().length, 1);
  const sent = sentText(t);
  assert.equal(sent.chat_id, '4242');
  assert.equal(
    sent.text,
    'New Balance Tri request: Sam Lee. Review it in the console: https://jthoyer.github.io/BalanceTRI-app/admin.html#requests',
  );
  assert.equal(sent.disable_web_page_preview, true);
  assert.equal(sent.parse_mode, undefined);
});

test('T7: no secret, a wrong secret, or only the anon key all give 401 and no work', async () => {
  const cases = [{}, { 'x-notify-secret': 'nope' }, { authorization: 'Bearer sb_publishable_anon' }];
  for (const headers of cases) {
    const t = setup();
    const res = await handle(post({ user_id: USER_ID }, headers), t.deps);
    assert.equal(res.status, 401);
    assert.equal(t.calls.length, 0);
  }
});

test('nothing the caller sends reaches the message or the chat', async () => {
  const t = setup();
  await handle(
    post({ user_id: USER_ID, display_name: 'EVIL', text: 'EVIL', chat_id: '9999', note: 'EVIL' }),
    t.deps,
  );
  const sent = sentText(t);
  assert.equal(sent.chat_id, '4242');
  assert.doesNotMatch(sent.text, /EVIL/);
  assert.deepEqual(JSON.parse(String(t.rpcs('notifier_claim')[0].init?.body)), { p_user_id: USER_ID });
});

test('asks the database to claim the request with the service key', async () => {
  const t = setup();
  await handle(post({ user_id: USER_ID }), t.deps);
  const claim = t.rpcs('notifier_claim')[0];
  assert.equal(claim.url, 'https://example.supabase.co/rest/v1/rpc/notifier_claim');
  const headers = claim.init?.headers as Record<string, string>;
  assert.equal(headers.apikey, 'svc');
  assert.equal(headers.authorization, 'Bearer svc');
});

test('sends nothing when the database says no (not pending, already sent, over the cap)', async () => {
  const t = setup({ claim: { send: false, reason: 'daily cap' } });
  const res = await handle(post({ user_id: USER_ID }), t.deps);
  assert.equal(res.status, 200);
  assert.equal(t.telegram().length, 0);
  assert.equal(t.rpcs('notifier_release').length, 0);
});

test('T8: the last message of the day says the limit is reached', async () => {
  const t = setup({ claim: { send: true, display_name: 'Sam Lee', last_of_day: true } });
  await handle(post({ user_id: USER_ID }), t.deps);
  const text = sentText(t).text as string;
  assert.ok(text.startsWith('New Balance Tri request: Sam Lee.'));
  assert.ok(text.endsWith(`\n${DAILY_CAP_NOTICE}`));
  assert.equal(DAILY_CAP_NOTICE, 'Daily limit reached. Check the console for more.');
});

test('a Telegram failure hands the claim back and returns 502', async () => {
  for (const telegram of [500, 'throw'] as const) {
    const t = setup({ telegram });
    const res = await handle(post({ user_id: USER_ID }), t.deps);
    assert.equal(res.status, 502);
    assert.equal(t.rpcs('notifier_release').length, 1);
    assert.deepEqual(JSON.parse(String(t.rpcs('notifier_release')[0].init?.body)), {
      p_user_id: USER_ID,
    });
  }
});

test('a failed claim sends nothing and returns 502', async () => {
  for (const claim of ['fail', 'throw'] as const) {
    const t = setup({ claim });
    const res = await handle(post({ user_id: USER_ID }), t.deps);
    assert.equal(res.status, 502);
    assert.equal(t.telegram().length, 0);
  }
});

test('the token is never logged', async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(' '));
  try {
    for (const telegram of [500, 'throw'] as const) {
      await handle(post({ user_id: USER_ID }), setup({ telegram }).deps);
    }
  } finally {
    console.error = orig;
  }
  assert.ok(logged.length > 0);
  assert.ok(logged.every(l => !l.includes('TOKEN123')));
});

test('fails closed when a secret is not configured', async () => {
  for (const name of ['NOTIFY_SHARED_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_CHAT_ID']) {
    const t = setup({ env: { [name]: undefined } });
    const res = await handle(post({ user_id: USER_ID }), t.deps);
    assert.equal(res.status, 500);
    assert.equal(t.calls.length, 0);
  }
});

test('only POST is accepted', async () => {
  const t = setup();
  const res = await handle(new Request('https://fn.example/', { method: 'GET' }), t.deps);
  assert.equal(res.status, 405);
});

test('rejects bad JSON, a missing or malformed user_id, and oversized bodies', async () => {
  const t = setup();
  assert.equal((await handle(post('{not json'), t.deps)).status, 400);
  assert.equal((await handle(post({}), t.deps)).status, 400);
  assert.equal((await handle(post({ user_id: 'not-a-uuid' }), t.deps)).status, 400);
  assert.equal((await handle(post({ user_id: 42 }), t.deps)).status, 400);
  assert.equal((await handle(post('x'.repeat(1_001)), t.deps)).status, 413);
  assert.equal(t.calls.length, 0);
});

test('cleans a hostile display name from the database', async () => {
  assert.equal(cleanName('  Sam\n\tLee  '), 'Sam Lee');
  assert.equal(cleanName('Sam‮evil'), 'Sam evil');
  assert.equal(cleanName('Sam\u200bLee'), 'Sam Lee');
  assert.equal(cleanName('Sam\u2066Lee\u2069'), 'Sam Lee');
  assert.equal(cleanName('\ufeffSam'), 'Sam');
  assert.equal(cleanName('a'.repeat(200)).length, 60);
  assert.equal(cleanName(42), '');
  const t = setup({ claim: { send: true, display_name: '   ', last_of_day: false } });
  await handle(post({ user_id: USER_ID }), t.deps);
  assert.match(sentText(t).text, /request: Someone\./);
});

test('ADMIN_CONSOLE_URL overrides the default link', async () => {
  const t = setup({ env: { ADMIN_CONSOLE_URL: 'https://club.example/admin.html#requests' } });
  await handle(post({ user_id: USER_ID }), t.deps);
  assert.match(sentText(t).text, /https:\/\/club\.example\/admin\.html#requests$/);
});
