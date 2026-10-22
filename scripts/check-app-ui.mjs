// Drives index.html in headless Chromium against a stand-in Supabase client,
// to check the member side of gated accounts (B7): the join form, password
// sign-in, the account states, the forced set-password step after an admin
// reset, and the one-time "set a password" prompt.
//
//   node scripts/check-app-ui.mjs
//
// Needs Playwright; it skips (exit 0) when Playwright isn't installed, so it
// can't break a checkout without it. It never talks to the real project: the
// vendored supabase-js and the hCaptcha script are both replaced.
//
// Every scenario opens its own page, which is its own browser context: a full
// load with empty localStorage. Where a scenario reloads the same page on
// purpose (the once-only prompt), it says so.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    const req = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM || import.meta.url);
    ({ chromium } = req('playwright'));
  } catch {
    console.log('check-app-ui: Playwright is not installed, skipping.');
    process.exit(0);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.txt': 'text/plain',
};
const server = createServer(async (req, res) => {
  try {
    const asked = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const path = asked === '/' ? '/index.html' : asked;
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The stand-in client. window.__calls records every call, but only the length
// of a password, never its text. window.__fixtures says what each call
// returns; window.__session is who is signed in right now, and
// window.__access is what my_access_status answers.
const STUB = `
window.__calls = [];
window.__session = window.__fixtures.session || null;
window.__access = window.__fixtures.access || null;
const fx = () => window.__fixtures;
const res = v => Promise.resolve(v);
let authCallback = null;
const emit = (event) => authCallback && authCallback(event, window.__session);
window.__emit = emit;
const seq = (name, fallback) => {
  const list = fx().seq?.[name];
  return list && list.length ? list.shift() : fallback;
};
const user = (email) => ({ id: 'u-new', email, user_metadata: {} });
window.supabase = { createClient: () => ({
  auth: {
    getSession: () => res({ data: { session: window.__session } }),
    onAuthStateChange: cb => { authCallback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signOut: () => { window.__calls.push(['signOut']); window.__session = null; window.__access = null; emit('SIGNED_OUT'); return res({ error: null }); },
    signUp: a => {
      window.__calls.push(['signUp', a.email, a.password.length, a.options]);
      const out = seq('signUp', fx().signUp || {});
      if (out.error || out.noSession) return res({ data: { session: null, user: out.user || null }, error: out.error || null });
      window.__session = { user: user(a.email), access_token: 't' };
      window.__access = { state: 'none', display_name: null, password_change_due: false, reset_expires_at: null, reset_expired: false };
      emit('SIGNED_IN');
      return res({ data: { session: window.__session, user: window.__session.user }, error: null });
    },
    signInWithPassword: a => {
      window.__calls.push(['signInWithPassword', a.email, a.password.length, a.options]);
      const out = seq('signIn', fx().signIn || { error: { code: 'invalid_credentials', message: 'Invalid login credentials' } });
      if (out.error) return res({ data: null, error: out.error });
      window.__session = { user: { id: 'u1', email: a.email, user_metadata: out.metadata || {} }, access_token: 't' };
      window.__access = out.access;
      emit('SIGNED_IN');
      return res({ data: { session: window.__session }, error: null });
    },
    signInWithOtp: a => { window.__calls.push(['signInWithOtp', a.email]); return res({ error: null }); },
    verifyOtp: () => { window.__calls.push(['verifyOtp']); return res({ error: null }); },
    updateUser: a => {
      window.__calls.push(['updateUser', a.password ? a.password.length : null, a.data || null]);
      const e = seq('updateUser', null);
      if (e) return res({ data: null, error: e });
      emit('USER_UPDATED');
      return res({ data: { user: window.__session.user }, error: null });
    },
  },
  rpc: (name, args) => {
    window.__calls.push(['rpc', name, args || null]);
    if (name === 'is_allow_listed' && fx().listedError) return res({ data: null, error: { message: 'boom' } });
    if (name === 'is_allow_listed') return res({ data: window.__access?.state === 'approved' || !!fx().listed, error: null });
    if (name === 'my_access_status') {
      if (fx().statusError) return res({ data: null, error: fx().statusError });
      return res({ data: window.__access, error: null });
    }
    if (name === 'request_access') {
      const e = seq('requestAccess', null);
      if (e) return res({ data: null, error: e });
      window.__access = { state: 'pending', display_name: args.p_display_name, password_change_due: false, reset_expires_at: null, reset_expired: false };
      return res({ data: { state: 'pending' }, error: null });
    }
    if (name === 'password_changed') {
      const e = seq('passwordChanged', null);
      if (e) return res({ data: null, error: e });
      window.__access = { ...window.__access, password_change_due: false };
      return res({ data: null, error: null });
    }
    if (name === 'admin_status') return res({ data: fx().adminStatus || { admin: false }, error: null });
    if (name === 'public_race_counts') {
      if (!fx().publicCounts) return res({ data: null, error: { code: 'PGRST202', message: 'not found' } });
      return res({ data: fx().publicCounts, error: null });
    }
    if (name === 'public_entries') return res({ data: fx().publicEntries || [], error: null });
    return res({ data: null, error: { code: 'PGRST202', message: 'not found' } });
  },
  from: table => {
    let writing = false;
    let payload = null;
    let isNull = null;
    window.__reads = window.__reads || [];
    window.__reads.push(table);
    const q = {
      insert: p => { writing = true; payload = p; window.__calls.push(['write', table, 'insert', p]); return q; },
      update: () => { writing = true; window.__calls.push(['write', table, 'update']); return q; },
      delete: () => { writing = true; window.__calls.push(['write', table, 'delete']); return q; },
      upsert: p => { writing = true; window.__calls.push(['write', table, 'upsert', p]); return q; },
      select: cols => { window.__selects = [...(window.__selects || []), [table, cols]]; return q; },
      is: col => { isNull = col; return q; },
      eq: () => q,
      order: () => q,
      single: () => res({ data: { display_name: fx().profileName ?? (window.__access?.display_name || 'Sam') }, error: null }),
      then: (ok, bad) =>
        (writing && fx().insertDelay ? new Promise(r => setTimeout(r, fx().insertDelay)) : res())
          .then(() => outcome())
          .then(ok, bad),
    };
    // What a write or a read answers. fx().insertFail maps a race id to
    // { result, once } for an insert on that race; a successful insert is
    // remembered, so the next read of races shows it.
    const outcome = () => {
      if (writing) {
        const fail = payload && fx().insertFail && fx().insertFail[payload.race_id];
        if (fail) {
          if (fail.once) delete fx().insertFail[payload.race_id];
          return fail.result;
        }
        const result = fx().writeResult || { data: [{ id: 1 }], error: null };
        if (payload && !result.error) (window.__added ||= {})[payload.race_id] = { id: 'new-' + payload.race_id, name: payload.name, events: payload.events, level: payload.level, created_by: window.__session?.user.id };
        return result;
      }
      if (table === 'results') return fx().resultsError ? { data: null, error: fx().resultsError } : { data: fx().results || [], error: null };
      if (table === 'races') {
        if (fx().racesError) return { data: null, error: fx().racesError };
        // .is('deleted_at', null) is honoured, so a removed race is not listed.
        const rows = (fx().races || []).filter(r => !isNull || r[isNull] == null);
        return { data: rows.map(r => ({ ...r, entries: r.entries && [...r.entries, ...(window.__added?.[r.id] ? [window.__added[r.id]] : [])] })), error: null };
      }
      return { data: [], error: null };
    };
    return q;
  },
}) };
`;

// hCaptcha's script is replaced: the widget answers at once with a fixed token.
const HCAPTCHA = `window.hcaptcha = {
  render: (slot, opts) => { setTimeout(() => opts.callback('captcha-token-1'), 0); return 1; },
  execute() {},
  remove() {},
};`;

const NAME_CLASH = {
  message: 'Someone at the club already uses that name. Add a surname or initial.',
};
const accessOf = (state, over = {}) => ({
  state,
  display_name: 'Sam Lee',
  password_change_due: false,
  reset_expires_at: null,
  reset_expired: false,
  ...over,
});
const signedIn = (access, metadata = { has_password: true }) => ({
  session: {
    user: { id: 'u1', email: 'sam@example.com', user_metadata: metadata },
    access_token: 't',
  },
  access,
});
const SIGNED_OUT = { session: null, access: null, races: [] };
const withRaces = fx => ({
  races: [
    {
      id: 'r1',
      name: 'Noosa Triathlon',
      date: '2026-11-01',
      location: 'Noosa',
      slug: 'noosa-2026',
      events: [],
      event_type: 'Triathlon',
      club_focus: true,
      entries: [],
    },
  ],
  ...fx,
});

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log('  ok   ' + msg);
  else {
    console.log('  FAIL ' + msg);
    failures++;
  }
};
// onboarding: 'seen' (the default) sets the "Pick your races" flag for the
// stand-in user u1, so the screen stays out of scenarios that are about
// something else; 'fresh' leaves it unset. now: a Date to pin the clock to
// (Date.now and new Date(); timers keep running), for scenarios whose
// fixtures hold dates.
async function open(fx, { width = 1100, storage = {}, onboarding = 'seen', now = null } = {}) {
  if (onboarding === 'seen') storage = { 'balance-onboarding-u1': '1', ...storage };
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (now) await page.clock.setFixedTime(now);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/vendor/supabase-js-*.js', r =>
    r.fulfill({ contentType: 'text/javascript', body: STUB }),
  );
  await page.route('https://js.hcaptcha.com/**', r =>
    r.fulfill({ contentType: 'text/javascript', body: HCAPTCHA }),
  );
  // Fonts are the one thing here that would reach the network.
  await page.route('https://fonts.*/**', r => r.abort());
  await page.addInitScript(f => {
    window.__fixtures = f;
  }, withRaces(fx));
  // localStorage a scenario wants to start with (a flag left by an earlier visit).
  await page.addInitScript(entries => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, storage);
  await page.goto(base + '/');
  await page.waitForFunction(() => !document.querySelector('#raceLoading'));
  return { page, errors };
}
const calls = page => page.evaluate(() => window.__calls);
// The order things were called in: an RPC by its name, anything else by its method.
const order = async page => (await calls(page)).map(c => (c[0] === 'rpc' ? c[1] : c[0]));
const called = async (page, name) => (await calls(page)).filter(c => c[0] === name);
const rpcCalled = async (page, name) => (await calls(page)).filter(c => c[1] === name);
const sheetOpen = page =>
  page.evaluate(() => !document.querySelector('#authSheetBackdrop').classList.contains('hidden'));
const sheetText = page => page.locator('#authSheetBody').innerText();
const text = (page, sel) => page.locator(sel).first().innerText();
const settle = page => page.waitForTimeout(250);
// The sheet is a modal; this is the join form from the nudge.
async function openJoin(page) {
  await page.locator('#authSheetJoinButton').click();
  await page.locator('#auth-email').waitFor();
}
async function fillJoin(page, over = {}) {
  const v = {
    email: '  Sam@Example.com ',
    password: 'maple river swift cloud',
    confirm: 'maple river swift cloud',
    name: 'Sam  Lee',
    note: 'Squad B, invited by Jo',
    ...over,
  };
  await page.locator('#auth-email').fill(v.email);
  await page.locator('#auth-password').fill(v.password);
  await page.locator('#auth-confirm').fill(v.confirm);
  await page.locator('#auth-display-name').fill(v.name);
  await page.locator('#auth-note').fill(v.note);
}
const joinError = page => page.locator('#authSheetBody .auth-sheet-error');

console.log('1. Join happy path (S1, S2, S4, S6, P7)');
{
  const { page, errors } = await open(SIGNED_OUT);
  await openJoin(page);
  await page.locator('#auth-email').fill('  Sam@Example.com ');
  check(
    (await text(page, '#auth-email-echo')) ===
      "We'll use sam@example.com to sign you in. Check it's right, because nothing is emailed to you.",
    'the address is shown back, trimmed and lower-cased, before submit',
  );
  check(
    (await page.locator('#auth-password').getAttribute('autocomplete')) === 'new-password' &&
      (await page.locator('#auth-confirm').getAttribute('autocomplete')) === 'new-password',
    'both password boxes are autocomplete=new-password',
  );
  check(
    (await page.locator('#auth-email').getAttribute('maxlength')) === '254' &&
      (await page.locator('#auth-email').getAttribute('type')) === 'email',
    'the email box is type=email, 254 characters at most',
  );
  check(
    (await page.locator('#auth-note').getAttribute('maxlength')) === '280' &&
      (await page.locator('#authSheetBody').innerText()).includes(
        'How do you know the club? (for example, squad, JustGo number, who invited you)',
      ),
    'the note box allows 280 characters and carries the spec prompt',
  );
  await fillJoin(page);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForFunction(() => window.__calls.some(c => c[1] === 'request_access'));
  await settle(page);
  const signUp = (await called(page, 'signUp'))[0];
  check(signUp[1] === 'sam@example.com', 'signUp gets the trimmed, lower-cased address');
  check(signUp[2] === 'maple river swift cloud'.length, 'signUp gets the password as typed');
  check(signUp[3].captchaToken === 'captcha-token-1', 'signUp carries the hCaptcha token (P7)');
  const request = (await rpcCalled(page, 'request_access'))[0];
  check(
    JSON.stringify(request[2]) ===
      JSON.stringify({ p_display_name: 'Sam Lee', p_note: 'Squad B, invited by Jo' }),
    'request_access gets the cleaned name (spaces collapsed) and the note',
  );
  const names = await order(page);
  check(
    names.indexOf('signUp') < names.indexOf('request_access'),
    'signUp comes before request_access',
  );
  check(!(await sheetOpen(page)), 'the sheet closes');
  check(
    (await text(page, '#memberBanner')) ===
      'Thanks, Sam. Your account is waiting for the club admin to approve it. This usually takes a day or two. You can look at races in the meantime. Nothing is emailed to you, so check back here.',
    'the pending banner uses the spec wording',
  );
  check(await page.locator('#heroAddButton').isDisabled(), 'Add a race is disabled while pending');
  check(
    (await page.locator('#heroAddButton').getAttribute('title')) ===
      (await text(page, '#memberBanner')),
    'and carries the same hint',
  );
  check(
    await page.evaluate(
      () =>
        !JSON.stringify(Object.entries(localStorage)).includes('maple river') &&
        !JSON.stringify(window.__calls).includes('maple river'),
    ),
    'the password text is not in localStorage or in any recorded call',
  );
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await page.close();
}

console.log('2. Duplicate email (S7)');
{
  const { page } = await open({
    ...SIGNED_OUT,
    signUp: { error: { code: 'user_already_exists', message: 'User already registered' } },
  });
  await openJoin(page);
  await fillJoin(page);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await joinError(page).waitFor({ state: 'visible' });
  check(
    (await joinError(page).innerText()) ===
      "There's already an account for this email. Sign in, or ask the club admin to reset your password.",
    'the message is the spec wording',
  );
  check((await rpcCalled(page, 'request_access')).length === 0, 'no request is sent');
  check(await sheetOpen(page), 'the form stays open');
  await page.close();
}

console.log('2b. Duplicate email while Confirm email is still on (fake user, no identities)');
{
  const { page } = await open({
    ...SIGNED_OUT,
    signUp: { noSession: true, user: { id: 'x', identities: [] } },
  });
  await openJoin(page);
  await fillJoin(page);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await joinError(page).waitFor({ state: 'visible' });
  check(
    (await joinError(page).innerText()).startsWith("There's already an account for this email."),
    'the same message appears',
  );
  await page.close();
}

console.log('3. Password rules (P1, P2, P3)');
{
  const { page } = await open(SIGNED_OUT);
  await openJoin(page);
  const attempt = async password => {
    await fillJoin(page, { password, confirm: password });
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.waitForTimeout(150);
  };
  await attempt('elevenchars');
  check(
    (await joinError(page).innerText()) === 'Your password needs at least 12 characters.',
    '11 characters is refused with a clear message',
  );
  check((await called(page, 'signUp')).length === 0, 'and never reaches signUp');
  await attempt('Masterbating');
  check(
    (await joinError(page).innerText()).startsWith('That password is too common.'),
    'a common password is refused, whatever its capitals',
  );
  check((await called(page, 'signUp')).length === 0, 'and never reaches signUp either');
  await attempt('x'.repeat(73));
  check(
    (await joinError(page).innerText()) === 'Your password can be at most 72 characters.',
    '73 characters is refused',
  );
  await fillJoin(page, {
    password: 'maple river swift cloud',
    confirm: 'maple river swift clouds',
  });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForTimeout(150);
  check(
    (await joinError(page).innerText()) === "The two passwords don't match.",
    'two different passwords are caught',
  );
  check(
    await page.evaluate(() => document.activeElement.id === 'auth-confirm'),
    'focus moves to the box that needs fixing',
  );
  // Boundaries that must be accepted: no composition rules.
  await attempt('zqxjkvbnmwpt');
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signUp'));
  check(
    (await called(page, 'signUp'))[0][2] === 12,
    '12 lower-case letters, no capitals or symbols (and not a common password), is accepted',
  );
  await page.close();
}
{
  const { page } = await open(SIGNED_OUT);
  await openJoin(page);
  await fillJoin(page, { password: 'é'.repeat(72), confirm: 'é'.repeat(72) });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForTimeout(150);
  check(
    (await joinError(page).innerText()) === 'Your password can be at most 72 characters.',
    '72 two-byte characters is refused, since bcrypt keeps only 72 bytes',
  );
  await fillJoin(page, { password: 'é'.repeat(36), confirm: 'é'.repeat(36) });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signUp'));
  check(true, '36 two-byte characters (72 bytes) is accepted');
  await page.close();
}

console.log('3b. Passwords: eye toggle, paste');
{
  const { page } = await open(SIGNED_OUT);
  await openJoin(page);
  const toggle = page.locator(
    '#auth-password ~ .password-toggle, .password-input:has(#auth-password) .password-toggle',
  );
  check(
    (await page.locator('#auth-password').getAttribute('type')) === 'password',
    'hidden by default',
  );
  await toggle.first().click();
  check((await page.locator('#auth-password').getAttribute('type')) === 'text', 'the eye shows it');
  check(
    (await toggle.first().getAttribute('aria-pressed')) === 'true' &&
      (await toggle.first().getAttribute('aria-label')) === 'Hide password',
    'the toggle reports its state',
  );
  await toggle.first().click();
  check(
    (await page.locator('#auth-password').getAttribute('type')) === 'password',
    'and hides it again',
  );
  check(
    await page.evaluate(() => {
      const input = document.querySelector('#auth-password');
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      return !ev.defaultPrevented;
    }),
    'paste is not blocked',
  );
  await page.close();
}

console.log('4. Name clash, then fix (S5, S8)');
{
  const { page } = await open({ ...SIGNED_OUT, seq: { requestAccess: [NAME_CLASH] } });
  await openJoin(page);
  await fillJoin(page, { name: 'Sam' });
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.locator('#authSheetBody h2', { hasText: 'Ask to join' }).waitFor();
  check(
    (await joinError(page).innerText()) === NAME_CLASH.message,
    'the server message is shown as written',
  );
  check(
    (await page.locator('#auth-display-name').inputValue()) === 'Sam',
    'the name step keeps what was typed',
  );
  check(await sheetOpen(page), 'the sheet stays open');
  check(
    (await called(page, 'signOut')).length === 0 &&
      (await page.locator('#accountMenuButton').count()) === 1,
    'the person stays signed in',
  );
  check(
    (await text(page, '#memberBanner')).startsWith(
      "You're signed in, but you can't add or edit races yet. Ask to join",
    ),
    'the account is in state none, and the banner says so',
  );
  await page.locator('#auth-display-name').fill('Sam L');
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.waitForFunction(
    () => window.__calls.filter(c => c[1] === 'request_access').length === 2,
  );
  await settle(page);
  const second = (await rpcCalled(page, 'request_access'))[1];
  check(second[2].p_display_name === 'Sam L', 'the fixed name is sent');
  check((await called(page, 'signUp')).length === 1, 'without a second sign-up');
  check(
    !(await sheetOpen(page)) && (await text(page, '#memberBanner')).startsWith('Thanks, Sam.'),
    'then the sheet closes and the pending banner shows',
  );
  await page.close();
}

console.log('4b. Name rules, checked before anything is sent (S4)');
{
  const { page } = await open(SIGNED_OUT);
  await openJoin(page);
  const tryName = async name => {
    await fillJoin(page, { name });
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.waitForTimeout(100);
    return joinError(page).innerText();
  };
  check(
    (await tryName('A')) === 'Your name needs to be 2 to 40 characters.',
    'one letter is too short',
  );
  check(
    (await tryName('x'.repeat(41))) === 'Your name needs to be 2 to 40 characters.',
    '41 characters is too long',
  );
  check(
    (await tryName('Sam 123')).startsWith('Use letters, spaces, apostrophes'),
    'digits are refused',
  );
  check(
    (await tryName("- . '")).startsWith('Use letters') ||
      (await tryName('- . -')).includes('at least one letter'),
    'punctuation alone is refused',
  );
  check((await called(page, 'signUp')).length === 0, 'none of them reach signUp');
  await tryName('Zoë O’Neil-Smith Jr.');
  await page.waitForFunction(() => window.__calls.some(c => c[1] === 'request_access'));
  check(
    (await rpcCalled(page, 'request_access'))[0][2].p_display_name === 'Zoë O’Neil-Smith Jr.',
    'accents, a curly apostrophe, a hyphen and a full stop are accepted',
  );
  await page.close();
}

console.log('5. Pending, and approved (5.3)');
{
  const { page, errors } = await open(
    signedIn(accessOf('pending', { display_name: '<img/src=x/onerror=window.__xss=1> Lee' })),
  );
  check((await sheetOpen(page)) === false, 'no sheet for a pending account');
  check(
    (await text(page, '#memberBanner')).startsWith('Thanks, <img/src=x/onerror=window.__xss=1>.'),
    'a display name is shown as text, never as markup',
  );
  check(await page.evaluate(() => window.__xss === undefined), 'and nothing ran');
  check(await page.locator('#heroAddButton').isDisabled(), 'Add a race is disabled');
  check(errors.length === 0, 'no page errors');
  await page.close();
}
{
  const { page } = await open(signedIn(accessOf('approved')));
  check(
    (await page.locator('#memberBanner').isHidden()) && !(await sheetOpen(page)),
    'an approved member sees no banner and no sheet',
  );
  check(await page.locator('#heroAddButton').isEnabled(), 'and can use Add a race');
  await page.close();
}

console.log('6. Rejected and revoked (5.3)');
for (const [state, message] of [
  [
    'rejected',
    "Your account wasn't approved. If you think that's a mistake, contact the club at mail@balancetriclub.com.",
  ],
  [
    'revoked',
    "Your access has been removed. If you think that's a mistake, contact the club at mail@balancetriclub.com.",
  ],
]) {
  const { page } = await open(signedIn(accessOf(state)));
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
  check(
    (await text(page, '#updateBannerText')) === message,
    `${state}: the message is the spec wording`,
  );
  check(
    await page.locator('#updateBanner').evaluate(n => n.classList.contains('error')),
    `${state}: shown as an error`,
  );
  check((await called(page, 'signOut')).length >= 1, `${state}: signed out`);
  check(
    await page.locator('#signInButton').isVisible(),
    `${state}: the header offers Sign in again`,
  );
  await page.close();
}

console.log('7. Account with no request yet (state none)');
{
  const { page } = await open(signedIn(accessOf('none', { display_name: null })));
  check(await sheetOpen(page), 'the name and note step opens by itself');
  check((await text(page, '#authSheetBody h2')) === 'Ask to join', 'it is titled Ask to join');
  await page.locator('.auth-sheet-cancel').click();
  check(!(await sheetOpen(page)), 'it can be put off');
  await page.getByRole('button', { name: 'Ask to join' }).click();
  check(await sheetOpen(page), 'the banner button brings it back');
  check(
    await page.locator('#heroAddButton').isDisabled(),
    'Save buttons stay disabled until approved',
  );
  await page.close();
}

console.log('8. Forced set-password step after an admin reset (R5)');
{
  const { page } = await open(
    signedIn(
      accessOf('approved', { password_change_due: true, reset_expires_at: '2026-10-19T00:00:00Z' }),
      {},
    ),
  );
  check(await sheetOpen(page), 'the step opens by itself');
  check(
    (await sheetText(page)).includes(
      'Welcome back, Sam. Choose a new password to finish signing in.',
    ),
    'it uses the spec wording',
  );
  check(!(await page.locator('#authSheetClose').isVisible()), 'there is no close button');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  check(await sheetOpen(page), 'Escape and a click outside do not close it');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  check(
    await page.evaluate(() => !!document.activeElement.closest('.auth-sheet')),
    'Tab stays inside it',
  );
  check(
    (await page.locator('#auth-password').getAttribute('autocomplete')) === 'new-password',
    'autocomplete=new-password',
  );
  await page.locator('#auth-password').fill('short');
  await page.locator('#auth-confirm').fill('short');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForTimeout(100);
  check(
    (await joinError(page).innerText()).startsWith('Your password needs at least 12'),
    'a short password is refused',
  );
  await page.locator('#auth-password').fill('Unbelievable');
  await page.locator('#auth-confirm').fill('Unbelievable');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForTimeout(100);
  check(
    (await joinError(page).innerText()).startsWith('That password is too common'),
    'a common one is refused',
  );
  check((await called(page, 'updateUser')).length === 0, 'nothing is saved yet');
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForFunction(() => window.__calls.some(c => c[1] === 'password_changed'));
  await settle(page);
  const names = await order(page);
  check(
    names.indexOf('updateUser') > -1 &&
      names.indexOf('updateUser') < names.indexOf('password_changed'),
    'updateUser, then password_changed',
  );
  check(!(await sheetOpen(page)), 'then the step closes');
  check((await text(page, '#updateBannerText')) === 'Password saved.', 'and says so');
  check((await called(page, 'signOut')).length === 0, 'still signed in');
  await page.close();
}
{
  // password_changed fails after the password is saved: retry must not call updateUser again.
  const { page } = await open({
    ...signedIn(accessOf('approved', { password_change_due: true }), {}),
    seq: { passwordChanged: [{ code: '500', message: 'boom' }] },
  });
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await joinError(page).waitFor({ state: 'visible' });
  check(await sheetOpen(page), 'if the flag could not be cleared, the step stays open');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector('#authSheetBackdrop') ||
      document.querySelector('#authSheetBackdrop').classList.contains('hidden'),
  );
  check(
    (await called(page, 'updateUser')).length === 1,
    'the retry does not set the password twice',
  );
  check(
    (await rpcCalled(page, 'password_changed')).length === 2,
    'it only retries password_changed',
  );
  await page.close();
}
{
  const { page } = await open(signedIn(accessOf('approved', { password_change_due: true }), {}));
  await page.getByRole('button', { name: 'Sign out instead' }).click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
  await settle(page);
  check(!(await sheetOpen(page)), 'Sign out instead leaves the step and signs out');
  await page.close();
}

