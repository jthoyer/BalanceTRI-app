// Drives admin.html in headless Chromium against a stand-in Supabase client,
// to check the console's B6 panels actually work: the Requests panel, the
// waiting badge, decisions, password reset, "not set up yet", and sign-in.
//
//   node scripts/check-admin-ui.mjs
//
// Needs Playwright; it skips (exit 0) when Playwright isn't installed, so it
// can't break a checkout without it. It never talks to the real project.
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
    console.log('check-admin-ui: Playwright is not installed, skipping.');
    process.exit(0);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const body = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The stand-in client. window.__calls records every RPC, function call and
// password change; window.__fixtures says what each RPC returns.
const STUB = `
window.__calls = [];
const fx = () => window.__fixtures;
const res = v => Promise.resolve(v);
window.supabase = { createClient: () => ({
  auth: {
    getSession: () => res({ data: { session: fx().session } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: () => res({ error: null }),
    signInWithPassword: a => { window.__calls.push(['signInWithPassword', a.email]); return res({ error: { message: 'Invalid login credentials' } }); },
    signInWithOtp: () => res({ error: null }),
    updateUser: a => { window.__calls.push(['updateUser', a.password.length]); return res({ error: fx().updateUserError || null }); },
    mfa: { listFactors: () => res({ data: { totp: [] }, error: null }) },
  },
  rpc: (name, args) => {
    window.__calls.push(['rpc', name, args || null]);
    const f = fx().rpc[name];
    if (f && f.error) return res({ data: null, error: f.error });
    return res({ data: f === undefined ? null : f, error: null });
  },
  from: () => ({ select: () => ({ then: (ok, bad) => res({ data: fx().races, error: null }).then(ok, bad) }) }),
  // invokeError mimics supabase-js 2.117.1: an HTTP error carries the
  // function's Response as context; a network or CORS failure carries a TypeError.
  functions: { invoke: (name, opts) => {
    window.__calls.push(['invoke', name, opts.body]);
    const e = fx().invokeError;
    let out = fx().invoke;
    if (e && e.status) out = { data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(e.body || {}), { status: e.status }) } };
    else if (e) out = { data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: new TypeError('Failed to fetch') } };
    return new Promise(r => setTimeout(() => r(out), fx().invokeDelay || 0));
  } },
}) };
`;

