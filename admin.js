// Admin console. Every read and write here goes through a public.admin_*
// function (add_admin_console migration), and each one refuses anyone who
// isn't in private.admins with a two-factor session. This page only decides
// which screen to show; the database is the boundary.
//
// Everything is built as DOM with textContent, never innerHTML: most of what
// this page shows (names, race titles, emails) was typed by members.
// Same guard as app.js: without supabase-js nothing here can run, so say so
// rather than leave an empty page.
if (!window.supabase?.createClient) {
  const adminRoot = document.getElementById('adminRoot');
  if (adminRoot)
    adminRoot.textContent =
      'The admin console could not load. Check your connection and try refreshing.';
  throw new Error('supabase-js did not load (vendor/supabase-js-*.js); admin.js stopped.');
}
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const root = document.getElementById('adminRoot');
const headerActions = document.getElementById('adminHeaderActions');

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}
function show(...nodes) {
  // Skip the nulls that optional sections return, or they print as "null".
  root.replaceChildren(...nodes.filter(n => n !== null && n !== undefined && n !== false));
}
function card(title, ...body) {
  return el('section', { class: 'admin-card' }, title ? el('h2', {}, title) : null, ...body);
}
function message(title, text, ...extra) {
  show(
    el(
      'section',
      { class: 'admin-card admin-message' },
      el('h1', {}, title),
      el('p', {}, text),
      ...extra,
    ),
  );
}
// An inline error under whatever failed, in place of a blocking alert().
// Empty until set(); role="alert" so a screen reader hears it straight away.
function errorLine() {
  const node = el('p', { class: 'admin-error', role: 'alert' });
  node.set = text => {
    node.textContent = text;
  };
  return node;
}
async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
// The access-request functions come with a migration (add_access_requests)
// that may not be applied yet. PostgREST answers PGRST202 for a function it
// doesn't have: show that panel as "not set up" rather than break the page.
async function rpcOptional(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error?.code === 'PGRST202') return { missing: true };
  if (error) throw new Error(error.message);
  return { data };
}
const sydney = { timeZone: 'Australia/Sydney' };
function when(iso) {
  return new Date(iso).toLocaleString('en-AU', {
    ...sydney,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
function day(isoDate) {
  // A bare date: read it as a calendar day, not a UTC midnight that shifts.
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}
function fmt(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  // Timestamps (deleted_at and friends) read better as Sydney time.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return when(value);
  return String(value);
}
function setBusy(button, label) {
  button.disabled = true;
  button.dataset.label = button.textContent;
  button.textContent = label;
}
function clearBusy(button) {
  button.disabled = false;
  button.textContent = button.dataset.label || button.textContent;
}

// ---------------------------------------------------------------------------
// Flow: signed in? -> admin? -> two-factor? -> console.
// ---------------------------------------------------------------------------
async function start() {
  const {
    data: { session },
  } = await db.auth.getSession();
  renderHeader(session);
  if (!session) return showSignIn();
  let status;
  try {
    status = await rpc('admin_status');
  } catch (e) {
    return message('Something went wrong', e.message);
  }
  if (!status.admin) {
    return message(
      'Admins only',
      `You're signed in as ${session.user.email}, which isn't an admin account.`,
      el(
        'button',
        { class: 'secondary-button', type: 'button', onclick: () => db.auth.signOut() },
        'Sign out',
      ),
    );
  }
  if (!status.ready) return showTwoFactor();
  return showConsole();
}
function renderHeader(session) {
  headerActions.querySelector('.admin-signout')?.remove();
  if (session) {
    headerActions.append(
      el(
        'button',
        { class: 'text-button admin-signout', type: 'button', onclick: () => db.auth.signOut() },
        'Sign out',
      ),
    );
  }
}
// A sign-out here, or in another tab, lands back on the sign-in screen.
db.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_OUT') setTimeout(start, 0);
});

// ---------------------------------------------------------------------------
// Sign-in. Its own form, because the calendar signs out anyone not on the
// allow-list — an admin who isn't would never get here through it.
// Password first (spec P10); either way two-factor comes next. The emailed
// code stays as the fallback, and shouldCreateUser: false means it can't
// create accounts.
// ---------------------------------------------------------------------------
function emailInput(value) {
  return el('input', {
    type: 'email',
    name: 'email',
    required: true,
    autocomplete: 'email',
    placeholder: 'you@example.com',
    'aria-label': 'Admin email address',
    value: value || undefined,
  });
}
function showSignIn(prefill) {
  const email = emailInput(prefill);
  const password = el('input', {
    type: 'password',
    name: 'password',
    required: true,
    autocomplete: 'current-password',
    placeholder: 'Password',
    'aria-label': 'Password',
  });
  const button = el('button', { class: 'primary-button', type: 'submit' }, 'Sign in');
  const form = el('form', { class: 'admin-form admin-signin-form' }, email, password, button);
  const signInError = errorLine();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    signInError.set('');
    setBusy(button, 'Signing in…');
    try {
      const captchaToken = await getCaptchaToken(form);
      const { error } = await db.auth.signInWithPassword({
        email: email.value.trim(),
        password: password.value,
        options: { captchaToken },
      });
      if (error) throw error;
      start();
    } catch (err) {
      signInError.set("Couldn't sign in: " + err.message);
      clearBusy(button);
      password.select();
    }
  });
  const useCode = el(
    'button',
    { class: 'text-button', type: 'button', onclick: () => showCodeSignIn(email.value.trim()) },
    'Email me a code instead',
  );
  show(
    card(
      'Admin sign-in',
      el(
        'p',
        { class: 'admin-hint' },
        "Sign in with your email and password. You'll be asked for your authenticator code next.",
      ),
      form,
      signInError,
      el('p', { class: 'admin-hint' }, 'No password yet? ', useCode),
    ),
  );
  (prefill ? password : email).focus();
}
function showCodeSignIn(prefill) {
  const email = emailInput(prefill);
  const button = el('button', { class: 'primary-button', type: 'submit' }, 'Send code');
  const form = el('form', { class: 'admin-form' }, email, button);
  const sendError = errorLine();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const address = email.value.trim();
    sendError.set('');
    setBusy(button, 'Sending…');
    try {
      const captchaToken = await getCaptchaToken(form);
      const { error } = await db.auth.signInWithOtp({
        email: address,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: location.origin + location.pathname,
          captchaToken,
        },
      });
      if (error) throw error;
      showCodeStep(address);
    } catch (err) {
      sendError.set('Could not send the code: ' + err.message);
      clearBusy(button);
    }
  });
  const usePassword = el(
    'button',
    { class: 'text-button', type: 'button', onclick: () => showSignIn(email.value.trim()) },
    'Use your password instead',
  );
  show(
    card(
      'Admin sign-in',
      el('p', { class: 'admin-hint' }, "Enter your admin email. We'll send a 6-digit code."),
      form,
      sendError,
      el('p', { class: 'admin-hint' }, usePassword),
    ),
  );
  email.focus();
}
function showCodeStep(address) {
  const code = codeInput('6-digit code from your email');
  const button = el('button', { class: 'primary-button', type: 'submit' }, 'Sign in');
  const form = el('form', { class: 'admin-form' }, code, button);
  const codeError = errorLine();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    codeError.set('');
    setBusy(button, 'Signing in…');
    const { error } = await db.auth.verifyOtp({ email: address, token: code.value, type: 'email' });
    if (error) {
      codeError.set("That code didn't work: " + error.message);
      clearBusy(button);
      code.select();
      return;
    }
    start();
  });
  const sentTo = el('strong', {}, address);
  show(
    card(
      'Check your email',
      el(
        'p',
        { class: 'admin-hint' },
        'We sent a code to ',
        sentTo,
        '. The link in the email works too.',
      ),
      form,
      codeError,
    ),
  );
  code.focus();
}
function codeInput(label) {
  const input = el('input', {
    class: 'admin-code',
    name: 'code',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    pattern: '[0-9]{6}',
    required: true,
    placeholder: '123456',
    'aria-label': label,
  });
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
  });
  return input;
}

