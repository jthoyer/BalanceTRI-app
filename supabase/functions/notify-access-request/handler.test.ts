// Run with:  node --experimental-strip-types --test supabase/functions/notify-access-request/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, cleanName, ACCESS_REQUEST_TABLE, type Deps } from './handler.ts';

const ENV: Record<string, string> = {
  NOTIFY_WEBHOOK_SECRET: 'shh',
  TELEGRAM_BOT_TOKEN: 'TOKEN123',
  TELEGRAM_CHAT_ID: '4242',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  ADMIN_CONSOLE_URL: 'https://club.example/admin.html',
};

interface Call {
  url: string;
  init?: RequestInit;
}

// A fake fetch: HEAD to PostgREST returns `count`, Telegram returns `telegram`.
function setup(opts: { count?: number | 'fail'; telegram?: number | 'throw'; env?: object } = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.telegram.org/')) {
      if (opts.telegram === 'throw') throw new Error('network');
      return new Response('{}', { status: opts.telegram ?? 200 });
    }
    if (opts.count === 'fail') return new Response(null, { status: 500 });
    return new Response(null, {
      status: 200,
      headers: { 'content-range': `0-0/${opts.count ?? 1}` },
    });
  }) as unknown as typeof fetch;
  const env = { ...ENV, ...(opts.env ?? {}) } as Record<string, string | undefined>;
  const deps: Deps = { env: n => env[n], fetch: fakeFetch, now: () => new Date('2026-10-11T00:00:00Z') };
  const telegramCalls = () => calls.filter(c => c.url.startsWith('https://api.telegram.org/'));
  return { deps, calls, telegramCalls };
}

