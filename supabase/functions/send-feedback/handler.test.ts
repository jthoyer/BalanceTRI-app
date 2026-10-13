// Run with:  node --experimental-strip-types --test supabase/functions/send-feedback/handler.test.ts
// The database side (the rate limits, who may call what) is tested in
// supabase/tests/app_feedback.test.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, makeFormToken, cleanText, cleanPage, countLinks, type Deps } from './handler.ts';

const ORIGIN = 'https://jthoyer.github.io';
const TO = 'owner@example.test';
const T0 = 1_760_000_000_000;

const ENV: Record<string, string | undefined> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_anon',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  FEEDBACK_TO_EMAIL: TO,
  RESEND_API_KEY: 're_key',
  HCAPTCHA_SECRET: 'hc_secret',
};

interface Call {
  url: string;
  init?: RequestInit;
}
interface Opts {
  env?: Record<string, string | undefined>;
  captcha?: boolean | 'throw';
  claim?: object | 'fail';
  mail?: number | 'throw';
  user?: object | number;
  now?: number;
}

function setup(opts: Opts = {}) {
  const calls: Call[] = [];
  const env = { ...ENV, ...(opts.env ?? {}) };
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === 'https://api.hcaptcha.com/siteverify') {
      if (opts.captcha === 'throw') throw new Error('network');
      return Response.json({ success: opts.captcha ?? true });
    }
    if (url === 'https://api.resend.com/emails') {
      if (opts.mail === 'throw') throw new Error('network');
      return new Response('{}', { status: opts.mail ?? 200 });
    }
    if (url.endsWith('/auth/v1/user')) {
      if (typeof opts.user === 'number') return new Response('{}', { status: opts.user });
      return Response.json(opts.user ?? { id: 'u1', email: 'sam@example.com' });
    }
    if (url.endsWith('/rpc/feedback_mark_sent')) return new Response(null, { status: 204 });
    if (url.endsWith('/rpc/feedback_claim')) {
      if (opts.claim === 'fail') return new Response('{}', { status: 500 });
      return Response.json(opts.claim ?? { ok: true, id: 7 });
    }
    throw new Error('unexpected fetch ' + url);
  }) as unknown as typeof fetch;
  const deps: Deps = { env: n => env[n], fetch: fakeFetch, now: () => opts.now ?? T0 + 10_000 };
  const to = (u: string) => calls.filter(c => c.url === u || c.url.endsWith(u));
  return {
    deps,
    calls,
    mail: () => to('https://api.resend.com/emails'),
    captcha: () => to('https://api.hcaptcha.com/siteverify'),
    rpcs: (name: string) => to(`/rpc/${name}`),
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://fn.example/', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function sendBody(over: Record<string, unknown> = {}, openedAt = T0) {
  return {
    action: 'send',
    form_token: await makeFormToken('svc', openedAt),
    captcha_token: 'captcha-ok',
    message: 'The race list jumps when I filter by athlete.',
    contact: '',
    page: '/race/noosa-2026',
    website: '',
    ...over,
  };
}

const mailBody = (t: ReturnType<typeof setup>) => JSON.parse(String(t.mail()[0].init?.body));

test('start returns a form token that send accepts after the minimum fill time', async () => {
  const t = setup({ now: T0 });
  const res = await handle(post({ action: 'start' }), t.deps);
  assert.equal(res.status, 200);
  const { form_token } = await res.json();
  assert.match(form_token, /^\d+\.[0-9a-f]{64}$/);
  const t2 = setup({ now: T0 + 4_000 });
  const sent = await handle(post({ ...(await sendBody()), form_token }), t2.deps);
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { sent: true });
});

