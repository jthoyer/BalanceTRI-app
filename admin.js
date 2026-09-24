// Admin console. Every read and write here goes through a public.admin_*
// function (add_admin_console migration), and each one refuses anyone who
// isn't in private.admins with a two-factor session. This page only decides
// which screen to show; the database is the boundary.
//
// Everything is built as DOM with textContent, never innerHTML: most of what
// this page shows (names, race titles, emails) was typed by members.
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
  root.replaceChildren(...nodes);
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
async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
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
// shouldCreateUser: false means this form can't create accounts.
// ---------------------------------------------------------------------------
function showSignIn() {
  const email = el('input', {
    type: 'email',
    name: 'email',
    required: true,
    autocomplete: 'email',
    placeholder: 'you@example.com',
    'aria-label': 'Admin email address',
  });
  const button = el('button', { class: 'primary-button', type: 'submit' }, 'Send code');
  const form = el('form', { class: 'admin-form' }, email, button);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const address = email.value.trim();
    setBusy(button, 'Sending…');
    try {
      const captchaToken = await getCaptchaToken(form);
      const { error } = await db.auth.signInWithOtp({
        email: address,
        options: { shouldCreateUser: false, emailRedirectTo: location.href, captchaToken },
      });
      if (error) throw error;
      showCodeStep(address);
    } catch (err) {
      alert('Could not send the code: ' + err.message);
      clearBusy(button);
    }
  });
  show(
    card(
      'Admin sign-in',
      el('p', { class: 'admin-hint' }, "Enter your admin email. We'll send a 6-digit code."),
      form,
    ),
  );
  email.focus();
}
function showCodeStep(address) {
  const code = codeInput('6-digit code from your email');
  const button = el('button', { class: 'primary-button', type: 'submit' }, 'Sign in');
  const form = el('form', { class: 'admin-form' }, code, button);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    setBusy(button, 'Signing in…');
    const { error } = await db.auth.verifyOtp({ email: address, token: code.value, type: 'email' });
    if (error) {
      alert("That code didn't work: " + error.message);
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
  form.addEventListener('submit', async e => {
    e.preventDefault();
    setBusy(button, 'Checking…');
    const { error } = await db.auth.mfa.challengeAndVerify({ factorId, code: code.value });
    if (error) {
      alert("That code didn't work: " + error.message);
      clearBusy(button);
      code.select();
      return;
    }
    start();
  });
  show(card(title, el('p', { class: 'admin-hint' }, text), extra, form));
  code.focus();
}

// ---------------------------------------------------------------------------
// The console.
// ---------------------------------------------------------------------------
async function showConsole() {
  show(el('p', { class: 'admin-loading' }, 'Loading…'));
  let stats, activity, removed, users, races;
  try {
    [stats, activity, removed, users, races] = await Promise.all([
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
    ]);
  } catch (e) {
    return message('Could not load the console', e.message);
  }
  const raceNames = new Map(races.map(r => [r.id, `${r.name} (${day(r.date)})`]));
  const me = users.find(u => u.is_admin && u.email);
  show(
    el(
      'div',
      { class: 'admin-title' },
      el('h1', {}, 'Admin console'),
      el('button', { class: 'text-button', type: 'button', onclick: showConsole }, 'Refresh'),
    ),
    me && !me.on_allow_list ? allowListWarning(me.email) : null,
    statsSection(stats),
    activitySection(activity, raceNames),
    removedSection(removed),
    usersSection(users),
    allowListSection(),
  );
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
function describe(change, raceNames) {
  const row = change.new_row || change.old_row || {};
  if (change.table_name === 'entries') {
    const race = raceNames.get(row.race_id) || 'a race that no longer exists';
    const who = row.name || 'someone';
    if (change.op === 'INSERT') return `Added ${who}'s commitment (${fmt(row.level)}) to ${race}`;
    if (change.op === 'DELETE') return `Removed ${who}'s commitment from ${race}`;
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
  );
  const deletesOnly = el('input', { type: 'checkbox' });
  function render() {
    const rows = activity.filter(
      c =>
        (!tableFilter.value || c.table_name === tableFilter.value) &&
        (!deletesOnly.checked ||
          c.op === 'DELETE' ||
          (c.new_row && c.new_row.deleted_at && !c.old_row?.deleted_at)),
    );
    list.replaceChildren(
      ...(rows.length
        ? rows.map(c => activityItem(c, raceNames))
        : [el('li', { class: 'admin-empty' }, 'No changes in the last 30 days.')]),
    );
  }
  tableFilter.addEventListener('change', render);
  deletesOnly.addEventListener('change', render);
  render();
  return card(
    'Activity (last 30 days)',
    el(
      'div',
      { class: 'admin-filters' },
      tableFilter,
      el('label', { class: 'admin-check' }, deletesOnly, ' Removals only'),
    ),
    list,
  );
}
function activityItem(change, raceNames) {
  const text = describe(change, raceNames);
  const who =
    change.changed_by_label || (change.changed_role ? change.changed_role : 'Dashboard or system');
  let action;
  if (change.undone_at) {
    action = el('span', { class: 'admin-badge' }, `Undone ${when(change.undone_at)}`);
  } else {
    action = el(
      'button',
      {
        class: 'secondary-button admin-small-button',
        type: 'button',
        onclick: async e => {
          if (!confirm(`Undo this change?\n\n${text}`)) return;
          const button = e.currentTarget;
          setBusy(button, 'Undoing…');
          try {
            await rpc('admin_undo', { p_change_id: change.id });
            showConsole();
          } catch (err) {
            alert("Couldn't undo: " + err.message);
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
    ),
    action,
  );
}

// ----- Removed races -----
function removedSection(removed) {
  const body = removed.length
    ? el(
        'ul',
        { class: 'admin-list' },
        removed.map(r =>
          el(
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
            ),
            el(
              'button',
              {
                class: 'secondary-button admin-small-button',
                type: 'button',
                onclick: async e => {
                  const button = e.currentTarget;
                  setBusy(button, 'Restoring…');
                  try {
                    await rpc('admin_restore_race', { p_race_id: r.id });
                    showConsole();
                  } catch (err) {
                    alert("Couldn't restore: " + err.message);
                    clearBusy(button);
                  }
                },
              },
              'Restore',
            ),
          ),
        ),
      )
    : el('p', { class: 'admin-empty' }, 'No removed races.');
  return card('Removed races', body);
}

// ----- Accounts -----
function usersSection(users) {
  const yes = (flag, text) =>
    el(
      'span',
      { class: flag ? 'admin-yes' : 'admin-no' },
      flag ? text : `Not ${text.toLowerCase()}`,
    );
  const rows = users.map(u =>
    el(
      'tr',
      {},
      el(
        'td',
        {},
        el('span', { class: 'admin-user-email' }, u.email || '—'),
        u.display_name ? el('span', { class: 'admin-change-meta' }, u.display_name) : null,
        u.is_admin ? el('span', { class: 'admin-badge' }, 'Admin') : null,
      ),
      el('td', {}, yes(u.on_allow_list, 'Listed')),
      el('td', {}, yes(u.confirmed, 'Confirmed')),
      el('td', {}, when(u.created_at)),
      el('td', {}, u.last_sign_in_at ? when(u.last_sign_in_at) : 'Never'),
      el('td', { class: 'admin-num' }, fmt(u.changes_30d)),
    ),
  );
  return card(
    'Accounts',
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
            ['Account', 'Allow-list', 'Email', 'Signed up', 'Last sign-in', 'Changes (30d)'].map(
              h => el('th', { scope: 'col' }, h),
            ),
          ),
        ),
        el('tbody', {}, rows),
      ),
    ),
  );
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
  remove.onclick = () => {
    if (
      !confirm(
        `Remove ${email.value.trim()} from the allow-list? They lose edit access straight away.`,
      )
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
      'The list stores only a keyed hash of each address, so it can’t be shown. Check, add or remove one address at a time.',
    ),
    el('div', { class: 'admin-form admin-allow-form' }, email, check, add, remove),
    result,
  );
}

start();