console.log('9. Expired temporary password (R6)');
{
  const { page } = await open(
    signedIn(
      accessOf('approved', {
        password_change_due: true,
        reset_expired: true,
        reset_expires_at: '2026-10-01T00:00:00Z',
      }),
      {},
    ),
  );
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
  check(
    (await text(page, '#updateBannerText')) ===
      'This temporary password has expired. Ask the club admin for a new one.',
    'the message is the spec wording',
  );
  check(!(await sheetOpen(page)), 'no set-password step is offered');
  await page.close();
}

console.log('10. One-time "set a password" prompt for existing members (E1)');
{
  const { page } = await open(signedIn(accessOf('approved'), {}));
  check(await sheetOpen(page), 'an approved member with no password sees it');
  check(
    (await sheetText(page)).includes('Set a password so you can sign in without an email code.'),
    'with the spec wording',
  );
  await page.locator('.auth-sheet-cancel').click();
  check(!(await sheetOpen(page)), 'Not now closes it');
  // Deliberately the same page and the same localStorage: this is about persistence.
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#raceLoading'));
  await settle(page);
  check(!(await sheetOpen(page)), 'after a reload it does not come back');
  await page.close();
}
{
  const { page } = await open(signedIn(accessOf('approved'), {}));
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'updateUser'));
  await settle(page);
  check(!(await sheetOpen(page)), 'saving a password closes it');
  check(
    (await rpcCalled(page, 'password_changed')).length === 0,
    'and does not touch the reset flag',
  );
  check(
    (await called(page, 'updateUser'))[0][2].has_password === true,
    'it marks the account as having a password',
  );
  await page.close();
}
{
  const { page } = await open(signedIn(accessOf('approved')));
  check(!(await sheetOpen(page)), 'a member who already has a password is not asked');
  await page.close();
}