test('a good send stores first, emails the secret recipient, then marks it sent', async () => {
  const t = setup();
  const res = await handle(post(await sendBody()), t.deps);
  assert.equal(res.status, 200);
  const order = t.calls.map(c => new URL(c.url).pathname.split('/').pop());
  assert.deepEqual(order, ['siteverify', 'feedback_claim', 'emails', 'feedback_mark_sent']);
  const mail = mailBody(t);
  assert.deepEqual(mail.to, [TO]);
  assert.equal(mail.subject, 'Balance Tri app feedback #7');
  assert.ok(mail.text.includes('The race list jumps when I filter by athlete.'));
  assert.ok(mail.text.includes('Signed in as: not signed in'));
  assert.ok(mail.text.includes('Page: /race/noosa-2026'));
  assert.equal(mail.reply_to, undefined);
  assert.equal(mail.html, undefined, 'plain text only');
  assert.equal(String(t.mail()[0].init?.headers && (t.mail()[0].init?.headers as Record<string, string>).authorization), 'Bearer re_key');
});

test('the recipient address never appears in any response', async () => {
  const cases: [Opts, unknown][] = [
    [{}, await sendBody()],
    [{ mail: 500 }, await sendBody()],
    [{ claim: { ok: false, reason: 'sender' } }, await sendBody()],
    [{ env: { RESEND_API_KEY: undefined } }, await sendBody()],
    [{}, { action: 'start' }],
  ];
  for (const [opts, body] of cases) {
    const res = await handle(post(body), setup(opts).deps);
    const text = await res.text();
    assert.ok(!text.includes(TO), `response ${res.status} leaks the recipient`);
    assert.ok(!text.includes('re_key') && !text.includes('hc_secret'));
  }
});

test('origin: a missing or foreign origin gets 403 and no work', async () => {
  for (const origin of [undefined, 'https://evil.example', 'https://jthoyer.github.io.evil.example']) {
    const t = setup();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const req = new Request('https://fn.example/', {
      method: 'POST',
      headers,
      body: JSON.stringify(await sendBody()),
    });
    const res = await handle(req, t.deps);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(t.calls.length, 0);
  }
});

test('preflight answers only the allowed origin', async () => {
  const ok = await handle(
    new Request('https://fn.example/', { method: 'OPTIONS', headers: { origin: ORIGIN } }),
    setup().deps,
  );
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const bad = await handle(
    new Request('https://fn.example/', { method: 'OPTIONS', headers: { origin: 'https://x.example' } }),
    setup().deps,
  );
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('honeypot: filled in looks like success, but nothing is checked, stored or sent', async () => {
  const t = setup();
  const res = await handle(post(await sendBody({ website: 'http://spam.example' })), t.deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
  assert.equal(t.calls.length, 0);
});

test('minimum fill time: under 4 seconds is refused, 4 seconds exactly is fine', async () => {
  const fast = setup({ now: T0 + 3_999 });
  const res = await handle(post(await sendBody()), fast.deps);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'too_fast' });
  assert.equal(fast.calls.length, 0);
  const edge = setup({ now: T0 + 4_000 });
  assert.equal((await handle(post(await sendBody()), edge.deps)).status, 200);
});

test('form token: forged, tampered, missing or older than 2 hours is refused', async () => {
  const good = await makeFormToken('svc', T0);
  const forged = await makeFormToken('not-the-key', T0);
  const tampered = good.replace(/^\d+/, String(T0 - 60_000));
  for (const form_token of [forged, tampered, undefined, '', 'x'.repeat(200)]) {
    const t = setup();
    const res = await handle(post(await sendBody({ form_token })), t.deps);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'form_expired' });
    assert.equal(t.calls.length, 0);
  }
  const old = setup({ now: T0 + 2 * 60 * 60 * 1000 + 1 });
  assert.equal((await handle(post(await sendBody()), old.deps)).status, 400);
});