const NOW = '2026-10-12T00:00:00Z';
const fixtures = (over = {}) => ({
  session: { user: { id: 'owner', email: 'owner@example.com' }, access_token: 't' },
  races: [],
  invoke: {
    data: {
      password: 'maple-river-swift-cloud-47',
      expires_at: '2026-10-19T00:00:00Z',
      signed_out: true,
    },
    error: null,
  },
  ...over,
  rpc: {
    admin_status: { admin: true, mfa_required: true, aal: 'aal2', ready: true },
    admin_stats: {
      races_upcoming: 1,
      races_live: 1,
      races_removed: 0,
      entries: 2,
      users: 4,
      users_7d: 2,
      users_unconfirmed: 0,
      users_not_listed: 2,
      allow_list_size: 2,
      changes_7d: 1,
      deletes_7d: 0,
      signups_by_day: [],
    },
    admin_activity: [
      {
        id: 1,
        table_name: 'profiles',
        row_id: 'u1',
        op: 'UPDATE',
        old_row: { display_name: 'Sam' },
        new_row: { display_name: 'Sam Lee' },
        changed_at: NOW,
        changed_by: 'u1',
        changed_by_label: 'Sam Lee',
        changed_role: 'authenticated',
        undone_at: null,
      },
      {
        id: 2,
        table_name: 'entries',
        row_id: 'e1',
        op: 'INSERT',
        old_row: null,
        new_row: { name: 'Jo', level: 'planning', race_id: 'r1' },
        changed_at: NOW,
        changed_by: 'u2',
        changed_by_label: 'Jo Bloggs',
        changed_role: 'authenticated',
        undone_at: null,
      },
    ],
    admin_removed_races: [],
    admin_users: [
      {
        id: 'owner',
        email: 'owner@example.com',
        display_name: 'Owner',
        created_at: NOW,
        last_sign_in_at: NOW,
        confirmed: true,
        on_allow_list: true,
        is_admin: true,
        entries_created: 0,
        changes_30d: 0,
      },
      {
        id: 'u1',
        email: 'sam@example.com',
        display_name: 'Sam Lee',
        created_at: NOW,
        last_sign_in_at: NOW,
        confirmed: true,
        on_allow_list: false,
        is_admin: false,
        entries_created: 0,
        changes_30d: 1,
      },
    ],
    admin_requests: [
      {
        user_id: 'u1',
        email: 'sam@example.com',
        display_name: 'Sam Lee',
        note: 'Squad B, invited by Jo',
        status: 'pending',
        requested_at: NOW,
        decided_at: null,
        decided_by_label: null,
        reason: null,
        notified_at: null,
        listed: false,
        reset_pending: false,
        reset_expires_at: null,
      },
      {
        user_id: 'u3',
        email: 'kim@example.com',
        display_name: 'Kim Ng',
        note: null,
        status: 'pending',
        requested_at: NOW,
        decided_at: null,
        decided_by_label: null,
        reason: null,
        notified_at: NOW,
        listed: false,
        reset_pending: false,
        reset_expires_at: null,
      },
      {
        user_id: 'u4',
        email: 'old@example.com',
        display_name: 'Old Member',
        note: null,
        status: 'revoked',
        requested_at: NOW,
        decided_at: NOW,
        decided_by_label: 'Owner',
        reason: 'Left the club',
        notified_at: NOW,
        listed: false,
        reset_pending: false,
        reset_expires_at: null,
      },
    ],
    admin_decide_request: { status: 'approved' },
    ...(over.rpc || {}),
  },
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
async function open(fx, path = '/admin.html') {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/vendor/supabase-js-*.js', r =>
    r.fulfill({ contentType: 'text/javascript', body: STUB }),
  );
  await page.addInitScript(f => {
    window.__fixtures = f;
  }, fx);
  await page.goto(base + path);
  return { page, errors };
}
const calls = page => page.evaluate(() => window.__calls);

console.log('1. The console with requests waiting');
{
  const { page, errors } = await open(fixtures());
  await page.waitForSelector('#requests');
  check(
    (await page.locator('.admin-waiting').textContent()) === '2 waiting',
    'the title says 2 waiting',
  );
  check(
    !(await page
      .locator('#adminRoot')
      .evaluate(n =>
        [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim() === 'null'),
      )),
    'no stray "null" text',
  );
  check(
    (await page.locator('.admin-request').count()) === 2,
    'Waiting shows the two pending requests',
  );
  check(
    (await page.locator('.admin-warn', { hasText: 'Telegram message not sent' }).count()) === 1,
    'the request whose message never went is marked',
  );
  check(
    (await page.locator('.admin-note').first().textContent()) === 'Squad B, invited by Jo',
    'the note shows',
  );
  await page.locator('#requests select').selectOption('');
  check((await page.locator('.admin-request').count()) === 3, 'All shows every request');
  check(
    (await page.getByRole('button', { name: 'Give access back' }).count()) === 1,
    'a revoked request offers Give access back',
  );
  await page.locator('#requests select').selectOption('pending');
  await page.locator('.admin-request').first().locator('input[type=text]').fill('Knows Jo');
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await page.waitForFunction(() => window.__calls.some(c => c[1] === 'admin_decide_request'));
  const decide = (await calls(page)).find(c => c[1] === 'admin_decide_request');
  check(
    JSON.stringify(decide[2]) ===
      JSON.stringify({ p_user_id: 'u1', p_decision: 'approve', p_reason: 'Knows Jo' }),
    'Approve sends the user, the decision and the reason',
  );
  await page.screenshot({
    path: process.env.SCREENSHOT || '/tmp/admin-console.png',
    fullPage: true,
  });
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await page.close();
}

console.log('1b. Member-typed text stays text; unlisted approvals and expired resets are marked');
{
  const evil = '<img src=x onerror="window.__xss=1">';
  const fx = fixtures();
  fx.rpc.admin_requests = [
    { ...fx.rpc.admin_requests[0], display_name: evil, note: evil },
    {
      ...fx.rpc.admin_requests[2],
      status: 'approved',
      listed: false,
      reset_pending: true,
      reset_expires_at: '2020-01-01T00:00:00Z',
      display_name: 'Old Member',
    },
  ];
  fx.rpc.admin_activity[0].changed_by_label = evil;
  const { page } = await open(fx);
  await page.waitForSelector('#requests');
  await page.locator('#requests select').selectOption('');
  await page.waitForTimeout(200);
  check(
    await page.evaluate(() => window.__xss === undefined),
    'markup in a name, a note or an activity label never runs',
  );
  check(
    (await page.locator('.admin-request').first().locator('strong').textContent()) === evil,
    'it shows as literal text',
  );
  check(
    (await page.locator('.admin-warn', { hasText: 'Not on the allow-list' }).count()) === 1,
    'an approved request whose address is unlisted is marked',
  );
  check(
    (await page.locator('.admin-warn', { hasText: 'Temporary password expired' }).count()) === 1,
    'an expired temporary password is marked (R6)',
  );
  await page.close();
}

console.log('2. Rejecting asks first');
{
  const { page } = await open(fixtures());
  await page.waitForSelector('#requests');
  await page.getByRole('button', { name: 'Reject' }).first().click();
  await page.waitForSelector('#confirmDialog[open]');
  check(
    (await page.locator('#confirmDialogTitle').textContent()) === 'Reject Sam Lee?',
    'the dialog names the person',
  );
  await page.locator('#confirmDialogCancel').click();
  check(!(await calls(page)).some(c => c[1] === 'admin_decide_request'), 'Cancel sends nothing');
  await page.getByRole('button', { name: 'Reject' }).first().click();
  await page.locator('#confirmDialogConfirm').click();
  await page.waitForFunction(() => window.__calls.some(c => c[1] === 'admin_decide_request'));
  const decide = (await calls(page)).find(c => c[1] === 'admin_decide_request');
  check(
    decide[2].p_decision === 'reject' && decide[2].p_reason === null,
    'Confirm sends a reject with no reason',
  );
  await page.close();
}

console.log('3. Resetting a password shows it once');
{
  const { page } = await open(fixtures());
  await page.waitForSelector('#requests');
  check(
    (await page.getByRole('button', { name: 'Reset password' }).count()) === 1,
    'only the non-admin account has Reset password',
  );
  await page.getByRole('button', { name: 'Reset password' }).click();
  await page.locator('#confirmDialogConfirm').click();
  await page.waitForSelector('.admin-temp-password');
  check(
    (await page.locator('.admin-temp-password').textContent()) === 'maple-river-swift-cloud-47',
    'the temporary password shows',
  );
  check(
    (await page.locator('.admin-reveal').textContent()).includes(
      'Send this to Sam Lee by text or in person. It works once.',
    ),
    'with the spec wording',
  );
  check(
    await page.evaluate(() => document.activeElement?.textContent === 'Copy'),
    'focus moves to Copy',
  );
  const inv = (await calls(page)).find(c => c[0] === 'invoke');
  check(
    inv[1] === 'admin-reset-password' && inv[2].user_id === 'u1',
    'it calls admin-reset-password for that account',
  );
  await page.keyboard.press('Escape');
  check(
    (await page.locator('.admin-reveal-dialog[open]').count()) === 1,
    'Escape does not close it',
  );
  await page.getByRole('button', { name: 'Done' }).click();
  await page
    .waitForFunction(() => !document.querySelector('.admin-reveal-dialog'), null, { timeout: 2000 })
    .catch(() => null);
  check(
    (await page.locator('.admin-reveal-dialog').count()) === 0,
    'Done closes it, and the password is gone',
  );
  await page.close();
}

console.log('3b. A re-render while the reset is in flight does not lose the password (R1 M1)');
{
  const { page } = await open(fixtures({ invokeDelay: 1500 }));
  await page.waitForSelector('#requests');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await page.locator('#confirmDialogConfirm').click();
  await page.waitForSelector('#confirmDialog:not([open])', { state: 'attached' });
  await page.getByRole('button', { name: 'Resetting…' }).waitFor();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForFunction(() => window.__calls.filter(c => c[1] === 'admin_stats').length === 2);
  await page.getByRole('button', { name: 'Reset password' }).waitFor();
  check(
    (await page.locator('.admin-temp-password').count()) === 0,
    'the console really re-rendered before the reset answered',
  );
  await page.waitForSelector('.admin-temp-password', { timeout: 3000 }).catch(() => null);
  check(
    (await page.locator('.admin-temp-password').count()) === 1,
    'the password still shows after the console re-rendered',
  );
  await page.close();
}

console.log('4. A reset that fails says why, and allows another try');
for (const [invokeError, want, label] of [
  [
    { status: 400, body: { error: 'That account no longer exists.' } },
    "Couldn't reset: That account no longer exists.",
    'the function’s own reason',
  ],
  [{ status: 404 }, "Couldn't reset: Password resets aren’t set up yet.", 'a 404 says not set up'],
  [
    { fetch: true },
    "Couldn't reset: Couldn’t reach the password reset service. It may not be set up yet.",
    'a network or CORS failure says it can’t reach the service',
  ],
]) {
  const { page } = await open(fixtures({ invokeError }));
  await page.waitForSelector('#requests');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await page.locator('#confirmDialogConfirm').click();
  await page.waitForFunction(
    () => document.querySelector('.admin-reset .admin-error')?.textContent,
  );
  check((await page.locator('.admin-reset .admin-error').textContent()) === want, label);
  check(
    await page.getByRole('button', { name: 'Reset password' }).isEnabled(),
    'and the button works again',
  );
  await page.close();
}

console.log('5. Before the migration is applied');
{
  const fx = fixtures({
    rpc: {
      admin_requests: { error: { code: 'PGRST202', message: 'Could not find the function' } },
    },
  });
  const { page, errors } = await open(fx);
  await page.waitForSelector('#requests');
  check(
    (await page.locator('#requests').textContent()).includes('Not set up yet'),
    'Requests says not set up yet',
  );
  check((await page.locator('.admin-waiting').count()) === 0, 'no waiting badge');
  check(
    (await page.getByRole('button', { name: 'Reset password' }).count()) === 0,
    'no Reset password buttons',
  );
  check(
    (await page.locator('th', { hasText: 'Password' }).count()) === 0,
    'and no empty Password column',
  );
  check(
    (await page.locator('h2', { hasText: 'Activity' }).count()) === 1,
    'the rest of the console still loads',
  );
  check(errors.length === 0, 'no page errors');
  await page.close();
}

console.log('6. Sign-in: password first, code as fallback; and the password card');
{
  const { page } = await open(fixtures({ session: null }));
  await page.waitForSelector('input[type=password]');
  check(
    (await page.locator('input[autocomplete=current-password]').count()) === 1,
    'the password field is there',
  );
  await page.locator('input[type=email]').fill('owner@example.com');
  await page.getByRole('button', { name: 'Email me a code instead' }).click();
  check(
    (await page.getByRole('button', { name: 'Send code' }).count()) === 1,
    'the code fallback is one click away',
  );
  check(
    (await page.locator('input[type=email]').inputValue()) === 'owner@example.com',
    'and keeps the address',
  );
  await page.close();
  const c = await open(fixtures());
  await c.page.waitForSelector('#requests');
  const pw = c.page
    .locator('section', { hasText: 'Your password' })
    .locator('input[type=password]');
  await pw.nth(0).fill('correct horse battery');
  await pw.nth(1).fill('correct horse batterx');
  await c.page.getByRole('button', { name: 'Save password' }).click();
  check(
    (await c.page
      .locator('section', { hasText: 'Your password' })
      .locator('.admin-result')
      .textContent()) === "Those two don't match.",
    'mismatched passwords are caught',
  );
  await pw.nth(1).fill('correct horse battery');
  await c.page.getByRole('button', { name: 'Save password' }).click();
  await c.page
    .waitForFunction(() => window.__calls.some(x => x[0] === 'updateUser'), null, { timeout: 3000 })
    .catch(() => null);
  const saved = (await calls(c.page)).find(x => x[0] === 'updateUser');
  check(
    saved?.[1] === 'correct horse battery'.length,
    'a matching password is saved with updateUser',
  );
  await c.page.close();
  const r = await open(
    fixtures({
      updateUserError: {
        code: 'reauthentication_needed',
        message: 'Password update requires reauthentication',
      },
    }),
  );
  await r.page.waitForSelector('#requests');
  const pw2 = r.page
    .locator('section', { hasText: 'Your password' })
    .locator('input[type=password]');
  await pw2.nth(0).fill('correct horse battery');
  await pw2.nth(1).fill('correct horse battery');
  await r.page.getByRole('button', { name: 'Save password' }).click();
  await r.page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.admin-result')].some(n =>
          n.textContent.includes('Supabase'),
        ),
      null,
      { timeout: 3000 },
    )
    .catch(() => null);
  check(
    (
      await r.page
        .locator('section', { hasText: 'Your password' })
        .locator('.admin-result')
        .textContent()
    ).startsWith('Supabase wants a recent sign-in'),
    'a reauthentication error says what to do',
  );
  await r.page.close();
}