// ---------------------------------------------------------------------------
// Two-factor. The first visit sets up an authenticator app; later visits ask
// for its current code. Either way the session ends up at aal2, which is
// what private.is_admin() checks.
// ---------------------------------------------------------------------------
async function showTwoFactor() {
  const { data, error } = await db.auth.mfa.listFactors();
  if (error) return message('Two-factor sign-in failed', error.message);
  const verified = data.totp.find(f => f.status === 'verified');
  if (verified) {
    return showFactorCode(
      verified.id,
      'Two-factor check',
      'Enter the 6-digit code from your authenticator app.',
    );
  }
  // A set-up abandoned half way leaves an unverified factor behind, which
  // would block a new one with the same name.
  for (const f of data.all.filter(f => f.factor_type === 'totp' && f.status !== 'verified')) {
    await db.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data: enrolled, error: enrolError } = await db.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Balance Tri Club admin',
  });
  if (enrolError) {
    return message(
      'Could not set up two-factor sign-in',
      enrolError.message +
        ' Check that TOTP is enabled under Authentication → Multi-Factor in Supabase.',
    );
  }
  const qr = el('img', {
    class: 'admin-qr',
    src: safeDataUrl(enrolled.totp.qr_code),
    alt: 'QR code for your authenticator app',
    width: 180,
    height: 180,
  });
  const secret = el('code', { class: 'admin-secret' }, enrolled.totp.secret);
  showFactorCode(
    enrolled.id,
    'Set up two-factor sign-in',
    'The admin console needs a second step at every sign-in. Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the code it shows.',
    el(
      'div',
      { class: 'admin-enrol' },
      qr,
      el('p', { class: 'admin-hint' }, "Can't scan? Enter this key: ", secret),
    ),
  );
}
// Supabase returns the QR code as `data:image/svg+xml;utf-8,<svg …>`, raw.
// Browsers reject unescaped SVG in a data URL (a `#` or `<` ends it early), so
// re-encode the payload and name the charset the way the spec expects.
function safeDataUrl(url) {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  if (comma < 0 || head.includes(';base64')) return url;
  const type = head.replace(/^data:/, '').split(';')[0];
  return `data:${type};charset=utf-8,${encodeURIComponent(decodeURIComponentSafe(url.slice(comma + 1)))}`;
}
function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
function showFactorCode(factorId, title, text, extra) {
  const code = codeInput('6-digit code from your authenticator app');
  const button = el('button', { class: 'primary-button', type: 'submit' }, 'Verify');
  const form = el('form', { class: 'admin-form' }, code, button);
  const codeError = errorLine();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    codeError.set('');
    setBusy(button, 'Checking…');
    const { error } = await db.auth.mfa.challengeAndVerify({ factorId, code: code.value });
    if (error) {
      codeError.set("That code didn't work: " + error.message);
      clearBusy(button);
      code.select();
      return;
    }
    start();
  });
  show(card(title, el('p', { class: 'admin-hint' }, text), extra, form, codeError));
  code.focus();
}