test('validation: length limits, links, and body size are enforced server side', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ message: '    hi  ' }, 'too_short'],
    [{ message: 'a'.repeat(2_001) }, 'too_long'],
    [{ message: 42 }, 'too_short'],
    [{ contact: 'c'.repeat(121) }, 'contact_too_long'],
    [{ message: 'see http://a.example http://b.example www.c.example https://d.example' }, 'too_many_links'],
  ];
  for (const [over, code] of cases) {
    const t = setup();
    const res = await handle(post(await sendBody(over)), t.deps);
    assert.equal(res.status, 400, code);
    assert.deepEqual(await res.json(), { error: code });
    assert.equal(t.calls.length, 0, `${code}: no outside calls`);
  }
  const ok = setup();
  assert.equal(
    (await handle(post(await sendBody({ message: 'é'.repeat(2_000) })), ok.deps)).status,
    200,
    '2000 characters exactly is allowed, counted as characters not bytes',
  );
  const big = setup();
  const res = await handle(post('{"action":"send","message":"' + 'a'.repeat(12_001) + '"}'), big.deps);
  assert.equal(res.status, 413);
  for (const junk of ['not json', '[]', 'null', '{"action":"other"}']) {
    assert.equal((await handle(post(junk), setup().deps)).status, 400, junk);
  }
});

test('captcha: a failed, missing or unreachable check gives 403 and stores nothing', async () => {
  for (const [opts, over] of [
    [{ captcha: false }, {}],
    [{ captcha: 'throw' }, {}],
    [{}, { captcha_token: '' }],
  ] as [Opts, Record<string, unknown>][]) {
    const t = setup(opts);
    const res = await handle(post(await sendBody(over)), t.deps);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'captcha' });
    assert.equal(t.rpcs('feedback_claim').length, 0);
    assert.equal(t.mail().length, 0);
  }
  const t = setup();
  await handle(post(await sendBody()), t.deps, );
  const form = new URLSearchParams(String(t.captcha()[0].init?.body));
  assert.equal(form.get('secret'), 'hc_secret');
  assert.equal(form.get('response'), 'captcha-ok');
  assert.equal(form.get('sitekey'), '9ab8d78a-9dc8-4eb4-b1e6-cd4250aeff68');
});

test('rate limits: the database says no, the member gets 429 and no mail', async () => {
  for (const [reason, code] of [
    ['sender', 'rate_limited'],
    ['daily', 'daily_limit'],
  ]) {
    const t = setup({ claim: { ok: false, reason } });
    const res = await handle(post(await sendBody()), t.deps);
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: code });
    assert.equal(t.mail().length, 0);
  }
});