console.log('9. Batch approval');
{
  const fx = fixtures({
    rpc: {
      admin_approve_requests: {
        approved: 1,
        results: [
          { user_id: 'u1', ok: true },
          {
            user_id: 'u3',
            ok: false,
            error: "That account hasn't confirmed its email address, so it can't be approved.",
          },
        ],
      },
    },
  });
  const { page, errors } = await open(fx);
  await page.waitForSelector('#requests');
  const approveChosen = page.getByRole('button', { name: /^Approve chosen/ });
  check(await approveChosen.isDisabled(), 'Approve chosen starts disabled');
  check(
    (await page.locator('#requests input[type=checkbox]').count()) === 2,
    'each waiting request has a tick box',
  );
  await page.getByRole('checkbox', { name: 'Choose Sam Lee' }).check();
  check(
    (await approveChosen.textContent()) === 'Approve chosen (1)' &&
      !(await approveChosen.isDisabled()),
    'ticking one counts it and enables the button',
  );
  await page.getByRole('button', { name: 'Clear' }).click();
  check(
    (await approveChosen.isDisabled()) &&
      !(await page.getByRole('checkbox', { name: 'Choose Sam Lee' }).isChecked()),
    'Clear unticks everything',
  );
  await page.getByRole('button', { name: 'Choose all waiting' }).click();
  check(
    (await approveChosen.textContent()) === 'Approve chosen (2)',
    'Choose all waiting ticks both',
  );
  await page.locator('#requests select').selectOption('');
  check(
    (await page.getByRole('checkbox', { name: 'Choose Sam Lee' }).isChecked()) &&
      (await page.getByRole('checkbox', { name: 'Choose Kim Ng' }).isChecked()),
    'changing the filter keeps the ticks',
  );
  await page.locator('#requests select').selectOption('pending');
  await approveChosen.click();
  await page.waitForSelector('#confirmDialog[open]');
  check(
    (await page.locator('#confirmDialogTitle').textContent()) === 'Approve 2 people?',
    'the dialog gives the count',
  );
  await page.locator('#confirmDialogCancel').click();
  check(!(await calls(page)).some(c => c[1] === 'admin_approve_requests'), 'Cancel sends nothing');
  await approveChosen.click();
  await page.locator('#confirmDialogConfirm').click();
  await page.waitForSelector('.admin-batch-notice');
  const batch = (await calls(page)).find(c => c[1] === 'admin_approve_requests');
  check(
    JSON.stringify([...batch[2].p_user_ids].sort()) === JSON.stringify(['u1', 'u3']),
    'it sends exactly the ticked user ids',
  );
  const notice = await page.locator('.admin-batch-notice').textContent();
  check(
    notice.includes('Approved 1 person.') && notice.includes('Skipped 1:'),
    'the notice counts both',
  );
  check(
    notice.includes('Kim Ng') && notice.includes("hasn't confirmed its email address"),
    'and names who was skipped and why',
  );
  // Only waiting requests can be ticked.
  await page.locator('#requests select').selectOption('');
  check(
    (await page.locator('#requests input[type=checkbox]').count()) === 2,
    'a revoked request has no tick box',
  );
  await page.locator('#requests select').selectOption('revoked');
  check(await page.locator('.admin-batch').isHidden(), 'the batch bar hides when nobody waits');
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await page.close();
}