console.log('11. Password sign-in, and no email code (P4, P7, R1, S9)');
{
  const { page } = await open({
    ...SIGNED_OUT,
    signIn: { error: { code: 'invalid_credentials', message: 'Invalid login credentials' } },
  });
  check(await sheetOpen(page), 'the nudge shows');
  await page.locator('#authSheetSignInButton').click();
  check(
    (await page.locator('#auth-password').getAttribute('autocomplete')) === 'current-password',
    'the password box is autocomplete=current-password',
  );
  check(
    await page.evaluate(() => document.activeElement === document.querySelector('#auth-email')),
    'focus lands in the form',
  );
  check(
    (await sheetText(page)).includes('Forgot your password? Ask the club admin to reset it.') &&
      (await page.locator('#authSheetBody a[href="mailto:mail@balancetriclub.com"]').count()) === 1,
    'the sheet says to ask the club admin, with the club contact (R1)',
  );
  check(
    (await page.getByRole('button', { name: /reset|email me|send link|code/i }).count()) === 0,
    'there is no reset-link or email-code button (R1, S9)',
  );
  await page.locator('#auth-email').fill('Sam@Example.com');
  await page.locator('#auth-password').fill('wrong password here');
  await page.locator('#authSheetBody button[type="submit"]').click();
  await joinError(page).waitFor({ state: 'visible' });
  const attempt = (await called(page, 'signInWithPassword'))[0];
  check(attempt[1] === 'sam@example.com', 'signInWithPassword gets the address');
  check(attempt[3].captchaToken === 'captcha-token-1', 'and the hCaptcha token (P7)');
  check(
    (await joinError(page).innerText()) ===
      "That email and password don't match. Check them and try again.",
    'a wrong password gets a plain message',
  );
  check(
    (await called(page, 'signInWithOtp')).length === 0 &&
      (await called(page, 'verifyOtp')).length === 0,
    'no email-code call was made',
  );
  check(
    (await page.locator('input[autocomplete="one-time-code"]').count()) === 0,
    'no code box exists',
  );
  await page.close();
}
{
  const { page } = await open({
    ...SIGNED_OUT,
    signIn: { access: accessOf('approved'), metadata: { has_password: true } },
  });
  await page.locator('#authSheetSignInButton').click();
  await page.locator('#auth-email').fill('sam@example.com');
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#authSheetBody button[type="submit"]').click();
  await page.waitForSelector('#accountMenuButton');
  await settle(page);
  check(!(await sheetOpen(page)), 'a good password signs in and closes the sheet');
  check(await page.locator('#heroAddButton').isEnabled(), 'an approved member can write');
  await page.close();
}
{
  const { page } = await open({
    ...SIGNED_OUT,
    signIn: { access: accessOf('approved', { password_change_due: true }), metadata: {} },
  });
  await page.locator('#authSheetSignInButton').click();
  await page.locator('#auth-email').fill('sam@example.com');
  await page.locator('#auth-password').fill('maple-river-swift-cloud-47');
  await page.locator('#authSheetBody button[type="submit"]').click();
  await page.locator('#authSheetBody h2', { hasText: 'Set a new password' }).waitFor();
  check(
    !(await page.locator('#authSheetClose').isVisible()),
    'signing in with a temporary password goes straight to the forced step',
  );
  await page.close();
}
{
  const { page } = await open({
    ...SIGNED_OUT,
    signIn: { access: accessOf('rejected'), metadata: {} },
  });
  await page.locator('#authSheetSignInButton').click();
  await page.locator('#auth-email').fill('sam@example.com');
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#authSheetBody button[type="submit"]').click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
  check(
    (await text(page, '#updateBannerText')).startsWith("Your account wasn't approved."),
    'a rejected account signing in gets the message, then is signed out',
  );
  await page.close();
}
{
  // The sheet opened from a write gate, and the join link inside it.
  const { page } = await open(SIGNED_OUT);
  await page.locator('#authSheetBrowseButton').click();
  await page.locator('#signInButton').click();
  await page.getByRole('button', { name: 'Join the club' }).click();
  check(
    (await page.locator('#authSheetBody h2').innerText()) === 'Join the club',
    'Sign in leads to Join',
  );
  check(
    await page.evaluate(() => !!document.activeElement.closest('.auth-sheet')),
    'focus stays in the sheet through the swap',
  );
  await page.locator('#authSheetBody .auth-sheet-link').click();
  check((await page.locator('#authSheetBody h2').innerText()) === 'Sign in', 'and Join leads back');
  await page.close();
}

console.log('12. Account menu and Change password (P8)');
{
  const { page } = await open(signedIn(accessOf('approved')));
  check(await page.locator('#signOutButton').isHidden(), 'Sign out is tucked inside the menu');
  await page.locator('#accountMenuButton').click();
  check(
    (await page.locator('#accountMenuButton').getAttribute('aria-expanded')) === 'true',
    'the button reports it is open',
  );
  await page.keyboard.press('Escape');
  check(await page.locator('#accountMenu').isHidden(), 'Escape closes it');
  check(
    await page.evaluate(() => document.activeElement.id === 'accountMenuButton'),
    'and focus goes back to the button',
  );
  await page.locator('#accountMenuButton').click();
  await page.mouse.click(5, 400);
  check(await page.locator('#accountMenu').isHidden(), 'a tap outside closes it');
  await page.locator('#accountMenuButton').click();
  await page.getByRole('button', { name: 'Change password' }).click();
  check(
    (await text(page, '#authSheetBody h2')) === 'Change password',
    'Change password opens the step',
  );
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'updateUser'));
  await settle(page);
  check(!(await sheetOpen(page)), 'saving closes it');
  check(
    (await rpcCalled(page, 'password_changed')).length === 0,
    'without touching the reset flag',
  );
  await page.locator('#accountMenuButton').click();
  await page.locator('#signOutButton').click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
  check(true, 'Sign out works from the menu');
  await page.close();
}
{
  const { page } = await open({
    ...signedIn(accessOf('approved')),
    seq: {
      updateUser: [
        { code: 'reauthentication_needed', message: 'Password update requires reauthentication' },
      ],
    },
  });
  await page.locator('#accountMenuButton').click();
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await joinError(page).waitFor({ state: 'visible' });
  check(
    (await joinError(page).innerText()).startsWith('For your security, sign out and sign in again'),
    'a recent-sign-in error says what to do',
  );
  await page.close();
}

console.log('13. A database that cannot answer yet');
{
  const { page, errors } = await open({
    ...signedIn(accessOf('approved'), { has_password: true }),
    statusError: { code: 'PGRST202', message: 'Could not find the function' },
  });
  await settle(page);
  check(
    (await page.locator('#heroAddButton').isEnabled()) &&
      !(await sheetOpen(page)) &&
      (await called(page, 'signOut')).length === 0,
    'an approved member is not locked out when my_access_status is missing',
  );
  check(errors.length === 0, 'no page errors');
  await page.close();
}
{
  const { page } = await open({
    ...signedIn(accessOf('none'), { has_password: true }),
    listed: false,
    statusError: { code: 'PGRST202', message: 'Could not find the function' },
  });
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
  check(
    (await text(page, '#updateBannerText')).startsWith(
      'This app is for Balance Tri Club members only',
    ),
    'a non-member on the old database is signed out with the old message',
  );
  await page.close();
}
{
  const { page } = await open({
    ...signedIn(accessOf('none'), { has_password: true }),
    listed: false,
    statusError: { code: '500', message: 'timeout' },
  });
  await settle(page);
  check(
    (await called(page, 'signOut')).length === 0,
    'a failed status check does not sign anyone out',
  );
  check(
    (await text(page, '#memberBanner')).includes("isn't a club member yet") &&
      (await page.locator('#heroAddButton').isDisabled()),
    'it shows the old banner and keeps writes off',
  );
  await page.close();
}