function post(body: unknown, headers: Record<string, string> = { 'x-webhook-secret': 'shh' }) {
  return new Request('https://fn.example/', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const insert = (display_name: unknown, extra: object = {}) => ({
  type: 'INSERT',
  schema: 'public',
  table: ACCESS_REQUEST_TABLE,
  record: { display_name },
  ...extra,
});

test('sends the display name and console link to the configured chat', async () => {
  const t = setup();
  const res = await handle(post(insert('Sam Rivers')), t.deps);
  assert.equal(res.status, 200);
  assert.equal(t.telegramCalls().length, 1);
  const sent = JSON.parse(String(t.telegramCalls()[0].init?.body));
  assert.equal(sent.chat_id, '4242');
  assert.match(sent.text, /Sam Rivers/);
  assert.match(sent.text, /https:\/\/club\.example\/admin\.html/);
  assert.equal(sent.parse_mode, undefined);
});

test('the chat ID cannot be set from the request (open relay)', async () => {
  const t = setup();
  const body = insert('Sam', { chat_id: '9999' });
  (body.record as Record<string, unknown>).chat_id = '9999';
  await handle(post(body), t.deps);
  assert.equal(JSON.parse(String(t.telegramCalls()[0].init?.body)).chat_id, '4242');
});

test('rejects a missing or wrong secret and sends nothing', async () => {
  for (const headers of [{}, { 'x-webhook-secret': 'nope' }]) {
    const t = setup();
    const res = await handle(post(insert('Sam'), headers), t.deps);
    assert.equal(res.status, 401);
    assert.equal(t.calls.length, 0);
  }
});

test('fails closed when a secret is not configured', async () => {
  for (const name of ['NOTIFY_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    const t = setup({ env: { [name]: undefined } });
    const res = await handle(post(insert('Sam')), t.deps);
    assert.equal(res.status, 500);
    assert.equal(t.calls.length, 0);
  }
});

test('only POST is accepted', async () => {
  const t = setup();
  const res = await handle(new Request('https://fn.example/', { method: 'GET' }), t.deps);
  assert.equal(res.status, 405);
});

test('ignores other events, tables and schemas', async () => {
  const cases = [
    { ...insert('Sam'), type: 'UPDATE' },
    { ...insert('Sam'), type: 'DELETE' },
    { ...insert('Sam'), table: 'users' },
    { ...insert('Sam'), schema: 'auth' },
  ];
  for (const body of cases) {
    const t = setup();
    const res = await handle(post(body), t.deps);
    assert.equal(res.status, 200);
    assert.equal(t.telegramCalls().length, 0);
  }
});

test('rejects bad JSON and oversized bodies', async () => {
  const t = setup();
  assert.equal((await handle(post('{not json'), t.deps)).status, 400);
  assert.equal((await handle(post('x'.repeat(10_001)), t.deps)).status, 413);
  assert.equal(t.telegramCalls().length, 0);
});

test('cleans a hostile display name', () => {
  assert.equal(cleanName('  Sam\n\tRivers  '), 'Sam Rivers');
  assert.equal(cleanName('Sam‮evil'), 'Sam evil');
  assert.equal(cleanName('a'.repeat(200)).length, 60);
  assert.equal(cleanName(42), '');
  assert.equal(cleanName(null), '');
});

test('uses a fallback when the name is empty or missing', async () => {
  for (const name of ['', '   ', undefined]) {
    const t = setup();
    await handle(post(insert(name)), t.deps);
    assert.match(JSON.parse(String(t.telegramCalls()[0].init?.body)).text, /Someone/);
  }
});

test('sends as plain text, so a name cannot add links or markup', async () => {
  const t = setup();
  await handle(post(insert('<a href="http://evil">click</a> *bold*')), t.deps);
  const sent = JSON.parse(String(t.telegramCalls()[0].init?.body));
  assert.equal(sent.parse_mode, undefined);
});

test('daily cap: sends up to the cap, one notice just over, then nothing', async () => {
  const atCap = setup({ count: 20 });
  await handle(post(insert('Sam')), atCap.deps);
  assert.match(JSON.parse(String(atCap.telegramCalls()[0].init?.body)).text, /New access request/);

  const justOver = setup({ count: 21 });
  await handle(post(insert('Sam')), justOver.deps);
  assert.equal(justOver.telegramCalls().length, 1);
  const notice = JSON.parse(String(justOver.telegramCalls()[0].init?.body)).text;
  assert.match(notice, /passed 20/);
  assert.doesNotMatch(notice, /Sam/);

  const wayOver = setup({ count: 22 });
  const res = await handle(post(insert('Sam')), wayOver.deps);
  assert.equal(res.status, 200);
  assert.equal(wayOver.telegramCalls().length, 0);
});

test('daily cap can be set by secret', async () => {
  const t = setup({ count: 6, env: { DAILY_ALERT_CAP: '5' } });
  await handle(post(insert('Sam')), t.deps);
  assert.match(JSON.parse(String(t.telegramCalls()[0].init?.body)).text, /passed 5/);
});

test('if the count cannot be read, the alert still goes out', async () => {
  const t = setup({ count: 'fail' });
  const res = await handle(post(insert('Sam')), t.deps);
  assert.equal(res.status, 200);
  assert.equal(t.telegramCalls().length, 1);
});

test('the count query asks for the last 24 hours with the service key', async () => {
  const t = setup();
  await handle(post(insert('Sam')), t.deps);
  const head = t.calls[0];
  assert.equal(head.init?.method, 'HEAD');
  assert.match(head.url, /\/rest\/v1\/access_requests\?select=id&created_at=gte\.2026-10-10T00%3A00%3A00\.000Z/);
});

test('a Telegram failure returns 502 and never logs the token', async () => {
  for (const telegram of [500, 'throw'] as const) {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(' '));
    try {
      const t = setup({ telegram });
      const res = await handle(post(insert('Sam')), t.deps);
      assert.equal(res.status, 502);
    } finally {
      console.error = orig;
    }
    assert.ok(logged.length > 0);
    assert.ok(logged.every(l => !l.includes('TOKEN123')));
  }
});