// ---------------------------------------------------------------------------
// The console.
// ---------------------------------------------------------------------------
// opts.focus 'requests': after a decision, put the keyboard back on the
// Requests heading rather than at the top of the page.
async function showConsole(opts = {}) {
  show(el('p', { class: 'admin-loading' }, 'Loading…'));
  let stats, activity, removed, users, races, requestResult;
  try {
    [stats, activity, removed, users, races, requestResult] = await Promise.all([
      rpc('admin_stats'),
      rpc('admin_activity', { p_days: 30, p_limit: 300 }),
      rpc('admin_removed_races'),
      rpc('admin_users'),
      // Signed-in users can read every race, removed ones included, so
      // entry changes can name their race.
      db
        .from('races')
        .select('id,name,date')
        .then(({ data, error }) => {
          if (error) throw new Error(error.message);
          return data;
        }),
      rpcOptional('admin_requests'),
    ]);
  } catch (e) {
    return message('Could not load the console', e.message);
  }
  // null means the access-requests migration isn't applied yet.
  const requests = requestResult.missing ? null : requestResult.data;
  const waiting = requests ? requests.filter(r => r.status === 'pending').length : 0;
  const raceNames = new Map(races.map(r => [r.id, `${r.name} (${day(r.date)})`]));
  const me = users.find(u => u.is_admin && u.email);
  // Only worth asking when someone is waiting, and never allowed to break the page.
  // Filled in after the first render, so a slow or missing function never delays the page.
  const matches = new Map();
  show(
    el(
      'div',
      { class: 'admin-title' },
      el(
        'h1',
        {},
        'Admin console',
        waiting ? ' ' : null,
        waiting
          ? el('a', { class: 'admin-badge admin-waiting', href: '#requests' }, `${waiting} waiting`)
          : null,
      ),
      el('button', { class: 'text-button', type: 'button', onclick: showConsole }, 'Refresh'),
    ),
    me && !me.on_allow_list ? allowListWarning(me.email) : null,
    requestsSection(requests, opts.notice, matches),
    statsSection(stats),
    activitySection(activity, raceNames),
    removedSection(removed),
    usersSection(users, requests !== null, opts.accountNotice),
    passwordSection(),
    allowListSection(),
  );
  // Arriving from the calendar's "Admin (2 waiting)" link: jump to Requests
  // once, then drop the fragment so later re-renders don't jump again.
  if (location.hash === '#requests') {
    document.getElementById('requests')?.scrollIntoView();
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (waiting) {
    orphanMatches().then(found => {
      if (!found.size) return;
      found.forEach((n, id) => matches.set(id, n));
      document.getElementById('requests')?.refresh?.();
    });
  }
  if (opts.focus === 'requests') document.querySelector('#requests h2')?.focus();
  // Back from Link / Unlink: the outcome sits at the top of Accounts.
  if (opts.accountNotice) document.getElementById('accounts')?.scrollIntoView();
}
// Per waiting request, how many unowned entries carry its name (admin_orphan_match_counts,
// from the link-entries migration). A hint only: no function, or any error, means no badge.
async function orphanMatches() {
  try {
    const { data } = await rpcOptional('admin_orphan_match_counts');
    return new Map((data || []).map(m => [m.user_id, m.matches]));
  } catch {
    return new Map();
  }
}
function allowListWarning(email) {
  return el(
    'p',
    { class: 'admin-notice' },
    'Your own address (',
    el('strong', {}, email),
    ") isn't on the allow-list, so the calendar signs you out and you can't edit races. Add it under Allow-list below.",
  );
}

// ----- Stats -----
function statsSection(s) {
  const tiles = [
    ['Upcoming races', s.races_upcoming],
    ['Commitments', s.entries],
    ['Accounts', s.users, `${s.users_7d} new this week`],
    ['Not on allow-list', s.users_not_listed, `${s.users_unconfirmed} unconfirmed`],
    ['Changes this week', s.changes_7d, `${s.deletes_7d} deletes`],
    ['Removed races', s.races_removed],
  ];
  return card(
    null,
    el(
      'div',
      { class: 'admin-tiles' },
      tiles.map(([label, value, note]) =>
        el(
          'div',
          { class: 'admin-tile' },
          el('span', { class: 'admin-tile-label' }, label),
          el('strong', { class: 'admin-tile-value' }, fmt(value)),
          note ? el('span', { class: 'admin-tile-note' }, note) : null,
        ),
      ),
    ),
    signupChart(s.signups_by_day || []),
  );
}
// Fourteen days of sign-ups as a bar strip. One series, so no legend: the
// heading names it. Each bar carries its own label for hover and screen
// readers, and only non-zero days get a number above them.
function signupChart(days) {
  const max = Math.max(1, ...days.map(d => d.count));
  const total = days.reduce((sum, d) => sum + d.count, 0);
  return el(
    'figure',
    { class: 'admin-chart' },
    el('figcaption', {}, `Sign-ups, last 14 days (${total})`),
    el(
      'div',
      { class: 'admin-bars', role: 'list' },
      days.map(d => {
        const label = `${day(d.day)}: ${d.count} sign-up${d.count === 1 ? '' : 's'}`;
        const bar = el('span', { class: 'admin-bar' });
        bar.style.height = `${(d.count / max) * 100}%`;
        return el(
          'div',
          { class: 'admin-bar-slot', role: 'listitem', title: label, 'aria-label': label },
          el('span', { class: 'admin-bar-value' }, d.count ? d.count : ''),
          el('span', { class: 'admin-bar-track' }, bar),
          // Just the day of the month: fourteen full dates don't fit a phone.
          // The bar's own label carries the full date.
          el('span', { class: 'admin-bar-day' }, Number(d.day.slice(8, 10))),
        );
      }),
    ),
  );
}

// ----- Activity -----
const HIDDEN_FIELDS = new Set([
  'id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'slug',
]);
// An entries UPDATE that moved created_by: Link entries or Unlink (admin_link_entries).
function ownerChanged(change) {
  return (
    change.table_name === 'entries' &&
    change.op === 'UPDATE' &&
    (change.old_row?.created_by ?? null) !== (change.new_row?.created_by ?? null)
  );
}
function describe(change, raceNames) {
  const row = change.new_row || change.old_row || {};
  // Profiles are logged on a rename only (add_access_requests migration).
  if (change.table_name === 'profiles') {
    return `Renamed ${change.old_row?.display_name || 'someone'} to ${row.display_name || 'someone'}`;
  }
  if (change.table_name === 'entries') {
    const race = raceNames.get(row.race_id) || 'a race that no longer exists';
    const who = row.name || 'someone';
    if (change.op === 'INSERT') return `Added ${who}'s commitment (${fmt(row.level)}) to ${race}`;
    if (change.op === 'DELETE') return `Removed ${who}'s commitment from ${race}`;
    if (ownerChanged(change)) {
      // No admin behind it (null changed_by): the FK clearing a deleted account's
      // entries, or a dashboard edit. Don't call that a link.
      if (!change.changed_by)
        return `Owner changed on ${who}'s commitment on ${race} (dashboard or system)`;
      return change.new_row.created_by
        ? `Linked ${who}'s commitment on ${race} to an account`
        : `Unlinked ${who}'s commitment on ${race} from an account`;
    }
    return `Changed ${who}'s commitment on ${race}`;
  }
  const race = `${row.name || 'a race'}${row.date ? ` (${day(row.date)})` : ''}`;
  if (change.op === 'INSERT') return `Added race ${race}`;
  if (change.op === 'DELETE') return `Deleted race ${race} for good`;
  if (!change.old_row.deleted_at && change.new_row.deleted_at) return `Removed race ${race}`;
  if (change.old_row.deleted_at && !change.new_row.deleted_at) return `Restored race ${race}`;
  return `Edited race ${race}`;
}
function diffList(change) {
  if (change.op !== 'UPDATE') return null;
  const items = Object.keys(change.new_row)
    .filter(k => !HIDDEN_FIELDS.has(k))
    .filter(k => JSON.stringify(change.old_row[k]) !== JSON.stringify(change.new_row[k]))
    .map(k =>
      el(
        'li',
        {},
        el('span', { class: 'admin-field' }, k.replace(/_/g, ' ')),
        ' ',
        el('del', {}, fmt(change.old_row[k])),
        ' → ',
        el('ins', {}, fmt(change.new_row[k])),
      ),
    );
  return items.length ? el('ul', { class: 'admin-diff' }, items) : null;
}
function activitySection(activity, raceNames) {
  const list = el('ol', { class: 'admin-activity' });
  const tableFilter = el(
    'select',
    { 'aria-label': 'Show changes to' },
    el('option', { value: '' }, 'Everything'),
    el('option', { value: 'entries' }, 'Commitments'),
    el('option', { value: 'races' }, 'Races'),
    el('option', { value: 'profiles' }, 'Name changes'),
  );
  // Who made the change: every account in this feed, by id, shown by label.
  const people = new Map();
  for (const c of activity) {
    if (c.changed_by && !people.has(c.changed_by)) {
      people.set(c.changed_by, c.changed_by_label || 'Unnamed account');
    }
  }
  const personFilter = el(
    'select',
    { 'aria-label': 'Show changes by' },
    el('option', { value: '' }, 'Anyone'),
    [...people]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, label]) => el('option', { value: id }, label)),
  );
  const deletesOnly = el('input', { type: 'checkbox' });
  function render() {
    const rows = activity.filter(
      c =>
        (!tableFilter.value || c.table_name === tableFilter.value) &&
        (!personFilter.value || c.changed_by === personFilter.value) &&
        (!deletesOnly.checked ||
          c.op === 'DELETE' ||
          (c.new_row && c.new_row.deleted_at && !c.old_row?.deleted_at)),
    );
    list.replaceChildren(
      ...(rows.length
        ? rows.map(c => activityItem(c, raceNames))
        : [
            el(
              'li',
              { class: 'admin-empty' },
              tableFilter.value || personFilter.value || deletesOnly.checked
                ? 'Nothing matches these filters in the last 30 days.'
                : 'No changes in the last 30 days.',
            ),
          ]),
    );
  }
  tableFilter.addEventListener('change', render);
  personFilter.addEventListener('change', render);
  deletesOnly.addEventListener('change', render);
  render();
  return card(
    'Activity (last 30 days)',
    el(
      'div',
      { class: 'admin-filters' },
      tableFilter,
      personFilter,
      el('label', { class: 'admin-check' }, deletesOnly, ' Removals only'),
    ),
    list,
  );
}
function activityItem(change, raceNames) {
  const text = describe(change, raceNames);
  const error = errorLine();
  const who =
    change.changed_by_label || (change.changed_role ? change.changed_role : 'Dashboard or system');
  let action = null;
  if (change.table_name === 'profiles') {
    // admin_undo handles entries and races only. A rename is put right by
    // asking the member, or in the dashboard.
  } else if (ownerChanged(change)) {
    // admin_undo refuses this (20261016120000): it restores every column but
    // created_by, so it would put the old name back and leave the entry linked.
    // Hiding the button is a courtesy. Reverse it from the account.
    action = el('span', { class: 'admin-badge' }, 'Reverse in Accounts → Link entries');
  } else if (change.undone_at) {
    action = el('span', { class: 'admin-badge' }, `Undone ${when(change.undone_at)}`);
  } else {
    action = el(
      'button',
      {
        class: 'secondary-button admin-small-button',
        type: 'button',
        onclick: async e => {
          const button = e.currentTarget;
          if (
            !(await confirmDialog({ title: 'Undo this change?', body: text, confirmLabel: 'Undo' }))
          )
            return;
          error.set('');
          setBusy(button, 'Undoing…');
          try {
            await rpc('admin_undo', { p_change_id: change.id });
            showConsole();
          } catch (err) {
            error.set("Couldn't undo: " + err.message);
            clearBusy(button);
          }
        },
      },
      'Undo',
    );
  }
  return el(
    'li',
    { class: `admin-change admin-change-${change.op.toLowerCase()}` },
    el(
      'div',
      { class: 'admin-change-main' },
      el('p', { class: 'admin-change-text' }, text),
      diffList(change),
      el('p', { class: 'admin-change-meta' }, `${who} · ${when(change.changed_at)}`),
      error,
    ),
    action,
  );
}