console.log('14. Review round: reauthentication, refused writes, inert page, retries');
{
  // The one-time prompt, where Supabase wants a recent sign-in: never "sign out".
  const { page } = await open({
    ...signedIn(accessOf('approved'), {}),
    seq: {
      updateUser: [
        { code: 'reauthentication_needed', message: 'Password update requires reauthentication' },
      ],
    },
  });
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await joinError(page).waitFor({ state: 'visible' });
  const msg = await joinError(page).innerText();
  check(
    msg ===
      "We couldn't save it from this session. Stay signed in, and ask the club admin for a temporary password if you need one.",
    'prompt + reauthentication_needed: says to stay signed in and ask the admin',
  );
  check(!/sign out|sign in again/i.test(msg), 'and never suggests signing out');
  check((await called(page, 'signOut')).length === 0, 'nobody is signed out');
  check(await sheetOpen(page), 'the prompt stays open');
  check(
    await page.evaluate(() => localStorage.getItem('balance-password-prompt-u1') === null),
    'a failed save does not mark the prompt as seen',
  );
  // Closed some other way than "Not now", then a reload: the prompt returns.
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#raceLoading'));
  await settle(page);
  check(await sheetOpen(page), 'after a reload the prompt comes back');
  check(
    (await sheetText(page)).includes('Set a password so you can sign in without an email code.'),
    'with the same wording',
  );
  await page.close();
}
{
  const { page } = await open(signedIn(accessOf('approved'), {}));
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'updateUser'));
  await settle(page);
  check(
    await page.evaluate(() => localStorage.getItem('balance-password-prompt-u1') === '1'),
    'a successful save marks the prompt as seen',
  );
  await page.close();
}
{
  // A refused write re-reads the member's standing (5.3, T12).
  const { page } = await open({
    ...signedIn(accessOf('approved')),
    writeResult: {
      data: null,
      error: { message: 'new row violates row-level security policy for table "races"' },
    },
  });
  check(await page.locator('#heroAddButton').isEnabled(), 'an approved member can open Add a race');
  await page.evaluate(() => {
    window.__access = { ...window.__access, state: 'revoked' };
  });
  await page.locator('#heroAddButton').click();
  await page.locator('#raceForm input[name="name"]').fill('Noosa 2027');
  await page.locator('#raceForm input[name="date"]').fill('2027-11-01');
  await page.locator('#raceForm .primary-button').click();
  await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
  await settle(page);
  check(
    (await text(page, '#updateBannerText')) ===
      "Your access has been removed. If you think that's a mistake, contact the club at mail@balancetriclub.com.",
    'a revoked member whose save is refused gets the removal message, not a save error',
  );
  check(await page.locator('#signInButton').isVisible(), 'and is signed out at once');
  check(
    await page.locator('#heroAddButton').isEnabled(),
    'signed-out buttons are the ordinary signed-out ones',
  );
  const writesBefore = (await called(page, 'write')).length;
  // Signed out, the Add a race button is hidden (since #109); the header's
  // Sign in button stands in for it and opens the same sheet.
  await page.locator('#signInButton').click();
  check(
    (await sheetOpen(page)) && (await called(page, 'write')).length === writesBefore,
    'Sign in now opens the sign-in sheet and writes nothing',
  );
  await page.close();
}
{
  // Still approved, but the write found zero rows: nothing changes for them.
  const { page } = await open({
    ...signedIn(accessOf('approved')),
    writeResult: { data: [], error: null },
  });
  await page.locator('#heroAddButton').click();
  await page.locator('#raceForm input[name="name"]').fill('Noosa 2027');
  await page.locator('#raceForm input[name="date"]').fill('2027-11-01');
  await page.locator('#raceForm .primary-button').click();
  await settle(page);
  check(
    (await called(page, 'signOut')).length === 0,
    'an approved member with a refused write stays signed in',
  );
  await page.close();
}
{
  // Save on the commitment form follows the account state.
  for (const [state, enabled] of [
    ['pending', false],
    ['approved', true],
  ]) {
    const { page } = await open(signedIn(accessOf(state)));
    await page.locator('.race-summary').first().click();
    await page.locator('.save-button').waitFor({ state: 'attached' });
    check(
      (await page.locator('.save-button').isEnabled()) === enabled,
      `${state}: the commitment Save button is ${enabled ? 'enabled' : 'disabled'}`,
    );
    await page.close();
  }
}
{
  // A password changed, but the flag not cleared last time: retried on load.
  const { page } = await open(
    signedIn(accessOf('approved', { password_change_due: true }), { has_password: true }),
    { storage: { 'balance-pwchanged-u1': '1' } },
  );
  await settle(page);
  check(
    (await rpcCalled(page, 'password_changed')).length === 1,
    'password_changed is retried on load',
  );
  check(!(await sheetOpen(page)), 'so the member is not asked for another new password');
  check(
    await page.evaluate(() => localStorage.getItem('balance-pwchanged-u1') === null),
    'and the reminder is cleared once it works',
  );
  await page.close();
}
{
  const { page } = await open({
    ...signedIn(accessOf('approved', { password_change_due: true }), {}),
    seq: { passwordChanged: [{ code: '500', message: 'boom' }] },
  });
  await page.locator('#auth-password').fill('river maple cloud swift');
  await page.locator('#auth-confirm').fill('river maple cloud swift');
  await page.getByRole('button', { name: 'Save password' }).click();
  await joinError(page).waitFor({ state: 'visible' });
  check(
    await page.evaluate(() => localStorage.getItem('balance-pwchanged-u1') === '1'),
    'a failed password_changed is remembered on the device',
  );
  await page.close();
}
{
  // The page behind the locked step cannot be reached from the keyboard.
  const { page } = await open(signedIn(accessOf('approved', { password_change_due: true }), {}));
  // Start from a control behind the sheet: an inert page won't take focus, so
  // the Tab walk below starts from inside the sheet.
  await page.evaluate(() => document.querySelector('#heroAddButton').focus());
  const outside = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    outside.push(
      await page.evaluate(() => {
        const a = document.activeElement;
        return a === document.body || !!a.closest('.auth-sheet') ? '' : a.id || a.tagName;
      }),
    );
  }
  check(
    outside.every(x => x === ''),
    'Tab from the page never lands on a control behind the forced step',
  );
  check(
    await page.evaluate(() => document.querySelector('main.shell').inert),
    'the page is inert while the sheet is open',
  );
  await page.close();
}
{
  const { page } = await open({ ...SIGNED_OUT });
  await page.locator('#authSheetBrowseButton').click();
  check(
    await page.evaluate(() => !document.querySelector('main.shell').inert),
    'and live again once it closes',
  );
  await page.close();
}
{
  // A failed is_allow_listed call must not lock out someone who is approved.
  const { page } = await open({ ...signedIn(accessOf('approved')), listedError: true });
  await settle(page);
  check(
    (await page.locator('#heroAddButton').isEnabled()) &&
      (await called(page, 'signOut')).length === 0,
    'an approved member survives a failed is_allow_listed',
  );
  await page.close();
}
{
  // Confirm email on: the account exists, nobody is signed in.
  const { page } = await open({
    ...SIGNED_OUT,
    signUp: { noSession: true, user: { id: 'x', identities: [{ id: 'i' }] } },
  });
  await openJoin(page);
  await fillJoin(page);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await joinError(page).waitFor({ state: 'visible' });
  check(
    (await joinError(page).innerText()) ===
      'Check your email to confirm your address, then sign in.',
    'a sign-up with no session and a fresh identity says to check email',
  );
  await page.close();
}
{
  // The common-password list is a real one now.
  const { page } = await open(SIGNED_OUT);
  await openJoin(page);
  for (const password of ['password1234', 'qwertyuiop123', '123456789012']) {
    await fillJoin(page, { password, confirm: password });
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#authSheetBody .auth-sheet-error:not(.hidden)'),
    );
    await page.waitForTimeout(100);
    check(
      (await joinError(page).innerText()).startsWith('That password is too common.'),
      `${password} is refused as too common`,
    );
  }
  check((await called(page, 'signUp')).length === 0, 'none of them reach signUp');
  await page.close();
}

console.log('15. Looks (screenshots in $SCREENSHOT_DIR or /tmp), small and large screens');
for (const width of [375, 1100]) {
  const dir = process.env.SCREENSHOT_DIR || '/tmp';
  const shot = (page, name) => page.screenshot({ path: `${dir}/app-${name}-${width}.png` });
  const noSideScroll = page =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  {
    const { page } = await open(SIGNED_OUT, { width });
    await shot(page, 'nudge');
    await page.locator('#authSheetSignInButton').click();
    await shot(page, 'signin');
    check(await noSideScroll(page), `${width}px: the sign-in form does not overflow sideways`);
    await page.locator('#authSheetBody .auth-sheet-link').click();
    await shot(page, 'join');
    check(await noSideScroll(page), `${width}px: the join form does not overflow sideways`);
    await page.close();
  }
  {
    const { page } = await open(signedIn(accessOf('approved', { password_change_due: true }), {}));
    await page.setViewportSize({ width, height: 900 });
    await shot(page, 'forced');
    await page.close();
  }
  {
    const { page } = await open(signedIn(accessOf('pending')), { width });
    await page.locator('#accountMenuButton').click();
    await shot(page, 'pending-menu');
    check(await noSideScroll(page), `${width}px: the header with the account menu fits`);
    await page.close();
  }
}

console.log('16. Visitors see counts only; approved members see full names');
{
  const full = [
    { name: 'Sam Lee', events: [], level: 'locked' },
    { name: 'Jo van der Berg', events: [], level: 'considering' },
  ];
  const races = [{ ...withRaces({}).races[0], entries: full }];
  const publicCounts = [{ race_id: 'r1', committed: 2, locked: 1 }];
  // The old function, for a database without public_race_counts yet.
  const publicEntries = [
    { race_id: 'r1', name: 'Sam', events: [], level: 'locked' },
    { race_id: 'r1', name: 'Jo', events: [], level: 'considering' },
  ];
  const openRace = async page => {
    // A visitor first gets the sign-in nudge; close it to reach the calendar.
    if (await page.locator('#authSheetBackdrop').isVisible()) await page.keyboard.press('Escape');
    const meta = await page.locator('.race-meta').first().innerText();
    const search = await page.locator('#athleteFilter').isVisible();
    await page.locator('.race-summary').first().click();
    await page.locator('#raceScreenBody .roster-body').waitFor();
    return { meta, search };
  };
  for (const [label, fx, extra] of [
    ['a visitor', { session: null, access: null }, { publicCounts }],
    ['a visitor (older database)', { session: null, access: null }, { publicEntries }],
    ['a pending account', signedIn(accessOf('pending')), { publicCounts }],
  ]) {
    const { page, errors } = await open({ ...fx, races, ...extra });
    const { meta, search } = await openRace(page);
    check(meta.includes('1 locked in of 2'), `${label}: the race card shows the counts`);
    check(!search, `${label}: no name search`);
    check((await page.locator('.roster-name').count()) === 0, `${label}: no roster names`);
    const body = await page.locator('#raceScreenBody').textContent();
    check(
      !body.includes('Sam') && !body.includes('Jo '),
      `${label}: no name anywhere on the race page`,
    );
    check(body.includes('2 members going'), `${label}: the race page shows the count`);
    const stored = await page.evaluate(() =>
      JSON.stringify(typeof races === 'undefined' ? '' : races),
    );
    check(!stored.includes('Sam'), `${label}: no name kept in page memory`);
    const calls = await page.evaluate(() => window.__calls);
    check(
      !(await page.evaluate(() => window.__selects || [])).some(
        ([table, cols]) => table === 'entries' || String(cols).includes('entries'),
      ),
      `${label}: the entries table is never asked for`,
    );
    if (extra.publicCounts)
      check(
        !calls.some(c => c[0] === 'rpc' && c[1] === 'public_entries'),
        `${label}: never asks for public_entries`,
      );
    check(
      errors.length === 0,
      `${label}: no page errors` + (errors.length ? ': ' + errors.join('; ') : ''),
    );
    await page.close();
  }
  {
    const { page, errors } = await open({
      ...signedIn(accessOf('approved')),
      races,
      publicCounts,
    });
    await openRace(page);
    await page.locator('.roster-name').first().waitFor();
    const names = (await page.locator('.roster-name').allTextContents()).sort();
    check(
      JSON.stringify(names) === JSON.stringify(['Jo van der Berg', 'Sam Lee']),
      'an approved member sees full names',
    );
    check(errors.length === 0, 'an approved member: no page errors');
    await page.close();
  }
}