console.log('9b. Batch approval caps at 50, and copes before its migration');
{
  const many = Array.from({ length: 55 }, (_, i) => ({
    ...fixtures().rpc.admin_requests[0],
    user_id: `p${i}`,
    display_name: `Person ${i}`,
    email: `p${i}@example.com`,
  }));
  const fx = fixtures({
    rpc: {
      admin_requests: many,
      admin_approve_requests: {
        error: { code: 'PGRST202', message: 'Could not find the function' },
      },
    },
  });
  const { page } = await open(fx);
  await page.waitForSelector('#requests');
  await page.getByRole('button', { name: 'Choose all waiting' }).click();
  check(
    (await page.getByRole('button', { name: /^Approve chosen/ }).textContent()) ===
      'Approve chosen (50)',
    'Choose all waiting stops at 50',
  );
  await page.getByRole('checkbox', { name: 'Choose Person 54' }).click();
  check(
    (await page.locator('#requests .admin-error').first().textContent()) ===
      'Approve at most 50 at a time.',
    'a 51st tick is refused with a reason',
  );
  check(
    !(await page.getByRole('checkbox', { name: 'Choose Person 54' }).isChecked()),
    'and stays unticked',
  );
  await page.getByRole('button', { name: /^Approve chosen/ }).click();
  await page.locator('#confirmDialogConfirm').click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#requests .admin-error')].some(e =>
      e.textContent.includes('isn’t set up yet'),
    ),
  );
  check(true, 'before its migration, it says batch approval isn’t set up yet');
  await page.close();
}

await browser.close();
server.close();
if (failures) {
  console.log(`check-admin-ui: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('check-admin-ui: all checks passed');