test('the sender is a keyed hash of the IP, never the IP itself', async () => {
  const t = setup();
  await handle(post(await sendBody(), { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), t.deps);
  const args = JSON.parse(String(t.rpcs('feedback_claim')[0].init?.body));
  assert.match(args.p_source_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(args).includes('203.0.113.9'));
  const again = setup();
  await handle(post(await sendBody(), { 'x-forwarded-for': '203.0.113.9' }), again.deps);
  const other = setup();
  await handle(post(await sendBody(), { 'x-forwarded-for': '198.51.100.1' }), other.deps);
  const hash = (s: ReturnType<typeof setup>) =>
    JSON.parse(String(s.rpcs('feedback_claim')[0].init?.body)).p_source_hash;
  assert.equal(hash(again), args.p_source_hash, 'same IP, same hash');
  assert.notEqual(hash(other), args.p_source_hash, 'different IP, different hash');
  const form = new URLSearchParams(String(t.captcha()[0].init?.body));
  assert.equal(form.get('remoteip'), '203.0.113.9');
});

test('cf-connecting-ip, which the caller cannot set, wins over x-forwarded-for', async () => {
  const hashFor = async (headers: Record<string, string>) => {
    const t = setup();
    await handle(post(await sendBody(), headers), t.deps);
    return JSON.parse(String(t.rpcs('feedback_claim')[0].init?.body)).p_source_hash;
  };
  const real = await hashFor({ 'cf-connecting-ip': '203.0.113.9' });
  const forged = await hashFor({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' });
  assert.equal(forged, real, 'a forged x-forwarded-for does not change the sender');
});

test('a declared oversized body is refused before it is read', async () => {
  const t = setup();
  const res = await handle(post(await sendBody(), { 'content-length': '50000' }), t.deps);
  assert.equal(res.status, 413);
  assert.equal(t.calls.length, 0);
});

test('a signed-in member is named by their verified email, which becomes Reply-To', async () => {
  const t = setup({ user: { id: 'u1', email: 'sam@example.com' } });
  await handle(post(await sendBody({ contact: 'someone-else@example.com' }), { authorization: 'Bearer a.b.c' }), t.deps);
  const mail = mailBody(t);
  assert.equal(mail.reply_to, 'sam@example.com');
  assert.ok(mail.text.includes('Signed in as: sam@example.com'));
  const args = JSON.parse(String(t.rpcs('feedback_claim')[0].init?.body));
  assert.equal(args.p_user_id, 'u1');
});

test('the anon key or a bad token counts as a visitor; a typed email becomes Reply-To', async () => {
  for (const [auth, user] of [
    ['Bearer sb_publishable_anon', undefined],
    ['Bearer a.b.c', 401],
  ] as [string, number | undefined][]) {
    const t = setup({ user });
    const res = await handle(post(await sendBody({ contact: 'jo@example.com' }), { authorization: auth }), t.deps);
    assert.equal(res.status, 200);
    const mail = mailBody(t);
    assert.equal(mail.reply_to, 'jo@example.com');
    assert.ok(mail.text.includes('Signed in as: not signed in'));
    assert.equal(JSON.parse(String(t.rpcs('feedback_claim')[0].init?.body)).p_user_id, null);
  }
  const t = setup();
  await handle(post(await sendBody({ contact: 'Jo from squad B' })), t.deps);
  assert.equal(mailBody(t).reply_to, undefined, 'a name is not an address');
});

test('missing secrets: fail closed with not_configured and no outside calls', async () => {
  for (const name of ['FEEDBACK_TO_EMAIL', 'RESEND_API_KEY', 'HCAPTCHA_SECRET']) {
    const t = setup({ env: { [name]: undefined } });
    const res = await handle(post(await sendBody()), t.deps);
    assert.equal(res.status, 503, name);
    assert.deepEqual(await res.json(), { error: 'not_configured' });
    assert.equal(t.calls.length, 0);
  }
  const nokey = setup({ env: { SUPABASE_SERVICE_ROLE_KEY: undefined } });
  assert.equal((await handle(post({ action: 'start' }), nokey.deps)).status, 503);
});

test('mail failure: 502, the row stays unsent (no mark_sent), the store is not undone', async () => {
  for (const mail of [500, 'throw'] as const) {
    const t = setup({ mail });
    const res = await handle(post(await sendBody()), t.deps);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'mail_failed' });
    assert.equal(t.rpcs('feedback_claim').length, 1);
    assert.equal(t.rpcs('feedback_mark_sent').length, 0);
  }
  const t = setup({ claim: 'fail' });
  const res = await handle(post(await sendBody()), t.deps);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'unavailable' });
  assert.equal(t.mail().length, 0);
});

test('cleaning: control and direction characters go, newlines stay', () => {
  assert.equal(cleanText('a‮b\u0007c\r\nd\n\n\n\ne  ', { multiline: true }), 'abc\nd\n\ne');
  assert.equal(cleanText('  Jo \n Lee\t', { multiline: false }), 'Jo Lee');
  assert.equal(cleanText(null, { multiline: true }), '');
  assert.equal(cleanPage('/race/noosa-2026'), '/race/noosa-2026');
  assert.equal(cleanPage('https://evil.example/'), '');
  assert.equal(cleanPage('/<script>'), '');
  assert.equal(countLinks('http://a https://b www.c'), 3);
});

test('only POST and OPTIONS', async () => {
  const res = await handle(new Request('https://fn.example/', { method: 'GET', headers: { origin: ORIGIN } }), setup().deps);
  assert.equal(res.status, 405);
});