// ----- Removed races -----
function removedSection(removed) {
  const body = removed.length
    ? el('ul', { class: 'admin-list' }, removed.map(removedItem))
    : el('p', { class: 'admin-empty' }, 'No removed races.');
  return card('Removed races', body);
}
function removedItem(r) {
  const error = errorLine();
  return el(
    'li',
    {},
    el(
      'div',
      {},
      el('p', { class: 'admin-change-text' }, `${r.name} (${day(r.date)})`),
      el(
        'p',
        { class: 'admin-change-meta' },
        `Removed ${when(r.deleted_at)}${r.removed_by_label ? ` by ${r.removed_by_label}` : ''} · ${r.entry_count} commitment${Number(r.entry_count) === 1 ? '' : 's'}`,
      ),
      error,
    ),
    el(
      'button',
      {
        class: 'secondary-button admin-small-button',
        type: 'button',
        onclick: async e => {
          const button = e.currentTarget;
          error.set('');
          setBusy(button, 'Restoring…');
          try {
            await rpc('admin_restore_race', { p_race_id: r.id });
            showConsole();
          } catch (err) {
            error.set("Couldn't restore: " + err.message);
            clearBusy(button);
          }
        },
      },
      'Restore',
    ),
  );
}

// ----- Accounts -----
function usersSection(users, resetsReady, notice) {
  const yes = (flag, text) =>
    el(
      'span',
      { class: flag ? 'admin-yes' : 'admin-no' },
      flag ? text : `Not ${text.toLowerCase()}`,
    );
  const rows = users.map(u => {
    const { account, actions } = accountCells(u, resetsReady);
    return el(
      'tr',
      {},
      el(
        'td',
        {},
        el('span', { class: 'admin-user-email' }, u.email || '—'),
        account,
        u.is_admin ? el('span', { class: 'admin-badge' }, 'Admin') : null,
      ),
      el('td', {}, yes(u.on_allow_list, 'Listed')),
      el('td', {}, yes(u.confirmed, 'Confirmed')),
      el('td', {}, when(u.created_at)),
      el('td', {}, u.last_sign_in_at ? when(u.last_sign_in_at) : 'Never'),
      el('td', { class: 'admin-num' }, fmt(u.changes_30d)),
      el('td', {}, actions),
    );
  });
  const accounts = card(
    'Accounts',
    notice || null,
    el(
      'p',
      { class: 'admin-hint' },
      'A bot account usually looks like: not listed, not confirmed, never signed in. Deleting an account happens in Supabase → Authentication → Users.',
    ),
    el(
      'div',
      { class: 'admin-table-wrap' },
      el(
        'table',
        { class: 'admin-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            [
              'Account',
              'Allow-list',
              'Email',
              'Signed up',
              'Last sign-in',
              'Changes (30d)',
              'Actions',
            ].map(h => el('th', { scope: 'col' }, h)),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
  );
  accounts.id = 'accounts';
  return accounts;
}

// ----- Allow-list -----
function allowListSection() {
  const email = el('input', {
    type: 'email',
    placeholder: 'member@example.com',
    'aria-label': 'Email address to check, add or remove',
  });
  const result = el('p', { class: 'admin-result', role: 'status' });
  async function act(button, name, busy, done) {
    const address = email.value.trim();
    if (!address) return email.focus();
    setBusy(button, busy);
    try {
      const data = await rpc(name, { p_email: address });
      result.textContent = done(data, address);
    } catch (err) {
      result.textContent = err.message;
    } finally {
      clearBusy(button);
    }
  }
  const check = el('button', { class: 'secondary-button', type: 'button' }, 'Check');
  const add = el('button', { class: 'primary-button', type: 'button' }, 'Add');
  const remove = el('button', { class: 'secondary-button', type: 'button' }, 'Remove');
  check.onclick = () =>
    act(check, 'admin_allow_list_check', 'Checking…', (listed, a) =>
      listed ? `${a} is on the allow-list.` : `${a} is not on the allow-list.`,
    );
  add.onclick = () =>
    act(add, 'admin_allow_list_add', 'Adding…', (r, a) =>
      r.added
        ? `Added ${a}. They can edit as soon as they next sign in.`
        : `${a} was already on the allow-list.`,
    );
  remove.onclick = async () => {
    const address = email.value.trim();
    if (!address) return email.focus();
    if (
      !(await confirmDialog({
        title: 'Remove from the allow-list?',
        body: `Remove ${address} from the allow-list? They lose edit access straight away.`,
      }))
    )
      return;
    act(remove, 'admin_allow_list_remove', 'Removing…', (r, a) =>
      r.removed ? `Removed ${a}.` : `${a} wasn't on the allow-list.`,
    );
  };
  return card(
    'Allow-list',
    el(
      'p',
      { class: 'admin-hint' },
      'The list stores only a keyed hash of each address, so it can’t be shown. Check, add or remove one address at a time. Add works only for an account that already exists and has confirmed its email; new members ask to join and appear under Requests.',
    ),
    el('div', { class: 'admin-form admin-allow-form' }, email, check, add, remove),
    result,
  );
}

// ----- Requests (add_access_requests migration) -----
const STATUS_LABEL = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  revoked: 'Access removed',
};
// What each state lets the admin do, in admin_decide_request()'s terms.
const DECISIONS = {
  pending: [
    ['approve', 'Approve', 'primary-button'],
    ['reject', 'Reject', 'secondary-button'],
  ],
  approved: [['revoke', 'Remove access', 'secondary-button']],
  rejected: [['reapprove', 'Approve after all', 'secondary-button']],
  revoked: [['reapprove', 'Give access back', 'secondary-button']],
};
// Batch approval: at most this many in one go, so a mis-tap can't approve the
// whole queue. admin_approve_requests() enforces the same limit.
const BATCH_LIMIT = 50;
// The club roster (spec A10): a hint, never an approval. The admin loads a
// file of addresses (a JustGo export, say); it is read in this browser only,
// kept in page memory until reload, and never sent anywhere. Waiting requests
// whose email is on it are marked, and "Choose all on roster" ticks them.
let rosterEmails = null;
const EMAIL_IN_TEXT = /[^\s,;:"'<>()[\]]+@[^\s,;:"'<>()[\]]+\.[^\s,;:"'<>()[\]]+/g;
function parseRoster(text) {
  return new Set((text.match(EMAIL_IN_TEXT) || []).map(e => e.trim().toLowerCase()));
}
const onRoster = r => !!rosterEmails && !!r.email && rosterEmails.has(r.email.trim().toLowerCase());
function requestsSection(requests, notice, matches) {
  if (requests === null) {
    return el(
      'section',
      { class: 'admin-card', id: 'requests' },
      el('h2', {}, 'Requests'),
      el(
        'p',
        { class: 'admin-hint' },
        'Not set up yet: the access-requests migration hasn’t been applied to the database.',
      ),
    );
  }
  const list = el('ol', { class: 'admin-list admin-requests' });
  // Waiting requests the admin has ticked, by user id. Each row still shows the
  // name, email and note: ticking one is the same check as pressing Approve.
  const chosen = new Set();
  const batchError = errorLine();
  const approveChosen = el(
    'button',
    { class: 'primary-button admin-small-button', type: 'button', disabled: true },
    'Approve chosen',
  );
  const clearChosen = el(
    'button',
    { class: 'text-button', type: 'button', disabled: true },
    'Clear',
  );
  const chooseAll = el('button', { class: 'text-button', type: 'button' }, 'Choose all waiting');
  const chooseRoster = el(
    'button',
    { class: 'text-button', type: 'button' },
    'Choose all on roster',
  );
  const rosterFile = el('input', {
    type: 'file',
    accept: '.csv,.txt,text/csv,text/plain',
    class: 'admin-roster-file',
    'aria-label': 'Load club roster',
  });
  const rosterStatus = el('span', { class: 'admin-hint admin-roster-status', role: 'status' });
  const rosterLabel = el(
    'label',
    { class: 'text-button admin-roster-load' },
    'Load club roster',
    rosterFile,
  );
  const batchBar = el(
    'div',
    { class: 'admin-batch' },
    approveChosen,
    chooseAll,
    chooseRoster,
    clearChosen,
    rosterLabel,
    rosterStatus,
  );
  function syncRoster() {
    const waiting = requests.filter(r => r.status === 'pending');
    chooseRoster.hidden = !rosterEmails;
    rosterStatus.textContent = rosterEmails
      ? `Roster: ${rosterEmails.size} addresses. ${waiting.filter(onRoster).length} of ${waiting.length} waiting are on it.`
      : '';
  }
  rosterFile.addEventListener('change', async () => {
    const file = rosterFile.files?.[0];
    if (!file) return;
    batchError.set('');
    const found = parseRoster(await file.text());
    rosterFile.value = '';
    if (!found.size) {
      batchError.set('No email addresses found in that file.');
      return;
    }
    rosterEmails = found;
    render();
    syncBatch();
    syncRoster();
  });
  chooseRoster.onclick = () => {
    batchError.set('');
    for (const r of requests) {
      if (r.status === 'pending' && onRoster(r) && chosen.size < BATCH_LIMIT) chosen.add(r.user_id);
    }
    syncBatch();
  };
  function syncBatch() {
    const n = chosen.size;
    approveChosen.textContent = n ? `Approve chosen (${n})` : 'Approve chosen';
    approveChosen.disabled = n === 0;
    clearChosen.disabled = n === 0;
    list.querySelectorAll('input[data-choose]').forEach(box => {
      box.checked = chosen.has(box.dataset.choose);
    });
  }
  function choose(id, on) {
    batchError.set('');
    if (on && chosen.size >= BATCH_LIMIT) {
      batchError.set(`Approve at most ${BATCH_LIMIT} at a time.`);
    } else if (on) {
      chosen.add(id);
    } else {
      chosen.delete(id);
    }
    syncBatch();
  }
  chooseAll.onclick = () => {
    batchError.set('');
    for (const r of requests) {
      if (r.status === 'pending' && chosen.size < BATCH_LIMIT) chosen.add(r.user_id);
    }
    syncBatch();
  };
  clearChosen.onclick = () => {
    chosen.clear();
    batchError.set('');
    syncBatch();
  };
  approveChosen.onclick = async () => {
    const ids = [...chosen];
    const n = ids.length;
    const ok = await confirmDialog({
      title: `Approve ${n} ${n === 1 ? 'person' : 'people'}?`,
      body: 'They can add and edit races straight away. Check each name and note before you go on.',
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    batchError.set('');
    [approveChosen, chooseAll, clearChosen].forEach(b => (b.disabled = true));
    setBusy(approveChosen, 'Approving…');
    try {
      const result = await rpcOptional('admin_approve_requests', { p_user_ids: ids });
      if (result.missing) {
        batchError.set(
          'Batch approval isn’t set up yet: its migration hasn’t been applied. Approve one at a time for now.',
        );
        clearBusy(approveChosen);
        chooseAll.disabled = false;
        syncBatch();
        return;
      }
      showConsole({ focus: 'requests', notice: batchNotice(result.data, requests) });
    } catch (err) {
      batchError.set(err.message);
      clearBusy(approveChosen);
      chooseAll.disabled = false;
      syncBatch();
    }
  };
  const statusFilter = el(
    'select',
    { 'aria-label': 'Show requests that are' },
    el('option', { value: 'pending' }, 'Waiting'),
    el('option', { value: '' }, 'All'),
    ['approved', 'rejected', 'revoked'].map(s => el('option', { value: s }, STATUS_LABEL[s])),
  );
  function render() {
    const rows = requests.filter(r => !statusFilter.value || r.status === statusFilter.value);
    batchBar.hidden = !rows.some(r => r.status === 'pending');
    list.replaceChildren(
      ...(rows.length
        ? rows.map(r => requestItem(r, choose, matches?.get(r.user_id)))
        : [
            el(
              'li',
              { class: 'admin-empty' },
              statusFilter.value === 'pending' ? 'Nobody is waiting.' : 'No requests here.',
            ),
          ]),
    );
  }
  statusFilter.addEventListener('change', () => {
    render();
    syncBatch();
  });
  render();
  syncBatch();
  syncRoster();
  const section = el(
    'section',
    { class: 'admin-card', id: 'requests' },
    el('h2', { tabindex: -1 }, 'Requests'),
    el(
      'p',
      { class: 'admin-hint' },
      'People who signed up and asked to join. Check the name and note before you approve: an email address proves nothing on its own.',
    ),
    notice || null,
    el('div', { class: 'admin-filters' }, statusFilter),
    batchBar,
    batchError,
    list,
  );
  // The match badges arrive after the first render.
  section.refresh = render;
  return section;
}
// What a batch did: how many went through, and who was skipped and why.
function batchNotice(data, requests) {
  const names = new Map(requests.map(r => [r.user_id, r.display_name]));
  const skipped = (data?.results || []).filter(x => !x.ok);
  const approved = data?.approved ?? 0;
  return el(
    'div',
    { class: 'admin-notice admin-batch-notice', role: 'status' },
    el(
      'p',
      {},
      `Approved ${approved} ${approved === 1 ? 'person' : 'people'}.`,
      skipped.length ? ` Skipped ${skipped.length}:` : '',
    ),
    skipped.length
      ? el(
          'ul',
          {},
          skipped.map(x =>
            el(
              'li',
              {},
              el('strong', {}, names.get(x.user_id) || 'Unknown account'),
              ` — ${x.error}`,
            ),
          ),
        )
      : null,
  );
}
function requestItem(r, choose, orphanCount) {
  const error = errorLine();
  const name = r.display_name;
  const reason = el('input', {
    type: 'text',
    maxlength: 200,
    placeholder: 'Reason (optional, only admins see it)',
    'aria-label': `Reason for the decision on ${name}`,
  });
  const buttons = (DECISIONS[r.status] || []).map(([decision, label, style]) => {
    const button = el('button', { class: `${style} admin-small-button`, type: 'button' }, label);
    button.onclick = async () => {
      // Saying no or taking access away is worth a second look; approving
      // isn't destructive, and the check is the reading the admin just did.
      if (decision === 'reject' || decision === 'revoke') {
        const ok = await confirmDialog({
          title: decision === 'reject' ? `Reject ${name}?` : `Remove ${name}'s access?`,
          body:
            decision === 'reject'
              ? `${name} will be signed out and can't ask again from this account.`
              : `${name} loses edit access straight away and will be signed out.`,
          confirmLabel: label,
        });
        if (!ok) return;
      }
      error.set('');
      buttons.forEach(b => (b.disabled = true));
      setBusy(button, 'Saving…');
      try {
        await rpc('admin_decide_request', {
          p_user_id: r.user_id,
          p_decision: decision,
          p_reason: reason.value.trim() || null,
        });
        showConsole({ focus: 'requests' });
      } catch (err) {
        error.set(err.message);
        clearBusy(button);
        buttons.forEach(b => (b.disabled = false));
      }
    };
    return button;
  });
  const notes = [];
  // A hint only: the admin still reads the name and note before approving.
  if (r.status === 'pending' && onRoster(r)) {
    notes.push(el('span', { class: 'admin-badge admin-roster' }, 'On club roster'));
  }
  // The Telegram message is the alert; the console is the record. A pending
  // request whose message never went shows that here (spec 6.4, step 8).
  if (r.status === 'pending' && !r.notified_at) {
    notes.push(el('span', { class: 'admin-badge admin-warn' }, 'Telegram message not sent'));
  }
  // An approved request whose address is no longer listed can't write: the
  // member sees "access removed" (my_access_status), so say so here too.
  if (r.status === 'approved' && !r.listed) {
    notes.push(el('span', { class: 'admin-badge admin-warn' }, 'Not on the allow-list'));
  }
  // A hint only: nothing is linked on approval. Link entries is a separate step.
  if (r.status === 'pending' && orphanCount > 0) {
    notes.push(
      el(
        'span',
        { class: 'admin-badge admin-orphans' },
        `${orphanCount} unlinked ${orphanCount === 1 ? 'entry matches' : 'entries match'} this name`,
      ),
    );
  }
  if (r.reset_pending) {
    // Spec R6: the console marks an expired temporary password.
    notes.push(
      new Date(r.reset_expires_at) < new Date()
        ? el('span', { class: 'admin-badge admin-warn' }, 'Temporary password expired')
        : el(
            'span',
            { class: 'admin-badge' },
            `Password reset pending until ${when(r.reset_expires_at)}`,
          ),
    );
  }
  const pick =
    r.status === 'pending' && choose
      ? el('input', {
          type: 'checkbox',
          class: 'admin-choose',
          'data-choose': r.user_id,
          'aria-label': `Choose ${name}`,
        })
      : null;
  if (pick) pick.addEventListener('change', () => choose(r.user_id, pick.checked));
  return el(
    'li',
    { class: 'admin-request' },
    pick,
    el(
      'div',
      { class: 'admin-change-main' },
      el(
        'p',
        { class: 'admin-change-text' },
        el('strong', {}, name),
        el('span', { class: `admin-badge admin-status-${r.status}` }, STATUS_LABEL[r.status]),
        notes,
      ),
      el('p', { class: 'admin-change-meta' }, r.email || 'Account deleted'),
      r.note ? el('blockquote', { class: 'admin-note' }, r.note) : null,
      el(
        'p',
        { class: 'admin-change-meta' },
        `Asked ${when(r.requested_at)}`,
        r.decided_at
          ? ` · ${STATUS_LABEL[r.status]} ${when(r.decided_at)}${r.decided_by_label ? ` by ${r.decided_by_label}` : ''}`
          : '',
        r.reason ? ` · “${r.reason}”` : '',
      ),
      buttons.length ? reason : null,
      error,
    ),
    buttons.length ? el('div', { class: 'admin-request-actions' }, buttons) : null,
  );
}

// ----- Account actions: one "Manage" menu per row -----
// Edit name, Link entries and Reset password sit behind a single button, so the row stays
// one line tall. Edit name swaps the name under the email for an input in
// place; Reset password keeps its confirm dialog.
function accountCells(u, resetsReady) {
  const name = u.display_name || u.email;
  const manage = el(
    'button',
    {
      class: 'secondary-button admin-small-button admin-menu-button',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': `Manage ${name}`,
    },
    'Manage',
  );
  const items = [];
  let account = null;
  if (u.display_name) {
    const rename = renameControl(u, manage);
    const link = linkControl(u, manage);
    account = [rename.node, link.node];
    items.push({ label: 'Edit name', run: rename.start });
    items.push({ label: 'Link entries', run: link.start });
  }
  const resetError = errorLine();
  const canReset = resetsReady && !u.is_admin;
  if (canReset) {
    items.push({ label: 'Reset password', run: () => resetPassword(u, manage, resetError) });
  }
  if (!items.length) return { account, actions: null };
  return {
    account,
    actions: el(
      'div',
      { class: canReset ? 'admin-reset' : null },
      actionsMenu(manage, name, items),
      resetError,
    ),
  };
}

// A menu button with the keyboard behaviour a screen reader expects: Enter,
// Space or Down opens it, arrows move, Escape closes and returns focus, Tab
// or a click elsewhere closes it. The list is fixed to the window, because
// the table's scroll box would clip a menu on the last row.
function actionsMenu(button, name, items) {
  const menu = el('div', {
    class: 'admin-menu',
    role: 'menu',
    'aria-label': `Manage ${name}`,
    hidden: true,
  });
  const buttons = items.map(item => {
    const b = el(
      'button',
      { class: 'admin-menu-item', type: 'button', role: 'menuitem', tabindex: '-1' },
      item.label,
    );
    b.onclick = () => {
      close(false);
      item.run();
    };
    return b;
  });
  menu.append(...buttons);
  const away = e => {
    if (!menu.contains(e.target) && !button.contains(e.target)) close(false);
  };
  // The list is fixed to the window, so it follows the button as the page
  // scrolls or resizes.
  const place = () => {
    const box = button.getBoundingClientRect();
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`;
  };
  function close(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', away, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    if (refocus) button.focus();
  }
  function open(focusIndex) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    buttons.at(focusIndex)?.focus();
    document.addEventListener('click', away, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
  }
  button.onclick = () => (menu.hidden ? open(0) : close(true));
  button.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menu.hidden) open(e.key === 'ArrowDown' ? 0 : -1);
    }
  };
  menu.onkeydown = e => {
    const at = buttons.indexOf(document.activeElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: -1 }[e.key];
    if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') close(false);
    else if (move !== undefined) {
      e.preventDefault();
      buttons.at(move % buttons.length)?.focus();
    }
  };
  return el('span', { class: 'admin-menu-anchor' }, button, menu);
}

// ----- Display name (admin_rename_member) -----
// The one place a member's name changes. It updates the profile and every
// commitment that member created, so the roster follows. Members see their
// name read-only on the commitment form.
function renameControl(u, manage) {
  const nameLine = el('span', { class: 'admin-change-meta' }, u.display_name);
  const error = errorLine();
  const input = el('input', {
    type: 'text',
    value: u.display_name,
    maxlength: '40',
    'aria-label': `Display name for ${u.email || u.display_name}`,
  });
  const save = el('button', { class: 'primary-button admin-small-button', type: 'button' }, 'Save');
  const cancel = el(
    'button',
    { class: 'secondary-button admin-small-button', type: 'button' },
    'Cancel',
  );
  const form = el('div', { class: 'admin-rename-form', hidden: true }, input, save, cancel);
  const node = el('div', { class: 'admin-rename' }, nameLine, form, error);
  const show = on => {
    form.hidden = !on;
    nameLine.hidden = on;
    // One thing at a time: the menu waits while the name is open for editing.
    manage.disabled = on;
    error.set('');
    if (on) {
      input.value = u.display_name;
      input.focus();
    } else manage.focus();
  };
  cancel.onclick = () => show(false);
  input.onkeydown = e => {
    if (e.key === 'Enter') {
      // Without this, the same keypress lands on the confirm button that
      // Save is about to open, and confirms the rename unseen.
      e.preventDefault();
      save.click();
    } else if (e.key === 'Escape') show(false);
  };
  save.onclick = async () => {
    const name = input.value.trim();
    if (!name || name === u.display_name) return show(false);
    const ok = await confirmDialog({
      title: `Rename ${u.display_name}?`,
      body: `${u.display_name} will appear as “${name}” on every commitment they've made. Members can't change this themselves.`,
      confirmLabel: 'Rename',
    });
    if (!ok) return;
    error.set('');
    setBusy(save, 'Saving…');
    try {
      await rpc('admin_rename_member', { p_user_id: u.id, p_name: name });
      showConsole();
    } catch (err) {
      error.set("Couldn't rename: " + err.message);
      clearBusy(save);
    }
  };
  return { node, start: () => show(true) };
}

// ----- Link entries (admin_link_candidates / admin_link_entries / admin_unlink_entries) -----
// Entries with no owner (created_by null) predate attribution or came from the
// dashboard. Linking attaches them to this account and renames them to its
// display name; Unlink clears the owner and leaves the name. The list is only
// fetched when the button is pressed, so the console loads without the migration.
const LINK_LIMIT = 50;
const fullDay = isoDate => `${day(isoDate)} ${isoDate.slice(0, 4)}`;
function linkControl(u, manage) {
  const box = el('div', { class: 'admin-link-entries' });
  const error = errorLine();
  const panel = el('div', { class: 'admin-link-panel', hidden: true });
  const label = u.display_name;
  let rows = [];
  let loading = false;

  const entryLabel = c =>
    `${c.race_name}, ${fullDay(c.race_date)}: ${c.name}${c.events?.length ? ` (${c.events.join(', ')}${c.level ? `, ${c.level}` : ''})` : c.level ? ` (${c.level})` : ''}`;

  function group(title, items, kind) {
    const boxes = items.map(c => {
      const input = el('input', {
        type: 'checkbox',
        'data-entry': c.entry_id,
        'aria-label': `${kind === 'unlink' ? 'Unlink' : 'Link'} ${entryLabel(c)}`,
      });
      input.checked = kind === 'link' && c.name_match;
      return { c, input };
    });
    const fieldset = el(
      'fieldset',
      { class: 'admin-link-group', 'data-group': kind },
      el('legend', {}, `${title} (${items.length})`),
      items.length
        ? el(
            'ul',
            { class: 'admin-link-list' },
            boxes.map(({ c, input }) =>
              el(
                'li',
                {},
                el(
                  'label',
                  { class: 'admin-link-row' },
                  input,
                  el(
                    'span',
                    {},
                    el('strong', {}, c.race_name),
                    ` · ${fullDay(c.race_date)} · `,
                    c.name,
                    el(
                      'span',
                      { class: 'admin-change-meta' },
                      [c.events?.length ? c.events.join(', ') : null, c.level]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                ),
              ),
            ),
          )
        : el(
            'p',
            { class: 'admin-empty' },
            kind === 'unlink' ? 'None yet.' : 'No unlinked entries on live races.',
          ),
    );
    return { fieldset, boxes };
  }

  function render() {
    const linked = group(
      'Linked to this account',
      rows.filter(c => c.linked),
      'unlink',
    );
    const orphans = group(
      'Unlinked entries',
      rows.filter(c => !c.linked),
      'link',
    );
    const linkBtn = el(
      'button',
      { class: 'primary-button admin-small-button', type: 'button', disabled: true },
      'Link chosen',
    );
    const unlinkBtn = el(
      'button',
      { class: 'secondary-button admin-small-button', type: 'button', disabled: true },
      'Unlink chosen',
    );
    const close = el('button', { class: 'text-button', type: 'button' }, 'Close');
    const ticked = g => g.boxes.filter(b => b.input.checked).map(b => b.c);
    // True while a link or unlink is in flight: ticking a box must not re-enable either button.
    let inFlight = false;
    const sync = () => {
      linkBtn.disabled = inFlight || !ticked(orphans).length;
      unlinkBtn.disabled = inFlight || !ticked(linked).length;
    };
    for (const { input } of [...linked.boxes, ...orphans.boxes]) {
      input.addEventListener('change', () => {
        error.set('');
        sync();
      });
    }
    sync();
    const busy = on => {
      inFlight = on;
      sync();
    };
    linkBtn.onclick = async () => {
      const picked = ticked(orphans);
      if (!picked.length) return;
      if (picked.length > LINK_LIMIT) {
        return error.set(
          `Link at most ${LINK_LIMIT} at a time. Untick ${picked.length - LINK_LIMIT}.`,
        );
      }
      const renames = picked.filter(c => c.name !== label.trim());
      const ok = await confirmDialog({
        title: `Link ${picked.length} ${picked.length === 1 ? 'entry' : 'entries'} to ${label}?`,
        body:
          `${label} will own ${picked.length === 1 ? 'this entry' : `these ${picked.length} entries`} and can write ${picked.length === 1 ? 'its' : 'their'} results. Every linked entry is named “${label}”.` +
          (renames.length
            ? `\n\nRenamed:\n${renames.map(c => `${c.name} → ${label}, ${c.race_name}`).join('\n')}`
            : '') +
          '\n\nThe old names are kept in the admin log.',
        confirmLabel: 'Link',
      });
      if (!ok) return;
      error.set('');
      busy(true);
      setBusy(linkBtn, 'Linking…');
      try {
        const out = await rpc('admin_link_entries', {
          p_user_id: u.id,
          p_entry_ids: picked.map(c => c.entry_id),
        });
        showConsole({
          accountNotice: el(
            'p',
            { class: 'admin-notice', role: 'status' },
            `Linked ${out?.linked ?? picked.length} ${(out?.linked ?? picked.length) === 1 ? 'entry' : 'entries'} to ${label}${out?.renamed ? ` (${out.renamed} renamed)` : ''}.`,
          ),
        });
      } catch (err) {
        error.set("Couldn't link: " + err.message);
        clearBusy(linkBtn);
        busy(false);
      }
    };
    unlinkBtn.onclick = async () => {
      const picked = ticked(linked);
      if (!picked.length) return;
      if (picked.length > LINK_LIMIT) {
        return error.set(
          `Unlink at most ${LINK_LIMIT} at a time. Untick ${picked.length - LINK_LIMIT}.`,
        );
      }
      const ok = await confirmDialog({
        title: `Unlink ${picked.length} ${picked.length === 1 ? 'entry' : 'entries'} from ${label}?`,
        body: `${label} will no longer own ${picked.length === 1 ? 'it' : 'them'}. The names stay as they are (“${label}”), so by name ${label} can still write the results. Rename in the dashboard to detach fully.`,
        confirmLabel: 'Unlink',
      });
      if (!ok) return;
      error.set('');
      busy(true);
      setBusy(unlinkBtn, 'Unlinking…');
      try {
        const out = await rpc('admin_unlink_entries', {
          p_user_id: u.id,
          p_entry_ids: picked.map(c => c.entry_id),
        });
        const n = out?.unlinked ?? picked.length;
        showConsole({
          accountNotice: el(
            'p',
            { class: 'admin-notice', role: 'status' },
            `Unlinked ${n} ${n === 1 ? 'entry' : 'entries'} from ${label}. Names were left as they are.`,
          ),
        });
      } catch (err) {
        error.set("Couldn't unlink: " + err.message);
        clearBusy(unlinkBtn);
        busy(false);
      }
    };
    close.onclick = () => {
      panel.hidden = true;
      manage.disabled = false;
      manage.focus();
    };
    panel.replaceChildren(
      el(
        'p',
        { class: 'admin-hint' },
        `Entries that match “${label}” are ticked. Linking renames them to “${label}”.`,
      ),
      linked.fieldset,
      orphans.fieldset,
      el('div', { class: 'admin-link-actions' }, linkBtn, unlinkBtn, close),
    );
  }

  async function start() {
    if (loading) return;
    loading = true;
    error.set('');
    manage.disabled = true;
    try {
      const result = await rpcOptional('admin_link_candidates', { p_user_id: u.id });
      if (result.missing) {
        error.set(
          "Linking entries isn't set up yet: the link-entries migration hasn't been applied.",
        );
      } else {
        rows = result.data || [];
        render();
        panel.hidden = false;
        panel.querySelector('input')?.focus();
      }
    } catch (err) {
      error.set("Couldn't load entries: " + err.message);
    }
    loading = false;
    // The menu waits while the panel is open; a failed load gives it back.
    if (panel.hidden) manage.disabled = false;
  }
  box.append(panel, error);
  return { node: box, start };
}

// ----- Password reset (admin-reset-password Edge Function) -----
// The Manage button carries the "Resetting…" state, since the menu item is
// out of sight once the menu closes.
async function resetPassword(u, manage, error) {
  const name = u.display_name || u.email;
  const ok = await confirmDialog({
    title: `Reset ${name}'s password?`,
    body: `${name} will be signed out on every device. You'll get a temporary password to give them; they choose their own when they next sign in.`,
    confirmLabel: 'Reset',
  });
  if (!ok) return;
  error.set('');
  // Disabled while in flight: a second click would set a second password,
  // and only the last one would work.
  const label = manage.getAttribute('aria-label');
  manage.removeAttribute('aria-label');
  setBusy(manage, 'Resetting…');
  const { data, error: fnError } = await db.functions.invoke('admin-reset-password', {
    body: { user_id: u.id },
  });
  clearBusy(manage);
  manage.setAttribute('aria-label', label);
  if (fnError) {
    // An HTTP error carries the function's Response; a network or CORS
    // failure (for example, the function isn't deployed) carries none.
    const res = fnError.context;
    let text = 'Couldn’t reach the password reset service. It may not be set up yet.';
    if (res instanceof Response) {
      text = fnError.message;
      if (res.status === 404) text = 'Password resets aren’t set up yet.';
      else {
        try {
          text = (await res.json()).error || text;
        } catch {
          // keep the generic message
        }
      }
    }
    error.set("Couldn't reset: " + text);
    return;
  }
  // A dialog outside the console, so a re-render (Refresh, a decision, an
  // Undo) can't wipe the password, even one that arrives mid-render.
  showPasswordDialog(name, data);
}
// Shown once, in a dialog that only Done closes (Escape doesn't, so a stray
// key can't lose it). Nothing keeps the password after that.
function showPasswordDialog(name, data) {
  const done = el('button', { class: 'primary-button', type: 'button' }, 'Done');
  const dialog = el(
    'dialog',
    { class: 'admin-reveal-dialog', 'aria-labelledby': 'adminRevealTitle' },
    el(
      'div',
      { class: 'dialog-card' },
      el('h2', { id: 'adminRevealTitle' }, `Temporary password for ${name}`),
      revealPassword(name, data),
      el('div', { class: 'dialog-footer' }, done),
    ),
  );
  dialog.addEventListener('cancel', e => e.preventDefault());
  dialog.addEventListener('close', () => dialog.remove());
  done.onclick = () => dialog.close();
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('.admin-reveal button')?.focus();
}
function revealPassword(name, data) {
  const value = el('code', { class: 'admin-temp-password' }, data.password);
  const copied = el('span', { class: 'admin-change-meta', role: 'status' });
  const copy = el(
    'button',
    { class: 'secondary-button admin-small-button', type: 'button' },
    'Copy',
  );
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(data.password);
      copied.textContent = 'Copied.';
    } catch {
      copied.textContent = 'Select the password and copy it.';
    }
  };
  return el(
    'div',
    { class: 'admin-reveal' },
    el('div', { class: 'admin-reveal-row' }, value, copy, copied),
    el(
      'p',
      { class: 'admin-hint' },
      `Send this to ${name} by text or in person. It works once. They'll set their own on sign-in.`,
      data.expires_at ? ` It stops working ${when(data.expires_at)}.` : '',
    ),
    data.signed_out === false
      ? el(
          'p',
          { class: 'admin-error' },
          'A device that signed in during the reset may still be signed in. Reset again to be sure.',
        )
      : null,
  );
}