console.log('17. App feedback: the footer form (keyboard, errors, no lost text, sent state)');
{
  // The send-feedback Edge Function is replaced: each scenario says what
  // "send" answers, in order. Every request body is recorded.
  const feedbackPage = async (sendAnswers, opts) => {
    const { page, errors } = await open(SIGNED_OUT, opts);
    const seen = [];
    const answers = [...sendAnswers];
    await page.route('**/functions/v1/send-feedback', async r => {
      const body = JSON.parse(r.request().postData() || '{}');
      seen.push({ body, headers: r.request().headers() });
      if (body.action === 'start') return r.fulfill({ json: { form_token: '1.abc' } });
      const [status, json] = answers.shift() || [200, { sent: true }];
      return r.fulfill({ status, json });
    });
    // A visitor first gets the sign-in nudge; close it to reach the page.
    if (await page.locator('#authSheetBackdrop').isVisible()) await page.keyboard.press('Escape');
    // Every message written into the alert region, so a check can see what
    // was announced even after it is replaced.
    await page.evaluate(() => {
      window.__alerts = [];
      new MutationObserver(() => {
        const t = document.querySelector('#feedbackStatus').textContent;
        if (t) window.__alerts.push(t);
      }).observe(document.querySelector('#feedbackStatus'), { childList: true, subtree: true });
    });
    return { page, errors, seen };
  };
  const sends = seen => seen.filter(s => s.body.action === 'send');

  // a. Fresh page, empty sessionStorage. Opening, a too-short message, a
  // server failure that keeps the text, then a retry that works.
  {
    const { page, errors, seen } = await feedbackPage([[502, { error: 'mail_failed' }]]);
    const footerAfterList = await page.evaluate(
      () =>
        !!(
          document
            .querySelector('#raceList')
            .compareDocumentPosition(document.querySelector('.app-footer')) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    );
    check(footerAfterList, 'the feedback footer sits after the race list');
    const btn = page.locator('#feedbackButton');
    check((await btn.getAttribute('aria-expanded')) === 'false', 'the button starts collapsed');
    await btn.focus();
    await page.keyboard.press('Enter');
    await page.locator('#feedbackPanel').waitFor({ state: 'visible' });
    check(
      (await btn.getAttribute('aria-expanded')) === 'true',
      'Enter opens it: aria-expanded=true',
    );
    check(
      await page.evaluate(() => document.activeElement.id === 'feedbackMessage'),
      'focus moves to the feedback box',
    );
    check(
      (await page.locator('#feedbackWebsite').getAttribute('tabindex')) === '-1' &&
        (await page.locator('.feedback-trap').getAttribute('aria-hidden')) === 'true',
      'the honeypot is out of the tab order and hidden from screen readers',
    );
    await settle(page);
    check(
      seen.some(s => s.body.action === 'start'),
      'opening asks the server for a form token',
    );

    await page.keyboard.type('hi');
    await page.locator('#feedbackSend').click();
    check(
      (await text(page, '#feedbackStatus')).startsWith('Write a little more'),
      'a too-short message is refused in the form',
    );
    check(
      (await page.locator('#feedbackMessage').getAttribute('aria-invalid')) === 'true' &&
        (await page.evaluate(() => document.activeElement.id)) === 'feedbackMessage',
      'the box is marked invalid and keeps focus',
    );
    check(sends(seen).length === 0, 'nothing is sent for a too-short message');

    const words = 'The filter forgets my athlete when I open a race.\nSecond line stays.';
    await page.locator('#feedbackMessage').fill(words);
    await page.locator('#feedbackContact').fill('Sam');
    check(
      (await text(page, '#feedbackCount')) === `${words.length} of 2,000 characters`,
      'the counter follows the text',
    );
    await page.locator('#feedbackSend').click();
    await page.waitForFunction(() => window.__alerts.some(a => a.includes('still here')), null, {
      timeout: 15000,
    });
    check(
      (await page.locator('#feedbackMessage').inputValue()) === words &&
        (await page.locator('#feedbackContact').inputValue()) === 'Sam',
      'a failed send keeps every word typed',
    );
    check(
      (await page.evaluate(() => window.__alerts)).some(a =>
        a.startsWith("We couldn't send it just now"),
      ),
      'the failure is announced in the alert region',
    );
    check(
      !(await page.locator('#feedbackSend').isDisabled()) &&
        (await text(page, '#feedbackSend')) === 'Send',
      'the Send button comes back after a failure',
    );
    const first = sends(seen)[0];
    check(
      first.body.captcha_token === 'captcha-token-1' &&
        first.body.form_token === '1.abc' &&
        first.body.website === '' &&
        first.body.message === words.trim() &&
        first.body.page === '/',
      'the send carries the hCaptcha token, the form token, an empty honeypot and the text',
    );
    check(
      seen.every(s => Object.keys(s.body).every(k => !/^(to|recipient|email)$/i.test(k))),
      'no request carries a recipient field: the address lives only on the server',
    );

    await page.locator('#feedbackSend').click();
    await page.locator('#feedbackDone').waitFor({ state: 'visible', timeout: 15000 });
    check(
      (await page.evaluate(() => document.activeElement.id)) === 'feedbackDoneTitle',
      'after sending, focus moves to the thank-you message',
    );
    check(
      (await page.evaluate(() => sessionStorage.getItem('balance-feedback-draft'))) === null,
      'the saved draft is cleared once the server says it was sent',
    );
    await page.locator('#feedbackDoneClose').click();
    check(
      (await page.evaluate(() => document.activeElement.id)) === 'feedbackButton' &&
        (await btn.getAttribute('aria-expanded')) === 'false',
      'Done collapses the panel and returns focus to the button',
    );
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
    await page.close();
  }

  // b. Fresh page. Escape collapses without losing text, and a reload in
  // the same tab brings the draft back (sessionStorage, same context).
  {
    const { page, errors } = await feedbackPage([]);
    await page.locator('#feedbackButton').click();
    await page.locator('#feedbackMessage').fill('Half-written thought about the countdown');
    await page.keyboard.press('Escape');
    check(await page.locator('#feedbackPanel').isHidden(), 'Escape collapses the panel');
    check(
      (await page.evaluate(() => document.activeElement.id)) === 'feedbackButton',
      'focus goes back to the button',
    );
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#raceLoading'));
    if (await page.locator('#authSheetBackdrop').isVisible()) await page.keyboard.press('Escape');
    await page.locator('#feedbackButton').click();
    check(
      (await page.locator('#feedbackMessage').inputValue()) ===
        'Half-written thought about the countdown',
      'a reload in the same tab restores the draft',
    );
    check(errors.length === 0, 'no page errors after reload');
    await page.close();
  }

  // c. Fresh page, phone width. Server-side refusals reach the member in plain words.
  {
    const { page, errors, seen } = await feedbackPage([[429, { error: 'rate_limited' }]], {
      width: 390,
    });
    const box = await page.locator('#feedbackButton').boundingBox();
    check(box.height >= 44 && box.width > 300, 'on a phone the button is full width and 44px tall');
    await page.locator('#feedbackButton').click();
    await page.locator('#feedbackMessage').fill('Rate limit me please, thanks.');
    await page.locator('#feedbackSend').click();
    await page.waitForFunction(() => window.__alerts.length > 0, null, { timeout: 15000 });
    check(
      (await text(page, '#feedbackStatus')).startsWith("You've sent a few messages"),
      'a rate-limit refusal is explained',
    );
    check(sends(seen).length === 1, 'one send attempt');
    await page.screenshot({
      path: `${process.env.SCREENSHOT_DIR || '/tmp'}/feedback-390.png`,
      fullPage: true,
    });
    check(errors.length === 0, 'no page errors at phone width');
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Results on past races. Approved members see "Club results" and can save a
// result on their own row; everyone else sees the race screen as before and
// is never sent a result.
// ---------------------------------------------------------------------------
{
  console.log('\nresults on past races');
  const PAST = {
    id: 'rp',
    name: 'Manly Sprint',
    date: '2026-09-20',
    location: 'Manly',
    slug: 'manly-2026',
    events: ['Sprint'],
    event_type: 'Triathlon',
    club_focus: true,
    entries: [
      { id: 'e1', name: 'Sam Lee', events: ['Sprint'], level: 'locked', created_by: 'u1' },
      { id: 'e2', name: 'Alex Kim', events: ['Sprint'], level: 'locked', created_by: null },
      { id: 'e3', name: 'Jo Park', events: ['Sprint'], level: 'locked', created_by: null },
    ],
  };
  const RESULTS = [
    {
      entry_id: 'e2',
      status: 'finished',
      finish_seconds: 4500,
      place_overall: 12,
      place_age_group: 3,
      is_pb: true,
      note: 'Hot day, strong run',
    },
    {
      entry_id: 'e3',
      status: 'dnf',
      finish_seconds: null,
      place_overall: null,
      place_age_group: null,
      is_pb: false,
      note: null,
    },
  ];
  const pastView = JSON.stringify({
    user: '',
    filter: '',
    form: {},
    whenFilter: 'past',
    viewFilter: 'all',
  });
  const openPast = async (fx, opts = {}) => {
    const { page, errors } = await open(
      { races: [PAST], results: RESULTS, ...fx },
      { storage: { 'balance-race-ui': pastView }, ...opts },
    );
    // A signed-out visitor is greeted by the sign-in sheet; set it aside.
    if (await page.locator('#authSheetBackdrop').isVisible()) await page.keyboard.press('Escape');
    await page.locator('.race-summary').first().click();
    await page.locator('#raceScreenBody .details-card').waitFor();
    return { page, errors };
  };
  const reads = page => page.evaluate(() => window.__reads);
  const approved = signedIn(accessOf('approved'));

  // a. An approved member, on a laptop.
  {
    const { page, errors } = await openPast(approved);
    const body = '#raceScreenBody';
    check(
      (await page.locator(body).textContent()).includes('Club results'),
      'the card is headed Club results',
    );
    const names = await page.locator(`${body} .roster-name`).allInnerTexts();
    check(
      names.join(',') === 'Alex Kim,Jo Park,Sam Lee',
      'finishers first, then DNF, then no result: ' + names.join(','),
    );
    const alex = await page.locator(`${body} .result-entry`).first().innerText();
    check(
      alex.includes('1:15:00') && alex.includes('Overall 12') && alex.includes('Age group 3'),
      'a finished row shows time and places',
    );
    check(
      alex.includes('PB') && alex.includes('Hot day, strong run'),
      'it shows the PB chip and the note',
    );
    check(
      (await page.locator(`${body} .result-entry`).nth(1).innerText()).includes('DNF'),
      'a DNF row says DNF',
    );
    const buttons = await page.locator(`${body} .result-edit`).all();
    check(buttons.length === 1, 'only one row offers a result button (not Alex or Jo)');
    check(
      (await buttons[0].getAttribute('aria-label')).includes('Sam Lee'),
      "the button is on the member's own row and names them",
    );
    check(
      (await page.locator('.race-meta').first().innerText()).includes('2 results'),
      'the Past list counts the results',
    );

    // The form: a bad time is refused where it is typed, with no write.
    await buttons[0].click();
    await page.locator('#result-time').waitFor();
    // The app moves focus on a timer once the form is on the page.
    const focusedTime = await page
      .waitForFunction(() => document.activeElement?.id === 'result-time', null, { timeout: 2000 })
      .then(
        () => true,
        () => false,
      );
    check(focusedTime, 'focus lands on the time field');
    await page.locator('#result-time').fill('abc');
    await page.locator('.result-form button[type=submit]').click();
    check(
      (await text(page, '.result-error')).startsWith('Enter the time as h:mm:ss'),
      'a bad time gets a plain message',
    );
    check((await called(page, 'write')).length === 0, 'and nothing is written');
    check(
      (await page.evaluate(() => document.activeElement.id)) === 'result-time',
      'focus stays on the field to fix',
    );
    await page.locator('#result-time').fill('1:30:00');
    await page.locator('#result-overall').fill('5');
    await page.locator('.result-pb-check input').check();
    await page.locator('#result-note').fill('Windy swim');
    await page.locator('.result-form button[type=submit]').click();
    await page.waitForFunction(
      () => document.querySelector('#updateBannerText')?.textContent === 'Result saved.',
    );
    const writes = await called(page, 'write');
    const upsert = writes.find(c => c[1] === 'results' && c[2] === 'upsert');
    check(!!upsert, 'a save is an upsert on results');
    check(
      upsert?.[3].entry_id === 'e1' &&
        upsert[3].status === 'finished' &&
        upsert[3].finish_seconds === 5400 &&
        upsert[3].place_overall === 5 &&
        upsert[3].place_age_group === null &&
        upsert[3].is_pb === true &&
        upsert[3].note === 'Windy swim',
      'with the right fields: ' + JSON.stringify(upsert?.[3]),
    );
    check(
      (await page.locator('.result-form').count()) === 0,
      'the form closes once the result is saved',
    );
    // The app sets this focus in a setTimeout(0) after the render that shows
    // the banner, so wait for it rather than read it in the same instant.
    await page
      .waitForFunction(() => document.activeElement.className.includes('result-edit'))
      .catch(() => {});
    check(
      (await page.evaluate(() => document.activeElement.className)).includes('result-edit'),
      'focus returns to the row button',
    );

    // DNF: no time or places are sent.
    await page.locator(`${body} .result-edit`).click();
    await page.locator('.result-form').waitFor();
    await page.getByRole('button', { name: 'DNF', exact: true }).click();
    check(await page.locator('#result-time').isHidden(), 'DNF hides the time field');
    await page.locator('.result-form button[type=submit]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('#updateBannerText')?.textContent === 'Result saved.' &&
        !document.querySelector('.result-form'),
    );
    const dnf = (await called(page, 'write')).filter(c => c[2] === 'upsert')[1]?.[3];
    check(
      dnf?.status === 'dnf' &&
        dnf.finish_seconds === null &&
        dnf.place_overall === null &&
        dnf.is_pb === false,
      'a DNF sends no time, places or PB: ' + JSON.stringify(dnf),
    );
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
    await page.close();
  }

  // b. A phone.
  {
    const { page, errors } = await openPast(approved, { width: 390 });
    await page.locator('#raceScreenBody .result-edit').click();
    await page.locator('.result-form').waitFor();
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    check(!over, 'no sideways scroll at 390px');
    const tall = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.result-form input[type=text], .result-form textarea, .result-form button, .result-edit',
        ),
      ]
        .filter(el => el.offsetParent)
        .every(el => el.getBoundingClientRect().height >= 44 - 0.5),
    );
    check(tall, 'every form control is at least 44px tall');
    await page.screenshot({
      path: `${process.env.SCREENSHOT_DIR || '/tmp'}/results-390.png`,
      fullPage: true,
    });
    check(errors.length === 0, 'no page errors at phone width');
    await page.close();
  }

  // c. A member who raced but never committed.
  {
    const noSam = { ...PAST, entries: PAST.entries.slice(1) };
    const { page } = await openPast({ ...approved, races: [noSam] });
    const raced = page.getByRole('button', { name: 'I raced this' });
    check(await raced.isVisible(), 'a member with no entry is offered "I raced this"');
    await raced.click();
    await page.waitForFunction(() =>
      window.__calls.some(c => c[0] === 'write' && c[1] === 'entries'),
    );
    const insert = (await called(page, 'write')).find(c => c[1] === 'entries');
    check(insert?.[2] === 'insert', 'it adds the member to the roster first');
    await page.close();
  }

  // d. Visitors and unapproved accounts are never sent results.
  for (const [label, fx] of [
    ['a signed-out visitor', { session: null, access: null }],
    ['a member waiting for approval', signedIn(accessOf('pending'))],
  ]) {
    const { page, errors } = await openPast({
      ...fx,
      publicEntries: PAST.entries.map(e => ({
        race_id: 'rp',
        name: e.name.split(' ')[0],
        events: e.events,
        level: e.level,
      })),
    });
    const bodyText = await page.locator('#raceScreenBody').textContent();
    check(
      bodyText.includes('Club commitments') && !bodyText.includes('Club results'),
      `${label}: commitments, not results`,
    );
    check(
      !(await reads(page)).includes('results'),
      `${label}: the results table is never asked for`,
    );
    check(
      !bodyText.includes('1:15:00') &&
        !bodyText.includes('Hot day') &&
        !bodyText.includes('Result'),
      `${label}: no result text anywhere`,
    );
    check(
      !(await page.locator('.race-meta').first().innerText()).includes('result'),
      `${label}: the Past list line is unchanged`,
    );
    check((await page.locator('.result-edit').count()) === 0, `${label}: no result buttons`);
    check(errors.length === 0, `${label}: no page errors`);
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// "How did it go?" reminder. An approved member locked in on a race in the
// last 14 days, with no result yet, gets one card on the home screen.
// ---------------------------------------------------------------------------
{
  console.log('\nresult reminder');
  const sydney = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);
  const daysAgo = n => sydney(new Date(Date.now() - n * 86400000));
  const race = (id, name, date, entries) => ({
    id,
    name,
    date,
    location: 'Sydney',
    slug: id,
    events: ['Sprint'],
    event_type: 'Triathlon',
    club_focus: true,
    entries,
  });
  const mine = (id, over = {}) => ({
    id,
    name: 'Sam Lee',
    events: ['Sprint'],
    level: 'locked',
    created_by: 'u1',
    ...over,
  });
  const approved = signedIn(accessOf('approved'));
  const card = '#resultReminder';

  // a. The card, its words, and what each button does.
  {
    const fx = {
      ...approved,
      races: [
        race('old', 'Old Sprint', daysAgo(40), [mine('eo')]),
        race('mid', 'Manly Sprint', daysAgo(9), [mine('em')]),
        race('new', 'Coogee Sprint', daysAgo(3), [mine('en')]),
      ],
    };
    const { page, errors } = await open(fx);
    check(await page.locator(card).isVisible(), 'a recent race with no result shows the card');
    check(
      (await text(page, '#resultReminderTitle')) === 'How did Coogee Sprint go?',
      'it names the most recent race, not the older one',
    );
    check(
      (await page.locator(card + ' button').count()) === 3,
      'it offers Add my time, I didn’t start and Later',
    );
    // Later: the next race takes its place, then the card goes.
    await page.locator('#resultReminderLater').click();
    check(
      (await text(page, '#resultReminderTitle')) === 'How did Manly Sprint go?',
      'Later brings up the next recent race',
    );
    await page.locator('#resultReminderLater').click();
    check(
      await page.locator(card).isHidden(),
      'and then the card goes (the 40-day-old race is too old)',
    );
    const kept = await page.evaluate(
      () => JSON.parse(localStorage.getItem('balance-race-ui')).dismissedReminders,
    );
    check(
      kept.length === 2 && kept.includes('new') && kept.includes('mid'),
      'Later is remembered on this device: ' + JSON.stringify(kept),
    );
    check(
      (await page.evaluate(() => document.activeElement.id)) === 'raceList',
      'focus settles on the race list when the card goes',
    );
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#raceLoading'));
    check(await page.locator(card).isHidden(), 'it stays hidden after a reload');
    check((await called(page, 'write')).length === 0, 'Later writes nothing');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
    await page.close();
  }

  // b. I didn't start saves a DNS.
  {
    const { page } = await open({
      ...approved,
      races: [race('new', 'Coogee Sprint', daysAgo(3), [mine('en')])],
    });
    await page.locator('#resultReminderDns').click();
    await page.waitForFunction(() =>
      window.__calls.some(c => c[0] === 'write' && c[1] === 'results'),
    );
    const w = (await called(page, 'write')).find(c => c[1] === 'results');
    check(
      w?.[2] === 'upsert' &&
        w[3].entry_id === 'en' &&
        w[3].status === 'dns' &&
        w[3].finish_seconds === null &&
        w[3].is_pb === false,
      'it saves a DNS with no time: ' + JSON.stringify(w?.[3]),
    );
    await page.close();
  }

  // c. Add my time opens the race with the form ready.
  {
    const { page } = await open({
      ...approved,
      races: [race('new', 'Coogee Sprint', daysAgo(3), [mine('en')])],
    });
    await page.locator('#resultReminderAdd').click();
    await page.locator('#result-time').waitFor();
    check(
      (await text(page, '#raceScreenTitle')) === 'Coogee Sprint',
      'it opens the race screen for that race',
    );
    await page.waitForFunction(() => document.activeElement?.id === 'result-time', null, {
      timeout: 2000,
    });
    check(true, 'with the result form open and focus on the time field');
    check(await page.locator(card).isHidden(), 'the card is not shown over the race screen');
    await page.close();
  }

  // d. Who does not get it.
  const none = [
    [
      'an entry that already has a result',
      {
        races: [race('r', 'Done Sprint', daysAgo(3), [mine('e1')])],
        results: [
          {
            entry_id: 'e1',
            status: 'finished',
            finish_seconds: 3000,
            place_overall: null,
            place_age_group: null,
            is_pb: false,
            note: null,
          },
        ],
      },
    ],
    [
      "someone else's entry",
      {
        races: [
          race('r', 'Other Sprint', daysAgo(3), [
            mine('e1', { created_by: 'u9', name: 'Alex Kim' }),
          ]),
        ],
      },
    ],
    [
      'an entry that is only "considering"',
      { races: [race('r', 'Maybe Sprint', daysAgo(3), [mine('e1', { level: 'considering' })])] },
    ],
    [
      'a race that has not finished yet (today)',
      { races: [race('r', 'Today Sprint', daysAgo(0), [mine('e1')])] },
    ],
    [
      'a Balance Bolt race',
      { races: [{ ...race('r', 'Bolt', daysAgo(3), [mine('e1')]), event_type: 'Balance Bolt' }] },
    ],
    [
      'a failed read of the results table',
      {
        races: [race('r', 'Unread Sprint', daysAgo(3), [mine('e1')])],
        resultsError: { code: 'PGRST205', message: 'no such table' },
      },
    ],
    [
      'a signed-out visitor',
      { session: null, access: null, races: [race('r', 'Public Sprint', daysAgo(3), [])] },
    ],
    [
      'a member waiting for approval',
      { ...signedIn(accessOf('pending')), races: [race('r', 'Wait Sprint', daysAgo(3), [])] },
    ],
  ];
  for (const [label, fx] of none) {
    const { page, errors } = await open({ ...approved, ...fx });
    check(await page.locator(card).isHidden(), `no card for ${label}`);
    check(errors.length === 0, `no page errors for ${label}`);
    await page.close();
  }

  // e. A phone.
  {
    const { page } = await open(
      {
        ...approved,
        races: [race('new', 'Coogee Triathlon Festival Sprint', daysAgo(3), [mine('en')])],
      },
      { width: 390 },
    );
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    check(!over, 'no sideways scroll at 390px');
    const tall = await page.evaluate(() =>
      [...document.querySelectorAll('#resultReminder button')].every(
        b => b.getBoundingClientRect().height >= 43.5,
      ),
    );
    check(tall, 'all three buttons are at least 44px tall');
    await page.screenshot({
      path: `${process.env.SCREENSHOT_DIR || '/tmp'}/reminder-390.png`,
      fullPage: false,
    });
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Owner-only commitments, "Pick your races", and mixed-alphabet names
// (migration restrict_entry_writes_to_owners). Every scenario below opens its
// own page, which is its own browser context: empty localStorage, a full load.
// The "shown once" scenario reloads the same page on purpose, to test the
// flag. The clock is pinned to 20 October 2026, 11:00 in Sydney.
// ---------------------------------------------------------------------------
{
  console.log('\nowner-only commitments, Pick your races, mixed alphabets');
  const NOW = new Date('2026-10-20T00:00:00Z');
  const rc = (id, name, date, over = {}) => ({
    id,
    name,
    date,
    location: 'Sydney',
    slug: `${id}-slug`,
    events: ['Sprint'],
    event_type: 'Triathlon',
    club_focus: true,
    entries: [],
    ...over,
  });
  const ent = (id, name, over = {}) => ({
    id,
    name,
    events: ['Sprint'],
    level: 'considering',
    created_by: 'u9',
    ...over,
  });
  const fresh = (fx, o = {}) => open(fx, { onboarding: 'fresh', now: NOW, ...o });
  const labels = page => page.locator('#authSheetBody .onboarding-races label').allInnerTexts();
  const flag = page => page.evaluate(() => localStorage.getItem('balance-onboarding-u1'));
  const member = signedIn(accessOf('approved'));
  const ONB_RACES = [
    rc('bravo', 'Bravo Swim', '2026-11-15'),
    rc('alpha', 'Alpha Run', '2026-10-27'),
    rc('today', 'Today Tri', '2026-10-20'),
    rc('past', 'Past Duathlon', '2026-10-01'),
    rc('bolt', 'Bolt Night', '2026-11-02', { event_type: 'Balance Bolt', balance_bolt: true }),
    rc('boltcol', 'Bolt Column', '2026-11-03', { balance_bolt: true }),
    rc('gone', 'Removed Race', '2026-11-04', { deleted_at: '2026-10-10T00:00:00Z' }),
  ];
  const sheetUp = page => page.locator('#authSheetBackdrop').isVisible();
  const onbOpen = async page =>
    (await sheetUp(page)) &&
    (await page.locator('#authSheetBody h2').count()) > 0 &&
    (await text(page, '#authSheetBody h2')) === 'Pick your races';
  const insertsOf = async page =>
    (await called(page, 'write')).filter(c => c[1] === 'entries' && c[2] === 'insert');
  // True if the locator shows within 4 seconds, false if not (never throws).
  const within = loc =>
    loc.waitFor({ timeout: 4000 }).then(
      () => true,
      () => false,
    );
  const menuPick = async page => {
    await page.locator('#accountMenuButton').click();
    await page.locator('#pickRacesButton').click();
  };

  console.log('a. Pick your races opens by itself, with the right races (AC 13, 14, 21, 22)');
  {
    const { page, errors } = await fresh({ ...member, races: ONB_RACES });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    const got = await labels(page);
    check(
      got.length === 2 && got[0].startsWith('Alpha Run') && got[1].startsWith('Bravo Swim'),
      'only Alpha Run and Bravo Swim, soonest first: ' + JSON.stringify(got),
    );
    check(
      got[0].includes('27 Oct 2026') && got[1].includes('15 Nov 2026'),
      'each is labelled with its date',
    );
    check(
      !got.join('|').match(/Today|Past|Bolt|Removed/),
      'today, past, Balance Bolt (by type and by column) and removed races are not offered',
    );
    check(
      (await page.locator('#authSheetBody .onboarding-races input:checked').count()) === 0,
      'none is ticked to start',
    );
    check(
      await page.locator('#authSheetBody .primary-button').isDisabled(),
      'Save is off until one is ticked',
    );
    check(
      (await sheetText(page)).includes('Commitments will use your name: Sam Lee'),
      'it says whose name commitments will carry',
    );
    const link = page.getByRole('link', { name: 'Not you? Tell an admin' });
    check(
      (await link.getAttribute('href')) === 'mailto:mail@balancetriclub.com',
      'Not you? links to the club email',
    );
    const dialog = page.getByRole('dialog', { name: 'Pick your races' });
    check((await dialog.count()) === 1, 'it is a dialog labelled Pick your races');
    check(
      await page.evaluate(() =>
        document.querySelector('.auth-sheet').contains(document.activeElement),
      ),
      'focus is inside it',
    );
    check((await flag(page)) === '1', 'the flag is written when it is shown');
    check((await insertsOf(page)).length === 0, 'showing it writes nothing');
    await page.keyboard.press('Escape');
    check(!(await sheetUp(page)), 'Escape closes it');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
    await page.close();
  }

  console.log('b. It stays shut when a condition fails (AC 13)');
  {
    const cases = [
      ['a visitor', { ...SIGNED_OUT, races: ONB_RACES }, {}],
      ['a pending account', { ...signedIn(accessOf('pending')), races: ONB_RACES }, {}],
      [
        'an account with no request',
        { ...signedIn(accessOf('none')), races: ONB_RACES },
        { nameStep: true },
      ],
      ['a revoked account', { ...signedIn(accessOf('revoked')), races: ONB_RACES }, {}],
      ['a rejected account', { ...signedIn(accessOf('rejected')), races: ONB_RACES }, {}],
      [
        'a member who already has a commitment',
        {
          ...member,
          races: [
            ...ONB_RACES,
            rc('mine', 'Mine Race', '2026-12-01', {
              entries: [ent('m1', 'Sam Lee', { created_by: 'u1' })],
            }),
          ],
        },
        {},
      ],
      ['a member with no upcoming race', { ...member, races: [ONB_RACES[2], ONB_RACES[3]] }, {}],
      [
        'a member who has seen it',
        { ...member, races: ONB_RACES },
        { storage: { 'balance-onboarding-u1': '1' } },
      ],
      ['a member with no profile name', { ...member, profileName: '', races: ONB_RACES }, {}],
      [
        'a member whose races failed to load',
        { ...member, racesError: { message: 'down' }, races: ONB_RACES },
        {},
      ],
      [
        'a member told to set a new password',
        { ...signedIn(accessOf('approved', { password_change_due: true })), races: ONB_RACES },
        { sheet: 'Set a new password' },
      ],
      [
        'a member offered the password prompt',
        { ...signedIn(accessOf('approved'), {}), races: ONB_RACES },
        { sheet: 'Set a password' },
      ],
    ];
    for (const [label, fx, o] of cases) {
      const { page } = await fresh(fx, { storage: o.storage || {} });
      await settle(page);
      const heading = (await page.locator('#authSheetBody h2').count())
        ? await text(page, '#authSheetBody h2')
        : '';
      check(heading !== 'Pick your races', `${label}: Pick your races does not open`);
      if (o.sheet) check(heading === o.sheet, `${label}: the ${o.sheet} step is up instead`);
      if (
        label === 'a member told to set a new password' ||
        label === 'a member offered the password prompt'
      )
        check((await flag(page)) === null, `${label}: and the flag is not written`);
      await page.close();
    }
  }

  console.log('c. Shown once per device: Skip, Escape and a plain reload all count (AC 15, 16)');
  for (const how of ['Skip', 'Escape', 'reload']) {
    const { page } = await fresh({ ...member, races: ONB_RACES });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    if (how === 'Skip') await page.getByRole('button', { name: 'Skip', exact: true }).click();
    if (how === 'Escape') await page.keyboard.press('Escape');
    if (how === 'Skip')
      check((await insertsOf(page)).length === 0, 'Skip writes nothing to entries');
    // Same page, same context: localStorage survives; the init script that
    // sets the fixtures runs again but seeds no flag.
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#raceLoading'));
    await settle(page);
    check(!(await onbOpen(page)), `after ${how} and a reload it does not open by itself`);
    check((await flag(page)) === '1', `after ${how} the flag is still set`);
    await page.close();
  }

  console.log('d. The Menu item reopens it (AC 17, 22)');
  {
    const seen = { 'balance-onboarding-u1': '1' };
    const mine = rc('mine', 'Mine Race', '2026-12-01', {
      entries: [ent('m1', 'Sam Lee', { created_by: 'u1' })],
    });
    const { page } = await fresh({ ...member, races: [...ONB_RACES, mine] }, { storage: seen });
    await menuPick(page);
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    const got = await labels(page);
    check(
      got.length === 2 && !got.join('|').includes('Mine Race'),
      'it opens regardless of the flag, and leaves out a race that already has my entry',
    );
    await page.keyboard.press('Escape');
    check(!(await sheetUp(page)), 'Escape closes it');
    check(
      await page.evaluate(() => document.activeElement.id === 'accountMenuButton'),
      'and focus returns to the Menu button',
    );
    await page.close();
  }
  {
    const { page } = await fresh(
      { ...member, races: [ONB_RACES[2], ONB_RACES[3]] },
      { storage: { 'balance-onboarding-u1': '1' } },
    );
    await menuPick(page);
    check(
      (await sheetText(page)).includes('No upcoming races to add') &&
        (await page.locator('#authSheetBody input[type=checkbox]').count()) === 0,
      'with no eligible race it says so instead of showing an empty list',
    );
    await page.close();
  }
  {
    const { page } = await fresh({ ...signedIn(accessOf('pending')), races: ONB_RACES });
    await page.locator('#accountMenuButton').click();
    check(
      (await page.locator('#pickRacesButton').count()) === 0,
      'a pending account has no Pick your races item',
    );
    await page.close();
  }

  console.log('e. Save sends one insert per ticked race (AC 18, 20)');
  {
    const { page } = await fresh({ ...member, races: ONB_RACES });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    await page.getByRole('checkbox', { name: /Alpha Run/ }).check();
    await page.getByRole('checkbox', { name: /Bravo Swim/ }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#authSheetBody').getByRole('link', { name: 'Alpha Run' }).waitFor();
    const writes = await called(page, 'write');
    const inserts = await insertsOf(page);
    check(
      inserts.length === 2 && writes.length === 2,
      'exactly two writes, both inserts into entries',
    );
    const shape = p => JSON.stringify(Object.entries(p).sort());
    check(
      inserts.every(
        c =>
          c[3].name === 'Sam Lee' &&
          c[3].level === 'considering' &&
          Array.isArray(c[3].events) &&
          c[3].events.length === 0 &&
          Object.keys(c[3]).sort().join() === 'events,level,name,race_id',
      ),
      'each carries exactly race_id, name, level considering and events []: ' +
        inserts.map(c => shape(c[3])).join(' '),
    );
    check(
      inserts
        .map(c => c[3].race_id)
        .sort()
        .join() === 'alpha,bravo',
      'one for each race ticked',
    );
    check((await rpcCalled(page, 'add_race_event')).length === 0, 'no add_race_event call');
    const body = await sheetText(page);
    check(
      body.includes('choose an event and a level'),
      'it says to open each race to choose an event and a level',
    );
    check(
      (
        await page
          .locator('#authSheetBody')
          .getByRole('link', { name: 'Alpha Run' })
          .getAttribute('href')
      ).endsWith('/race/alpha-slug') &&
        (
          await page
            .locator('#authSheetBody')
            .getByRole('link', { name: 'Bravo Swim' })
            .getAttribute('href')
        ).endsWith('/race/bravo-slug'),
      'each saved race links to its race screen',
    );
    check(
      (await page.evaluate(() => window.__reads.filter(t => t === 'races').length)) >= 2,
      'the races were loaded again',
    );
    await page.locator('#authSheetBody').getByRole('link', { name: 'Alpha Run' }).click();
    await page.locator('#raceScreenBody .details-card').waitFor();
    check(
      !(await sheetUp(page)) &&
        (await page.locator('#raceScreenBody').innerText()).includes('Sam Lee'),
      'the link opens the race, and its card shows the member',
    );
    await page.close();
  }
  {
    const { page } = await fresh({ ...member, races: ONB_RACES });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    check(
      await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
      'Save with nothing ticked is disabled',
    );
    check((await insertsOf(page)).length === 0, 'and sends nothing');
    await page.close();
  }

  console.log('f. A partly failed save names the failures and retries only those (AC 19)');
  for (const [label, err, reason, banned] of [
    [
      'a duplicate',
      {
        code: '23505',
        message: 'duplicate key value violates unique constraint "entries_race_id_name_key"',
      },
      'already has your name',
      /duplicate key|23505|constraint/,
    ],
    [
      'a refusal',
      { code: '42501', message: 'new row violates row-level security policy for table "entries"' },
      'was refused',
      /row-level security|policy|42501/,
    ],
    [
      'a server error',
      { code: 'XX000', message: 'internal boom at line 4' },
      'could not be saved',
      /boom|XX000/,
    ],
  ]) {
    const { page } = await fresh({
      ...member,
      races: ONB_RACES,
      insertFail: { bravo: { once: true, result: { data: null, error: err } } },
    });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    await page.getByRole('checkbox', { name: /Alpha Run/ }).check();
    await page.getByRole('checkbox', { name: /Bravo Swim/ }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#authSheetBody .auth-sheet-error:not(.hidden)').waitFor();
    const msg = await text(page, '#authSheetBody .auth-sheet-error');
    check(
      msg.includes('Not saved: Bravo Swim') &&
        msg.includes(reason) &&
        msg.includes('Saved: Alpha Run.') &&
        !msg.split('Not saved')[1].includes('Alpha Run'),
      `${label}: one message names the failed race in plain English`,
    );
    check(!banned.test(await sheetText(page)), `${label}: no raw Postgres text is shown`);
    const left = await labels(page);
    check(
      left.length === 1 && left[0].startsWith('Bravo Swim'),
      `${label}: only the failed race is still offered`,
    );
    check(
      await page.getByRole('checkbox', { name: /Bravo Swim/ }).isChecked(),
      `${label}: and it is still ticked`,
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#authSheetBody').getByRole('link', { name: 'Bravo Swim' }).waitFor();
    const inserts = await insertsOf(page);
    check(
      inserts.map(c => c[3].race_id).join() === 'alpha,bravo,bravo',
      `${label}: the second Save sent only the failed race: ` +
        inserts.map(c => c[3].race_id).join(),
    );
    await page.close();
  }

  console.log('g. Member-supplied text is text, never markup (AC 22)');
  {
    const evil = '<img src=x onerror="window.__xss=1">';
    const { page } = await fresh({
      ...signedIn(accessOf('approved', { display_name: evil })),
      profileName: evil,
      races: [rc('evil', evil, '2026-11-20')],
    });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    await settle(page);
    check(
      (await page.locator('#authSheetBody img').count()) === 0 &&
        (await page.evaluate(() => window.__xss)) === undefined,
      'a race name and a display name full of markup add no element and run nothing',
    );
    check((await sheetText(page)).includes(evil), 'and both are shown as typed');
    await page.close();
  }

  console.log('h. Edit and Remove only where allowed; Edit opens the right entry (AC 23, 24, 25)');
  {
    const OWN = rc('own', 'Own Race', '2026-11-10', {
      entries: [
        ent('a', 'Alex Kim'),
        ent('j', 'Jo Park', { created_by: 'u8' }),
        ent('s', 'Sam Lee', { created_by: 'u1' }),
        ent('z', 'Zed Ng', { created_by: 'u7' }),
      ],
    });
    const openOwn = async (fx, race = OWN) => {
      const r = await fresh(
        { races: [race], ...fx },
        { storage: { 'balance-onboarding-u1': '1' } },
      );
      await r.page.locator('.race-summary').first().click();
      await r.page.locator('#raceScreenBody .details-card').waitFor();
      return r;
    };
    const edits = page => page.locator('#raceScreenBody .roster-edit');
    {
      const { page } = await openOwn(member);
      check((await edits(page).count()) === 1, 'a member gets Edit on one row only');
      check(
        (await edits(page).first().getAttribute('aria-label')).includes('Sam Lee'),
        'and it is their own',
      );
      check(
        (await page.locator('.remove-commit-button').count()) === 1,
        'Remove commitment is there for their own entry',
      );
      await edits(page).first().click();
      check(
        (await page.locator('.name-input').inputValue()) === 'Sam Lee',
        "their Edit loads their own entry, with others' rows before and after it",
      );
      await page.close();
    }
    {
      const { page } = await openOwn({ ...member, adminStatus: { admin: true, ready: true } });
      check(
        (await edits(page).count()) === 4,
        'an admin with a two-factor session gets Edit on every row',
      );
      await edits(page).nth(1).click();
      check(
        (await page.locator('.name-input').inputValue()) === 'Jo Park' &&
          (await page.locator('.remove-commit-button').count()) === 1,
        "clicking the 2nd of 4 rows opens that member's entry, with Remove",
      );
      await page.close();
    }
    {
      const { page } = await openOwn({ ...member, adminStatus: { admin: true, ready: false } });
      check(
        (await edits(page).count()) === 1,
        'an admin without two-factor is treated as a member here',
      );
      await page.locator('#accountMenuButton').click();
      check(
        (await page.getByRole('link', { name: 'Admin' }).count()) === 1,
        'and still sees the Admin link',
      );
      await page.close();
    }
    {
      // A commitment typed with the member's name, but nobody's: not theirs.
      const UNOWNED = rc('un', 'Unowned Race', '2026-11-11', {
        entries: [ent('x1', 'Sam Lee', { created_by: null })],
      });
      const { page } = await openOwn(member, UNOWNED);
      check((await edits(page).count()) === 0, 'an unowned entry with my name has no Edit');
      check((await page.locator('.remove-commit-button').count()) === 0, 'and no Remove');
      check(
        await page.locator('.commit-toggle-button').isVisible(),
        'and I am still offered Add your commitment',
      );
      await page.close();
    }
    {
      const PASTUN = rc('pu', 'Past Unowned', '2026-09-20', {
        entries: [ent('x2', 'Sam Lee', { created_by: null, level: 'locked' })],
      });
      const { page } = await fresh(
        { ...member, races: [PASTUN] },
        {
          storage: {
            'balance-onboarding-u1': '1',
            'balance-race-ui': JSON.stringify({
              user: '',
              filter: '',
              form: {},
              whenFilter: 'past',
              viewFilter: 'all',
            }),
          },
        },
      );
      await page.locator('.race-summary').first().click();
      await page.locator('#raceScreenBody .details-card').waitFor();
      check(
        (await page.locator('.result-edit').count()) === 0,
        'an unowned entry with my name has no result button',
      );
      await page.close();
    }
  }

  console.log(
    'i. A refused change reads plainly, and a revoked member is still signed out (AC 26, 27)',
  );
  {
    const OWN = rc('own', 'Own Race', '2026-11-10', {
      entries: [ent('s', 'Sam Lee', { created_by: 'u1' })],
    });
    const PLAIN = 'You can only change your own commitment. Ask a club admin if it needs changing.';
    const tryOnce = async (fx, act) => {
      const { page } = await fresh(
        { ...member, races: [OWN], ...fx },
        { storage: { 'balance-onboarding-u1': '1' } },
      );
      await page.locator('.race-summary').first().click();
      await page.locator('#raceScreenBody .details-card').waitFor();
      await page.locator('#raceScreenBody .roster-edit').first().click();
      await act(page);
      await settle(page);
      return page;
    };
    const save = page => page.locator('.save-button').click();
    const remove = async page => {
      await page.locator('.remove-commit-button').click();
      await page.locator('#confirmDialogConfirm').click();
    };
    const RLS = {
      data: null,
      error: { message: 'new row violates row-level security policy for table "entries"' },
    };
    for (const [label, wr, act] of [
      ['a save that touches no row', { data: [], error: null }, save],
      ['a save refused by row-level security', RLS, save],
      ['a remove that touches no row', { data: [], error: null }, remove],
      ['a remove refused by row-level security', RLS, remove],
    ]) {
      const page = await tryOnce({ writeResult: wr }, act);
      const shown = await text(page, '#updateBannerText');
      check(shown.includes(PLAIN), `${label}: the message is the plain one`);
      check(
        !/row-level|policy|approved members only/i.test(shown),
        `${label}: no Postgres text, no "approved members only"`,
      );
      check(
        (await called(page, 'signOut')).length === 0,
        `${label}: an approved member stays signed in`,
      );
      await page.close();
    }
    {
      const { page } = await fresh(
        { ...member, races: [OWN], writeResult: RLS },
        { storage: { 'balance-onboarding-u1': '1' } },
      );
      await page.locator('.race-summary').first().click();
      await page.locator('#raceScreenBody .details-card').waitFor();
      await page.locator('#raceScreenBody .roster-edit').first().click();
      await page.evaluate(() => {
        window.__access = { ...window.__access, state: 'revoked' };
      });
      await save(page);
      await page.waitForFunction(() => window.__calls.some(c => c[0] === 'signOut'));
      await settle(page);
      check(
        (await text(page, '#updateBannerText')).startsWith('Your access has been removed.'),
        'a revoked member whose entry save is refused gets the removal message and is signed out',
      );
      await page.close();
    }
    {
      // Adding a commitment under a name an unowned entry already holds.
      const UN = rc('un', 'Unowned Race', '2026-11-11', {
        entries: [ent('x1', 'Sam Lee', { created_by: null })],
      });
      const dup = { code: '23505', message: 'duplicate key value violates unique constraint' };
      const { page } = await fresh(
        { ...member, races: [UN], insertFail: { un: { result: { data: null, error: dup } } } },
        { storage: { 'balance-onboarding-u1': '1' } },
      );
      await page.locator('.race-summary').first().click();
      await page.locator('#raceScreenBody .details-card').waitFor();
      await page.locator('.commit-toggle-button').click();
      await page.locator('#raceScreenBody .event-choices .choice').first().click();
      await page.locator('.save-button').click();
      await settle(page);
      const shown = await text(page, '#updateBannerText');
      check(
        shown.includes('is already on this race') &&
          shown.includes('ask a club admin to link it') &&
          !shown.includes('Edit'),
        'a duplicate name says to ask a club admin to link it, not to use Edit: ' + shown,
      );
      await page.close();
    }
  }

  console.log('l. A failed reload, a close during Save, and a later reload (M1, M2, D5)');
  {
    // M1: the races fail to reload after a partial save. The failure is still
    // named and ticked, and the saved race is still confirmed.
    const { page } = await fresh({
      ...member,
      races: ONB_RACES,
      insertFail: {
        bravo: { once: true, result: { data: null, error: { code: '23505', message: 'dup' } } },
      },
    });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    await page.getByRole('checkbox', { name: /Alpha Run/ }).check();
    await page.getByRole('checkbox', { name: /Bravo Swim/ }).check();
    await page.evaluate(() => {
      window.__fixtures.racesError = { message: 'down' };
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    // Bounded waits: a regression shows as a FAIL line, not a timeout crash.
    const shown = await within(page.locator('#authSheetBody .auth-sheet-error:not(.hidden)'));
    check(shown, 'M1: after a partial save with the reload failed, a failure message is shown');
    const msg = shown ? await text(page, '#authSheetBody .auth-sheet-error') : '';
    check(
      msg.includes('Saved: Alpha Run.') && msg.includes('Not saved: Bravo Swim'),
      'M1: with the reload failed, the message still names what saved and what failed: ' + msg,
    );
    const left = await labels(page);
    check(
      left.length === 1 &&
        left[0].startsWith('Bravo Swim') &&
        (await page.getByRole('checkbox', { name: /Bravo Swim/ }).isChecked()),
      'M1: and the failed race is still listed and ticked',
    );
    await page.close();
  }
  {
    // M2: Escape, the close button and the backdrop do nothing while Save is writing.
    const { page } = await fresh({ ...member, races: ONB_RACES, insertDelay: 700 });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    await page.getByRole('checkbox', { name: /Alpha Run/ }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#authSheetBody button')].some(
        b => b.textContent === 'Saving…',
      ),
    );
    await page.keyboard.press('Escape');
    const focusInside = await page.evaluate(() =>
      document.querySelector('.auth-sheet').contains(document.activeElement),
    );
    // Clicked in the page, so a closed (hidden) sheet cannot stall the test.
    await page.evaluate(() => document.querySelector('#authSheetClose').click());
    await page.mouse.click(5, 5);
    check(
      await sheetUp(page),
      'M2: Escape, the x and a click outside leave the sheet up while saving',
    );
    check(focusInside, 'M2: focus stays inside the sheet while saving (read before the clicks)');
    check(
      await within(page.locator('#authSheetBody').getByRole('link', { name: 'Alpha Run' })),
      'M2: the saved race is confirmed with a link in the sheet',
    );
    check(
      (await sheetUp(page)) && (await sheetText(page)).includes('choose an event and a level'),
      'M2: the outcome lands in the visible sheet',
    );
    await page.keyboard.press('Escape');
    check(!(await sheetUp(page)), 'M2: and Escape closes it again once the save is done');
    await page.close();
  }
  {
    // D5: not opened by a later reload. The password prompt keeps it from
    // opening at load (flag unwritten); closing the prompt and reloading the
    // races must not open it.
    const { page } = await fresh({ ...signedIn(accessOf('approved'), {}), races: ONB_RACES });
    await page.locator('#authSheetBody h2').waitFor();
    await page.getByRole('button', { name: 'Not now' }).click();
    await page.evaluate(() => loadRaces());
    await settle(page);
    check(!(await onbOpen(page)), 'D5: a reload of the races after load does not open it');
    check((await flag(page)) === null, 'D5: and the flag is still unwritten');
    await page.close();
  }
  {
    // D5, the other half: a sign-in opens it.
    const { page } = await fresh({
      ...SIGNED_OUT,
      races: ONB_RACES,
      signIn: { access: accessOf('approved'), metadata: { has_password: true } },
    });
    await page.locator('#authSheetSignInButton').click();
    await page.locator('#auth-email').fill('sam@example.com');
    await page.locator('#auth-password').fill('maple river swift cloud');
    await page.locator('#authSheetBody button[type="submit"]').click();
    await page.waitForFunction(
      () => document.querySelector('#authSheetBody h2')?.textContent === 'Pick your races',
    );
    check(true, 'D5: signing in opens it');
    await page.close();
  }

  console.log('m. Token refresh does not re-arm Pick your races; a new sign-in does (D9)');
  {
    const mine = rc('mine', 'Mine Race', '2026-12-01', {
      entries: [ent('m1', 'Sam Lee', { created_by: 'u1' })],
    });
    const { page } = await fresh({ ...member, races: [mine, ONB_RACES[1]] });
    await settle(page);
    check(!(await onbOpen(page)), 'D9: not shown while the member has a commitment');
    await page.evaluate(() => {
      window.__emit('INITIAL_SESSION');
      window.__emit('TOKEN_REFRESHED');
    });
    await settle(page);
    await page.locator('.race-summary', { hasText: 'Mine Race' }).click();
    await page.locator('#raceScreenBody .details-card').waitFor();
    await page.locator('#raceScreenBody .roster-edit').first().click();
    // Remove their last commitment; the reload then finds none.
    await page.evaluate(() => {
      window.__fixtures.races[0].entries = [];
    });
    await page.locator('.remove-commit-button').click();
    await page.locator('#confirmDialogConfirm').click();
    await settle(page);
    await page.evaluate(() => window.__emit('TOKEN_REFRESHED'));
    await settle(page);
    check(
      !(await onbOpen(page)) && (await flag(page)) === null,
      'D9: after a token refresh, removing the last commitment does not open it',
    );
    // A real sign-out and a sign-in as someone else does.
    await page.evaluate(() => {
      window.__session = null;
      window.__emit('SIGNED_OUT');
    });
    await page.evaluate(() => {
      window.__session = {
        user: { id: 'u2', email: 'two@example.com', user_metadata: { has_password: true } },
        access_token: 't',
      };
      window.__access = {
        state: 'approved',
        display_name: 'Two Person',
        password_change_due: false,
        reset_expires_at: null,
        reset_expired: false,
      };
      window.__emit('SIGNED_IN');
    });
    check(
      await within(page.locator('#authSheetBody h2', { hasText: 'Pick your races' })),
      'D9: a sign-in as a different user opens it',
    );
    await page.close();
  }

  console.log('k. Pick your races at 390px and 1100px: no sideways scroll, 44px targets');
  for (const width of [390, 1100]) {
    const { page } = await fresh({ ...member, races: ONB_RACES }, { width });
    await page.locator('#authSheetBody .onboarding-races').waitFor();
    await page.getByRole('checkbox', { name: /Alpha Run/ }).check();
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    check(!over, `${width}px: no sideways scroll`);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('#authSheetBody label, #authSheetBody button')]
        .map(el => Math.round(el.getBoundingClientRect().height))
        .filter(h => h < 44),
    );
    check(small.length === 0, `${width}px: every row and button is at least 44px tall`);
    await page.screenshot({
      path: `${process.env.SCREENSHOT_DIR || '/tmp'}/pick-your-races-${width}.png`,
    });
    await page.close();
  }

  console.log(
    'j. Mixed alphabets are refused in the join form, and the rule matches the database (AC 28)',
  );
  {
    const { page } = await open(SIGNED_OUT);
    await openJoin(page);
    await fillJoin(page, { name: 'Sаm Lee' });
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.waitForTimeout(100);
    check(
      (await joinError(page).innerText()) ===
        'Your name mixes letters from different alphabets, such as Latin and Cyrillic. Use one alphabet.',
      'a Latin name with one Cyrillic a is refused with the new message',
    );
    check(
      (await called(page, 'signUp')).length === 0 &&
        (await rpcCalled(page, 'request_access')).length === 0,
      'and nothing reaches signUp or request_access',
    );
    const verdicts = await page.evaluate(
      names => names.map(n => cleanDisplayName(n)),
      [
        'Sam Lee',
        'Zoë',
        'Zoë',
        'José Núñez',
        'O’Brien',
        'Сергей',
        'Γιώργος',
        'Sam 山田',
        'Anne-Marie St. John',
      ],
    );
    check(
      verdicts.every(v => v.name && !v.error),
      'the single-script and neutral names all pass',
    );
    for (const [cp, ch] of [
      ['U+115F', '\u115f'],
      ['U+1160', '\u1160'],
      ['U+3164', '\u3164'],
      ['U+FFA0', '\uffa0'],
      ['U+2800', '\u2800'],
      ['U+17B4', '\u17b4'],
      ['U+17B5', '\u17b5'],
    ]) {
      const out = await page.evaluate(n => cleanDisplayName(n), 'Alex Smith' + ch);
      check(
        !!out.error && out.error.startsWith('Use letters'),
        `a name ending in the blank letter ${cp} is refused`,
      );
    }
    const mixed = await page.evaluate(
      names => names.map(n => cleanDisplayName(n).error),
      ['Sam Γ', 'Γа', 'Sam Ж'],
    );
    check(
      mixed.every(e => e && e.startsWith('Your name mixes letters')),
      'Latin+Greek, Greek+Cyrillic and Latin+Cyrillic are refused',
    );
    await page.close();
  }
}

await browser.close();
server.close();
if (failures) {
  console.log(`check-app-ui: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('check-app-ui: all checks passed');