// ----- Your password -----
// For the admin's own account: set a password the first time (the console
// used to sign in by emailed code only), or change it. Supabase's "Secure
// password change" may ask you to have signed in recently.
function passwordSection() {
  const first = el('input', {
    type: 'password',
    autocomplete: 'new-password',
    minlength: 12,
    required: true,
    placeholder: 'New password (12 to 72 characters)',
    'aria-label': 'New password',
  });
  const second = el('input', {
    type: 'password',
    autocomplete: 'new-password',
    minlength: 12,
    required: true,
    placeholder: 'Type it again',
    'aria-label': 'New password again',
  });
  const button = el('button', { class: 'primary-button', type: 'submit' }, 'Save password');
  const result = el('p', { class: 'admin-result', role: 'status' });
  const form = el('form', { class: 'admin-form' }, first, second, button);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    result.textContent = '';
    if (first.value !== second.value) {
      result.textContent = "Those two don't match.";
      return second.select();
    }
    // bcrypt reads 72 bytes and ignores the rest, so refuse rather than trim.
    if (new TextEncoder().encode(first.value).length > 72) {
      result.textContent = 'Keep it to 72 characters or fewer (accented letters count as two).';
      return first.select();
    }
    setBusy(button, 'Saving…');
    const { error } = await db.auth.updateUser({ password: first.value });
    clearBusy(button);
    if (error) {
      // "Secure password change" wants a recent sign-in, and sessions last weeks.
      result.textContent =
        error.code === 'reauthentication_needed' || /reauthentic/i.test(error.message)
          ? 'Supabase wants a recent sign-in for this. Sign out, sign in again, then save it.'
          : "Couldn't save it: " + error.message;
      return;
    }
    first.value = '';
    second.value = '';
    result.textContent =
      'Saved. Next time, sign in with your email and this password, then your authenticator code.';
  });
  return card(
    'Your password',
    el(
      'p',
      { class: 'admin-hint' },
      'Sign in with a password and your authenticator app. The emailed code keeps working as a fallback.',
    ),
    form,
    result,
  );
}

start();
