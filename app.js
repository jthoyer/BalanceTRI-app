// GitHub Pages has no server-side rewrites, so a direct hit on /race/<slug> —
// a shared link, or a refresh on a race screen — is served by 404.html, which
// bounces back here as <base>?/race/<slug>. Put the real path back before
// anything below reads location.pathname. The other half lives in 404.html.
//
// This runs from app.js rather than an inline script in <head> on purpose.
// Rewriting the URL mid-parse moves the document's base URL to <base>/race/,
// and every relative URL in the document parsed after that point — styles.css,
// the logo, app.js itself — resolves against it and 404s, leaving an unstyled
// page with no script. By the time app.js runs, the document has already
// resolved those, so the rewrite is safe here.
(function restoreDeepLinkPath() {
  const l = window.location;
  if (l.search.slice(0, 2) !== '?/') return;
  const parts = l.search.slice(1).split('&');
  const route = parts.shift();
  const query = parts.length ? '?' + parts.join('&').replace(/~and~/g, '&') : '';
  const base = l.pathname.replace(/index\.html$/, '').replace(/\/+$/, '');
  window.history.replaceState(null, '', base + route + query + l.hash);
})();
// Backed by Supabase. The URL and key live in shared.js; README.md has the schema.
//
// If vendor/supabase-js failed to load (a dropped connection mid-page-load, a
// stale cache after an upgrade renamed the file), window.supabase is missing
// and the createClient call below would throw before anything renders — a
// blank calendar with no explanation. Say so in the page instead, then stop:
// nothing below this line can work without the client.
if (!window.supabase?.createClient) {
  const emptyState = document.getElementById('emptyState');
  if (emptyState) {
    emptyState.textContent =
      'The calendar could not load. Check your connection and try refreshing.';
    emptyState.classList.remove('hidden');
  }
  throw new Error('supabase-js did not load (vendor/supabase-js-*.js); app.js stopped.');
}
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const levels = [
  ['considering', 'Considering'],
  ['planning', 'Planning'],
  ['locked', 'Locked in'],
];
const eventTypes = ['Balance Bolt', 'Bike', 'Multi-sport', 'Run', 'Swim', 'Triathlon'];
const BALANCE_BOLT_URL = 'https://jthoyer.github.io/BalanceBolt/';
// Balance Bolt race names hold the race number, plain ("3") or with the
// "BALANCE BOLT #1" lead-in older rows have — either way the number is the
// only digits in the name, and that's what BalanceBolt's own ?race= param wants.
function boltEmbedUrl(race) {
  // A stored URL wins only when it is BalanceBolt itself. Typed-in junk such as
  // "https://www.balancebolt/#2.com" falls through to the number-built address.
  if (race.url && isEmbeddableBoltUrl(race.url)) return race.url;
  const n = (race.name || '').match(/\d+/);
  return n ? `${BALANCE_BOLT_URL}?race=${n[0]}` : null;
}
// A race URL is typed by a member and stored in a row anyone signed in can
// edit, so it is untrusted input by the time it reaches the DOM. Two separate
// questions have to be asked of it.
//
// safeLinkUrl: may this be an href at all? Only http(s). A `javascript:` URL
// in an href is script execution one click away, and `data:` can carry a
// document of its own.
function safeLinkUrl(url) {
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
// isEmbeddableBoltUrl: may this be framed? Only BalanceBolt itself.
//
// This app and BalanceBolt are both served from jthoyer.github.io, so they
// share an origin. A frame is therefore not a boundary here: any other page
// on that host, framed, can reach this document, its localStorage and the
// signed-in Supabase session. The resize and chrome-hiding code below relies
// on exactly that same-origin access, which is why `sandbox` is the wrong
// fix — without allow-same-origin it breaks the embed, and with it the
// attribute buys nothing. An allowlist is the boundary instead.
function isEmbeddableBoltUrl(url) {
  const safe = safeLinkUrl(url);
  if (!safe) return false;
  try {
    const u = new URL(safe);
    const base = new URL(BALANCE_BOLT_URL);
    return u.origin === base.origin && u.pathname.startsWith(base.pathname);
  } catch {
    return false;
  }
}
let state = JSON.parse(localStorage.getItem('balance-race-ui') || 'null') || {
  user: '',
  filter: '',
  form: {},
};
state.filter ||= '';
state.eventTypeFilter ||= '';
state.viewFilter ||= 'club';
state.whenFilter ||= 'upcoming';
state.authDismissedUntil ||= 0;
if (!Array.isArray(state.form?.events)) {
  const legacyEvent = state.form?.event;
  state.form = {
    events: legacyEvent ? [legacyEvent] : [],
    otherText: '',
    otherOpen: false,
    level: state.form?.level || 'considering',
  };
}
let races = [];
let loadError = null;
let editingId = null;
let openId = null;
// Who to give focus back to when the race/edit screen closes: whatever was
// focused right before it opened (usually the race card that was clicked).
let raceScreenReturnFocus = null;
let editScreenReturnFocus = null;
let toast = null;
let toastKind = 'success'; // 'success' | 'error' — see render()'s #updateBanner block
let toastTimer = null;
let signOutNotice = null;
// The one place a save/remove/error result reaches the member: a banner
// above the race list, not a blocking alert(). Replaces every alert() this
// app used to raise for a write result — those were unstyled, blocked the
// page, and read as broken on mobile. Not for the auth sheet's own errors
// (send-link/verify-code failures): its opaque backdrop sits above this
// banner, so those stay inline in the sheet instead — see openSignInForm.
function showToast(msg, kind = 'success', ms = 4000) {
  // Once a "you've been signed out" notice is up, a write error must not
  // replace it (a refused save runs this right after the notice).
  if (signOutNotice && msg !== signOutNotice) return;
  toast = msg;
  toastKind = kind;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast = null;
    signOutNotice = null;
    render();
  }, ms);
}
const $ = s => document.querySelector(s);
const persist = () => localStorage.setItem('balance-race-ui', JSON.stringify(state));
function dateParts(date) {
  const d = new Date(date + 'T12:00:00');
  return {
    day: String(d.getDate()).padStart(2, '0'),
    month: d.toLocaleString('en-AU', { month: 'short' }),
    group: d.toLocaleString('en-AU', { month: 'long', year: 'numeric' }),
  };
}
// The name a member's commitments carry: their profile display name. Members
// cannot change it here; an admin renames them in the admin console.
function ownName() {
  return profile?.display_name || state.user || '';
}
function myEntry(race) {
  return race.entries.find(e => e.name === ownName());
}
// ---------------------------------------------------------------------------
// Results on past races. Approved members only: a visitor, or an account that
// is pending, rejected or revoked, is never sent a result (the results table
// has no read policy for them) and sees the race screen exactly as before.
// One result per entry. The database decides who may write one (the entry's
// owner or an admin); canEditResult only keeps the button off rows that would
// be refused anyway.
// ---------------------------------------------------------------------------
const RESULT_STATUSES = [
  ['finished', 'Finished'],
  ['dnf', 'DNF'],
  ['dns', 'DNS'],
];
const RESULT_MAX_SECONDS = 48 * 3600;
const RESULT_NOTE_MAX = 280;
// Results open on race day, in Sydney time, and never on a Balance Bolt race
// (sign-up and results live on its own site).
function resultsOpen(race) {
  return race.balanceBolt !== 'Y' && race.date <= sydneyToday();
}
function formatFinishTime(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
// "1:23:45" or "45:30" to whole seconds. Null when it is not a time, is zero,
// or runs past 48 hours.
function parseFinishTime(text) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  if (secs > 59 || (m[1] && mins > 59)) return null;
  const total = h * 3600 + mins * 60 + secs;
  return total >= 1 && total <= RESULT_MAX_SECONDS ? total : null;
}
// A place: empty is fine (null); otherwise a whole number from 1 to 100000.
// Returns undefined for anything else, so null and "invalid" stay apart.
function parsePlace(text) {
  const t = String(text).trim();
  if (!t) return null;
  if (!/^\d{1,6}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 100000 ? n : undefined;
}
// Is this entry the signed-in member's own? By who created it; for entries
// from before created_by existed, by display name.
function isOwnEntry(entry) {
  if (!session) return false;
  if (entry.created_by) return entry.created_by === session.user.id;
  const mine = ownName().trim().toLowerCase();
  return !!mine && entry.name.trim().toLowerCase() === mine;
}
function canEditResult(entry) {
  if (!session || !isMember) return false;
  // Admins may write any result; the server also wants their two-factor session.
  return isAdmin || isOwnEntry(entry);
}
// False when the last load could not read the results table, so a failed read
// never looks like "nobody has a result" (the reminder would nag everyone).
let resultsLoaded = false;
// The form's values while it is open. Kept here, not in the DOM, because
// render() rebuilds the race screen (a toast re-renders it) and would
// otherwise wipe what was typed. Not saved to localStorage.
let resultDraft = null;
function draftFrom(entry) {
  const r = entry.result;
  return {
    entryId: entry.id,
    status: r?.status || 'finished',
    time: r?.finish_seconds ? formatFinishTime(r.finish_seconds) : '',
    overall: r?.place_overall ? String(r.place_overall) : '',
    ageGroup: r?.place_age_group ? String(r.place_age_group) : '',
    pb: !!r?.is_pb,
    note: r?.note || '',
    error: '',
  };
}
// ---------------------------------------------------------------------------
// Auth. Email and password via Supabase Auth, behind an approval step.
// Browsing the calendar and every roster stays open to everyone signed out —
// but saving, editing or removing a commitment requires being signed in
// (requireSignIn, below, and the matching RLS policies on entries) AND being
// approved: anyone can make an account (Join), and the club admin approves it
// in the console. It's still the same honour system once approved: any member
// can change the level and events on any entry they've opened via the
// roster's Edit link (see saveEntry) — sign-in isn't tied to ownership, only
// to being someone. Names are not editable: a new commitment carries the
// member's profile display_name, and only an admin renames anyone (the
// entries_name_guard_biu trigger enforces it). Email-code sign-in is gone from this page
// (the console keeps it as the owner's fallback); a member who forgets their
// password asks the admin for a reset.
// ---------------------------------------------------------------------------
let session = null;
let profile = null;
// isMember mirrors the server-side private.is_allow_listed() check, and stays
// the only thing the write buttons look at: the allow-list is the one gate,
// and `access` below is only the story of how someone gets on it. RLS is the
// real boundary either way (see friendlyWriteError); gateButton/applyMemberGating
// just keep the write buttons from being clickable. checkMembership()
// re-reads it right after sign-in and again after sign-out (to false, with no
// RPC call needed).
let isMember = false;
// What my_access_status() says: {state, display_name, password_change_due,
// reset_expires_at, reset_expired}, where state is approved, none, pending,
// rejected or revoked. Two stand-ins cover a database that can't answer:
// 'legacy' (the function doesn't exist yet) and 'unknown' (it failed). Only
// the first signs a non-member out, the way the app always has; an approved
// member is never signed out or locked out for lack of this function.
let access = null;
// isAdmin only decides whether the header shows a link to admin.html. The
// admin functions check for themselves; see the add_admin_console migration.
let isAdmin = false;
// How many access requests are waiting, for the Admin link. Only an admin with
// a two-factor session gets a number back; anyone else, or an older database,
// gets an error and no number is shown.
let adminWaiting = 0;
const CLUB_EMAIL = 'mail@balancetriclub.com';
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 72;
async function checkMembership() {
  if (!session) {
    isMember = false;
    isAdmin = false;
    access = null;
    return;
  }
  const [member, admin, status] = await Promise.all([
    db.rpc('is_allow_listed'),
    db.rpc('admin_status'),
    db.rpc('my_access_status'),
  ]);
  // A failed is_allow_listed call doesn't lock out someone my_access_status
  // says is approved.
  isMember = (!member.error && member.data === true) || status.data?.state === 'approved';
  isAdmin = !admin.error && admin.data?.admin === true;
  if (!status.error && status.data?.state) access = status.data;
  else if (isMember) access = { state: 'approved' };
  else access = { state: status.error?.code === 'PGRST202' ? 'legacy' : 'unknown' };
  adminWaiting = 0;
  if (isAdmin && admin.data?.ready) {
    const waiting = await db.rpc('admin_pending_count');
    if (!waiting.error && Number.isInteger(waiting.data)) adminWaiting = waiting.data;
  }
}
function firstName() {
  const name = access?.display_name || profile?.display_name || '';
  return name.trim().split(/\s+/)[0];
}
function pendingMessage() {
  const name = firstName();
  return `Thanks${name ? ', ' + name : ''}. Your account is waiting for the club admin to approve it. This usually takes a day or two. You can look at races in the meantime. Nothing is emailed to you, so check back here.`;
}
// supabase-js warns against calling auth methods synchronously from inside
// onAuthStateChange (it can deadlock the client), so the actual sign-out is
// deferred a tick; the toast fires first since the session is still valid
// while it's showing, so nothing on screen looks broken mid-message. Every
// caller has already closed the auth sheet by this point (see
// onAuthStateChange), so showToast()'s banner is actually visible — unlike
// the auth sheet's own errors, which stay inline; see openSignInForm.
function signOutWithMessage(msg, ms) {
  signOutNotice = msg;
  showToast(msg, 'error', ms);
  setTimeout(() => db.auth.signOut(), 0);
}
function rejectNonMember() {
  signOutWithMessage(
    "This app is for Balance Tri Club members only, so you've been signed " +
      `out. Not a member? Email ${CLUB_EMAIL} to request access, ` +
      'or visit balancetriclub.com.au for club info.',
  );
}
const MEMBER_ONLY_HINT = `Club members only — email ${CLUB_EMAIL} to request access.`;
function gateHint() {
  if (access?.state === 'pending') return pendingMessage();
  if (access?.state === 'none')
    return 'Ask to join the club first, then the admin can approve you.';
  return MEMBER_ONLY_HINT;
}
// Disables a write button for a signed-in non-member, leaving it untouched
// for a signed-out visitor (clicking still opens the sign-in gate as before)
// and for an approved member. A disabled button never fires its click
// handler, so this only ever suppresses a request RLS would have rejected
// anyway — it adds no new permission check of its own. The hint says why:
// waiting for approval, or not asked yet.
function gateButton(btn) {
  if (!btn) return;
  const gated = session && !isMember;
  btn.disabled = gated;
  btn.title = gated ? gateHint() : '';
}
// Covers the write controls that are static DOM (always present, never torn
// down by render()) — the header's Add-a-race button, the two form submit
// buttons, and the edit screen's Edit/Remove buttons. Controls makeDetails()
// rebuilds fresh on every render (the roster's per-entry Edit buttons, Add
// your commitment, Remove commitment) gate themselves inline instead.
function applyMemberGating() {
  // Signed out there is nothing to click: the header's Sign in / Sign up
  // lockup and the race screen's own lockup stand in for these controls.
  $('#heroAddButton').classList.toggle('hidden', !session);
  $('#raceScreenEditButton').classList.toggle('hidden', !session);
  gateButton($('#heroAddButton'));
  gateButton($('#removeRaceButton'));
  gateButton($('#raceScreenEditButton'));
  gateButton(document.querySelector('#raceForm .primary-button'));
  gateButton(document.querySelector('#editForm .primary-button'));
}
async function loadProfile() {
  const { data, error } = await db
    .from('profiles')
    .select('display_name')
    .eq('id', session.user.id)
    .single();
  profile = error ? null : data;
  if (profile?.display_name && !state.user) {
    state.user = profile.display_name;
    persist();
  }
}
// Small DOM builder for the auth sheet's forms. Everything here is built as
// nodes, never innerHTML, so a typed address or a display name can only ever
// be text.
function elt(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'class') node.className = value;
    else if (value === true) node.setAttribute(name, '');
    else if (value !== false && value != null) node.setAttribute(name, value);
  }
  node.append(...kids);
  return node;
}
// What a signed-out visitor sees where a write control would be: Sign in and
// Sign up side by side, opening the same auth sheet as everything else. In the
// header it is a quiet Sign in beside a primary Sign up; on the race screen it
// is a pair of full buttons under a one-line reason.
function authLockup({ header = false, message = '' } = {}) {
  const signIn = elt(
    'button',
    {
      type: 'button',
      class: header ? 'text-button' : 'primary-button',
      id: header ? 'signInButton' : null,
    },
    'Sign in',
  );
  const signUp = elt(
    'button',
    { type: 'button', class: header ? 'primary-button' : 'secondary-button' },
    'Sign up',
  );
  signIn.onclick = () => requireSignIn(message || 'Sign in');
  signUp.onclick = () => requireSignUp();
  const buttons = elt('div', { class: 'auth-lockup-buttons' }, signIn, signUp);
  return elt(
    'div',
    { class: header ? 'auth-lockup auth-lockup-header' : 'auth-lockup' },
    ...(message ? [elt('p', { class: 'auth-lockup-message' }, message)] : []),
    buttons,
  );
}
function closeAccountMenu() {
  const button = $('#accountMenuButton');
  const menu = $('#accountMenu');
  if (!button || !menu) return;
  button.setAttribute('aria-expanded', 'false');
  menu.classList.add('hidden');
}
// The Admin entry for the Menu. The count of waiting requests rides in the
// label, and a dot on the Menu button (see renderAccountMenu) says it is there
// before the menu is opened.
function adminItem() {
  return elt(
    'a',
    {
      class: 'account-menu-item',
      href: adminWaiting ? 'admin.html#requests' : 'admin.html',
    },
    adminWaiting ? `Admin (${adminWaiting} waiting)` : 'Admin',
  );
}
function renderAccountMenu() {
  const wrap = elt('div', { class: 'account-menu-wrap' });
  const button = elt(
    'button',
    {
      type: 'button',
      class: 'text-button',
      id: 'accountMenuButton',
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      'aria-controls': 'accountMenu',
    },
    'Menu',
  );
  // profiles is readable only by its owner, so this name is the viewer's own —
  // self-XSS rather than one member reaching another. Same mistake either way,
  // and elt() sets it as text, so nothing is parsed as HTML.
  const who = elt('p', { class: 'account-menu-who' }, profile?.display_name || session.user.email);
  const guide = elt('a', { class: 'account-menu-item', href: 'guides/' }, 'Guide');
  const changePassword = elt(
    'button',
    { type: 'button', class: 'account-menu-item', id: 'changePasswordButton' },
    'Change password',
  );
  const signOut = elt(
    'button',
    { type: 'button', class: 'account-menu-item', id: 'signOutButton' },
    'Sign out',
  );
  const menu = elt(
    'div',
    { class: 'account-menu hidden', id: 'accountMenu' },
    who,
    guide,
    ...(isAdmin ? [adminItem()] : []),
    changePassword,
    signOut,
  );
  button.onclick = () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    menu.classList.toggle('hidden', !open);
    if (open) menu.querySelector('.account-menu-item').focus();
  };
  wrap.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || menu.classList.contains('hidden')) return;
    e.preventDefault();
    closeAccountMenu();
    button.focus();
  });
  changePassword.onclick = () => {
    closeAccountMenu();
    showPasswordSheet('change');
  };
  signOut.onclick = () => db.auth.signOut();
  if (isAdmin && adminWaiting) wrap.classList.add('has-waiting');
  wrap.append(button, menu);
  return wrap;
}
function renderMemberBanner() {
  const banner = $('#memberBanner');
  banner.textContent = '';
  const st = access?.state;
  const show = session && !isMember && st !== 'rejected' && st !== 'revoked';
  banner.classList.toggle('hidden', !show);
  if (!show) return;
  if (st === 'pending') {
    banner.append(pendingMessage());
  } else if (st === 'none') {
    const ask = elt('button', { type: 'button', class: 'member-banner-action' }, 'Ask to join');
    ask.onclick = () => showNameSheet();
    banner.append(
      "You're signed in, but you can't add or edit races yet. Ask to join, and the club admin will approve you. ",
      ask,
    );
  } else {
    const link = elt('a', { href: `mailto:${CLUB_EMAIL}` }, CLUB_EMAIL);
    banner.append(
      "You're signed in, but this account isn't a club member yet. Email ",
      link,
      ' to request access.',
    );
  }
}
function renderAuth() {
  const widget = $('#authWidget');
  widget.textContent = '';
  // Signed in, the Guide lives in the Menu; the header link is for signed-out visitors.
  $('.guide-link').hidden = Boolean(session);
  if (session) {
    // One Menu at the edge: Guide, Admin, Change password and Sign out live
    // inside it, so the header stays calm and Sign out is hard to hit by
    // mistake. The name sits at the top of the menu, not in the header.
    widget.append(renderAccountMenu());
  } else {
    // Both buttons open the same auth sheet the nudge/gate use, rather than
    // expanding a form inline into the header — that used to squeeze the
    // topbar's other buttons on narrow phones (the "condensing" bug: real
    // document flow, not an overlay, competing for space in .header-actions).
    widget.append(authLockup({ header: true }));
  }
  renderMemberBanner();
  applyMemberGating();
}
// ---------------------------------------------------------------------------
// Form pieces for the auth sheet: a labelled field, a password field with a
// show/hide toggle, and the checks on names and passwords. The database is the
// authority on all of them (private.clean_display_name, the Supabase password
// settings); these only give the answer sooner.
// ---------------------------------------------------------------------------
function authField({ label, name, type = 'text', hint, control = 'input', ...attrs }) {
  const id = `auth-${name}`;
  const input = elt(control, { id, name, ...(control === 'input' ? { type } : {}), ...attrs });
  const hintNode = hint ? elt('p', { class: 'auth-field-hint', id: `${id}-hint` }, hint) : null;
  if (hintNode) input.setAttribute('aria-describedby', hintNode.id);
  const field = elt('div', { class: 'auth-field' }, elt('label', { for: id }, label), input);
  if (hintNode) field.append(hintNode);
  return { field, input, hintNode };
}
// Both icons are in the markup and CSS shows one, by aria-pressed, so no
// markup is built from a variable here. Paste is never blocked, so a password
// manager or a pasted passphrase works.
function passwordField({ label, name, autocomplete, hint }) {
  const { field, input, hintNode } = authField({
    label,
    name,
    type: 'password',
    hint,
    autocomplete,
    required: true,
    autocapitalize: 'none',
    spellcheck: 'false',
  });
  const toggle = elt('button', {
    type: 'button',
    class: 'password-toggle',
    'aria-label': 'Show password',
    'aria-pressed': 'false',
  });
  toggle.innerHTML = `<svg class="eye-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg><svg class="eye-shut" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></svg>`;
  toggle.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  };
  input.parentElement.insertBefore(
    elt('div', { class: 'password-input' }, input, toggle),
    hintNode,
  );
  return { field, input };
}
const PASSWORD_HINT = `${PASSWORD_MIN} to ${PASSWORD_MAX} characters. Any characters are fine, and a few random words works well.`;
// Passwords under 12 characters are already refused, so the bundled list holds
// only the common ones of 12 to 72 characters. It loads the first time a new
// password is checked (browsing never fetches it), and a failed load is
// retried next time rather than remembered.
let commonPasswords = null;
function loadCommonPasswords() {
  commonPasswords ||= fetch(`${BASE_PATH}assets/common-passwords.txt?v=2026101202`)
    .then(res => {
      if (!res.ok) throw new Error('common-password list ' + res.status);
      return res.text();
    })
    .then(
      text =>
        new Set(
          text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#')),
        ),
    )
    .catch(err => {
      commonPasswords = null;
      throw err;
    });
  return commonPasswords;
}
// Length is counted in characters; bcrypt's real limit is 72 bytes, so the top
// end is checked in bytes (the same as Supabase does) and an accented letter or
// emoji just uses up more of it. Returns the message to show, or null.
async function passwordProblem(password) {
  if ([...password].length < PASSWORD_MIN)
    return `Your password needs at least ${PASSWORD_MIN} characters.`;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX)
    return `Your password can be at most ${PASSWORD_MAX} characters.`;
  let common;
  try {
    common = await loadCommonPasswords();
  } catch {
    return "We couldn't check that password against the list of common ones. Check your connection and try again.";
  }
  if (common.has(password.toLowerCase()))
    return 'That password is too common. Try a few random words instead.';
  return null;
}
// Mirrors private.clean_display_name: collapse spaces, 2 to 40 characters,
// letters (any language), spaces, apostrophes, hyphens and full stops, at
// least one letter. Returns {name} or {error}.
function cleanDisplayName(raw) {
  const name = raw.replace(/\s+/g, ' ').trim().normalize('NFC').replace(/͏/g, '').trim();
  const length = [...name].length;
  if (length < 2 || length > 40) return { error: 'Your name needs to be 2 to 40 characters.' };
  if (!/^(?:[\p{L}̀-ͯ]|[ '.’-])+$/u.test(name))
    return { error: 'Use letters, spaces, apostrophes, hyphens and full stops in your name.' };
  if (!/\p{L}/u.test(name)) return { error: 'Your name needs at least one letter.' };
  return { name };
}
function authErrorText(error, prefix) {
  if (error.code === 'invalid_credentials')
    return "That email and password don't match. Check them and try again.";
  if (/rate_limit/.test(error.code || ''))
    return 'Too many tries just now. Wait a few minutes, then try again.';
  return prefix + error.message;
}
function showFormError(errorEl, message, focusEl) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
  if (focusEl) focusEl.focus();
}
function setBusy(btn, busy, idleText, busyText) {
  btn.disabled = busy;
  btn.textContent = busy ? busyText : idleText;
}
// Swaps the sheet's contents for one step. aria-label follows the step, so a
// screen reader announces "Join" or "Set a new password" rather than "Sign in".
function showStep(host, label, nodes) {
  host.textContent = '';
  host.append(...nodes);
  $('.auth-sheet').setAttribute('aria-label', label);
}
function stepCancelButton(text, onclick) {
  const button = elt('button', { type: 'button', class: 'auth-sheet-cancel' }, text);
  button.onclick = onclick;
  return button;
}
function stepLinkButton(text, onclick) {
  const button = elt('button', { type: 'button', class: 'auth-sheet-link' }, text);
  button.onclick = onclick;
  return button;
}
// Focus has to land somewhere in the sheet after a step swap: the button that
// was clicked no longer exists, and the focus trap only sees keys from inside.
function focusStep(host) {
  (host.querySelector('input, textarea') || $('#authSheetClose')).focus();
}
// heading: an <h2> to show above the form. cancel: a handler for a "Cancel"
// button shown below the form. skipIntro: true when the caller (the nudge)
// already showed the explanation a moment ago, so this step should jump
// straight to the fields instead of repeating it. Always targets the auth
// sheet now.
function openSignInForm(host, { heading, cancel, skipIntro } = {}) {
  const email = authField({
    label: 'Email',
    name: 'email',
    type: 'email',
    required: true,
    maxlength: '254',
    autocomplete: 'email',
    autocapitalize: 'none',
    placeholder: 'you@example.com',
  });
  const password = passwordField({
    label: 'Password',
    name: 'password',
    autocomplete: 'current-password',
  });
  const button = elt('button', { type: 'submit', class: 'send-link-button' }, 'Sign in');
  const form = elt(
    'form',
    { class: 'sign-in-form auth-form' },
    email.field,
    password.field,
    button,
  );
  const formError = elt('p', { class: 'auth-sheet-error hidden', role: 'alert' });
  const nodes = [];
  if (heading) nodes.push(elt('h2', {}, heading));
  if (!skipIntro) {
    nodes.push(
      elt(
        'p',
        { class: 'auth-sheet-hint' },
        'Sign in to add or edit race information. You can view the calendar anytime without signing in.',
      ),
    );
  }
  nodes.push(form, formError);
  // R1: no "email me a reset link" button on purpose. Resets go through the
  // club admin, who passes on a temporary password.
  nodes.push(
    elt(
      'p',
      { class: 'auth-sheet-hint auth-sheet-hint-muted' },
      'Forgot your password? Ask the club admin to reset it. Email ',
      elt('a', { href: `mailto:${CLUB_EMAIL}` }, CLUB_EMAIL),
      '.',
    ),
    elt(
      'p',
      { class: 'auth-sheet-hint auth-sheet-hint-muted' },
      'New here? ',
      stepLinkButton('Join the club', () => {
        openJoinForm(host, { cancel });
        focusStep(host);
      }),
    ),
  );
  if (cancel) nodes.push(stepCancelButton('Cancel', cancel));
  showStep(host, heading || 'Sign in', nodes);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    formError.classList.add('hidden');
    setBusy(button, true, 'Sign in', 'Signing in…');
    let captchaToken;
    let error;
    try {
      captchaToken = await getCaptchaToken(form);
    } catch (captchaError) {
      error = captchaError;
    }
    if (!error) {
      ({ error } = await db.auth.signInWithPassword({
        email: email.input.value.trim().toLowerCase(),
        password: password.input.value,
        options: { captchaToken },
      }));
    }
    // On success onAuthStateChange closes the sheet and re-renders; there's
    // no page reload. Failures stay inline, not showToast(): the auth sheet's
    // own opaque backdrop sits above the page banner (z-index 40 vs. the
    // banner's place in normal flow), so a toast fired from here would be
    // invisible until the member closed the sheet — exactly the wrong time to
    // tell them why their sign-in attempt failed.
    if (error) {
      showFormError(formError, authErrorText(error, 'Could not sign in: '), password.input);
      password.input.select();
      setBusy(button, false, 'Sign in', 'Signing in…');
    }
  });
}
// The join form (S1 to S8): one screen, then signUp, then request_access. With
// Confirm email off, signUp returns a session at once; request_access then
// files the request and the account sits in 'pending'. If signUp works but
// request_access doesn't (a name clash, say) the person stays signed in and
// gets the name step again (S8), with the account in state 'none'.
function openJoinForm(host, { cancel } = {}) {
  const email = authField({
    label: 'Email',
    name: 'email',
    type: 'email',
    required: true,
    maxlength: '254',
    autocomplete: 'email',
    autocapitalize: 'none',
    placeholder: 'you@example.com',
  });
  const echo = elt('p', { class: 'auth-field-hint', id: 'auth-email-echo' });
  email.input.setAttribute('aria-describedby', 'auth-email-echo');
  email.field.append(echo);
  email.input.addEventListener('input', () => {
    const address = email.input.value.trim().toLowerCase();
    echo.textContent = '';
    if (address && email.input.validity.valid)
      echo.append(
        "We'll use ",
        elt('strong', {}, address),
        " to sign you in. Check it's right, because nothing is emailed to you.",
      );
  });
  const password = passwordField({
    label: 'Password',
    name: 'password',
    autocomplete: 'new-password',
    hint: PASSWORD_HINT,
  });
  const again = passwordField({
    label: 'Confirm password',
    name: 'confirm',
    autocomplete: 'new-password',
  });
  const display = authField({
    label: 'Display name',
    name: 'display-name',
    required: true,
    maxlength: '60',
    autocomplete: 'name',
    hint: "This is how you'll appear on race rosters. Add a surname or initial if you share a first name with someone.",
  });
  const note = authField({
    label: 'Note (optional)',
    name: 'note',
    control: 'textarea',
    rows: '2',
    maxlength: '280',
    hint: 'How do you know the club? (for example, squad, JustGo number, who invited you)',
  });
  const button = elt('button', { type: 'submit', class: 'send-link-button' }, 'Join');
  const form = elt(
    'form',
    { class: 'sign-in-form auth-form' },
    email.field,
    password.field,
    again.field,
    display.field,
    note.field,
    button,
  );
  const formError = elt('p', { class: 'auth-sheet-error hidden', role: 'alert' });
  const nodes = [
    elt('h2', {}, 'Join the club'),
    elt(
      'p',
      { class: 'auth-sheet-hint' },
      'Make an account and the club admin will approve it, usually within a day or two. You can look at races in the meantime.',
    ),
    form,
    formError,
    elt(
      'p',
      { class: 'auth-sheet-hint auth-sheet-hint-muted' },
      'Already have an account? ',
      stepLinkButton('Sign in', () => {
        openSignInForm(host, { heading: 'Sign in', cancel });
        focusStep(host);
      }),
    ),
  ];
  if (cancel) nodes.push(stepCancelButton('Cancel', cancel));
  showStep(host, 'Join the club', nodes);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    formError.classList.add('hidden');
    // Off from the first tap, so a double tap can't send two sign-ups while
    // the common-password list is still loading.
    if (button.disabled) return;
    button.disabled = true;
    // authBusy holds back onAuthStateChange while this finishes the job: it
    // would otherwise close this sheet the moment signUp returns a session,
    // before request_access has been tried.
    try {
      const address = email.input.value.trim().toLowerCase();
      const problem = await passwordProblem(password.input.value);
      if (problem) return showFormError(formError, problem, password.input);
      if (password.input.value !== again.input.value)
        return showFormError(formError, "The two passwords don't match.", again.input);
      const cleaned = cleanDisplayName(display.input.value);
      if (cleaned.error) return showFormError(formError, cleaned.error, display.input);
      setBusy(button, true, 'Join', 'Joining…');
      authBusy = true;
      let captchaToken;
      try {
        captchaToken = await getCaptchaToken(form);
      } catch (captchaError) {
        return showFormError(formError, 'Could not join: ' + captchaError.message);
      }
      // has_password marks an account that already has a password, so the
      // "set a password" prompt for older accounts never shows for this one.
      const { data, error } = await db.auth.signUp({
        email: address,
        password: password.input.value,
        options: { captchaToken, data: { has_password: true } },
      });
      if (error || !data.session) {
        // With Confirm email on, an existing address comes back as a fake
        // user with no identities instead of an error; same message either way.
        const exists =
          error?.code === 'user_already_exists' ||
          /already (registered|been registered)/i.test(error?.message || '') ||
          (!error && data.user?.identities?.length === 0);
        if (exists)
          return showFormError(
            formError,
            "There's already an account for this email. Sign in, or ask the club admin to reset your password.",
            email.input,
          );
        // Confirm email still on: the account exists but nobody is signed in.
        return showFormError(
          formError,
          error
            ? authErrorText(error, 'Could not join: ')
            : 'Check your email to confirm your address, then sign in.',
        );
      }
      session = data.session;
      signOutNotice = null;
      await requestAccess(host, cleaned.name, note.input.value, { cancel });
    } finally {
      authBusy = false;
      if (host.contains(button)) setBusy(button, false, 'Join', 'Joining…');
    }
  });
}
// True while the join form is mid-way through signUp then request_access.
let authBusy = false;
// Files the request for the signed-in account. On success the account is
// pending: close the sheet and let the banner say so. On failure (S8) stay
// signed in and show the name step again with the server's message, which is
// worded for the member.
async function requestAccess(host, displayName, note, { cancel } = {}) {
  const { error } = await db.rpc('request_access', {
    p_display_name: displayName,
    p_note: note.trim() || null,
  });
  await loadProfile();
  await checkMembership();
  renderAuth();
  render();
  if (error) {
    const message =
      error.code === 'PGRST202'
        ? "Joining isn't switched on yet. Please try again later."
        : error.message;
    openNameStep(host, { error: message, name: displayName, note, cancel });
    focusStep(host);
    return false;
  }
  closeAuthSheet({ force: true });
  $('#memberBanner').focus();
  return true;
}
// The name step: shown after a failed request_access (S8), and to a signed-in
// account that never asked to join (state 'none').
function openNameStep(host, { error, name = '', note = '', cancel } = {}) {
  const display = authField({
    label: 'Display name',
    name: 'display-name',
    required: true,
    maxlength: '60',
    autocomplete: 'name',
    value: name,
    hint: "This is how you'll appear on race rosters. Add a surname or initial if you share a first name with someone.",
  });
  const noteField = authField({
    label: 'Note (optional)',
    name: 'note',
    control: 'textarea',
    rows: '2',
    maxlength: '280',
    hint: 'How do you know the club? (for example, squad, JustGo number, who invited you)',
  });
  noteField.input.value = note;
  const button = elt('button', { type: 'submit', class: 'send-link-button' }, 'Send request');
  const form = elt(
    'form',
    { class: 'sign-in-form auth-form' },
    display.field,
    noteField.field,
    button,
  );
  const formError = elt('p', { class: 'auth-sheet-error hidden', role: 'alert' });
  const nodes = [
    elt('h2', {}, 'Ask to join'),
    elt(
      'p',
      { class: 'auth-sheet-hint' },
      'Tell the club who you are and the admin can approve your account.',
    ),
    form,
    formError,
  ];
  if (cancel) nodes.push(stepCancelButton('Not now', cancel));
  showStep(host, 'Ask to join', nodes);
  if (error) showFormError(formError, error);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    formError.classList.add('hidden');
    const cleaned = cleanDisplayName(display.input.value);
    if (cleaned.error) return showFormError(formError, cleaned.error, display.input);
    setBusy(button, true, 'Send request', 'Sending…');
    await requestAccess(host, cleaned.name, noteField.input.value, { cancel });
  });
}
// ---------------------------------------------------------------------------
// The auth sheet: every sign-in entry point (the header button, the nudge,
// and the write gate) opens this one overlay — a bottom sheet on desktop,
// full screen on mobile (styles-additions.css), never document flow that
// could squeeze other layout. As a "nudge" it appears once per visit for a
// signed-out browser (unless snoozed) offering Sign In, Sign Up or View Calendar;
// tapping outside it (desktop), the close button, or View Calendar all
// dismiss it the same way — self-dismissing, never blocking. As a "gate"
// requireSignIn() opens it to require sign-in before a write goes through
// (saving, editing or removing a commitment); the close button there just
// backs out. The same sheet carries the signed-in steps too: 'account' for
// ones a member can back out of (ask to join, set a password, change it) and
// 'locked' for the one they can't, the forced set-password step after an
// admin reset.
// ---------------------------------------------------------------------------
let authSheetDismissed = false; // this pageview only, independent of the snooze
let authSheetMode = null; // 'nudge' | 'gate' | 'account' | 'locked' | null
// Tracks the nudge's checkbox live (via onchange, below) rather than reading
// it at dismiss time, because clicking "Sign in" swaps the checkbox out for
// the sign-in form — so a box checked before that swap must still be honoured
// if the visitor then cancels out of that step instead of finishing it.
let authSheetSnoozeWanted = false;
// Who to give focus back to on close: whatever was focused right before the
// sheet opened (the header's Sign In button, a write button behind the
// gate, or nothing at all for the automatic nudge).
let authSheetReturnFocus = null;
function focusableElements(container) {
  return [
    ...container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(el => el.offsetParent !== null);
}
// Moves focus into the sheet once its content for this open/step exists.
// Called after building the nudge or the gate; the later steps focus their
// first field themselves (focusStep).
function focusAuthSheet() {
  const focusables = focusableElements($('.auth-sheet'));
  (focusables[0] || $('#authSheetClose')).focus();
}
// force: closes the locked step too, which nothing a member does may do.
function closeAuthSheet({ force = false } = {}) {
  if (authSheetMode === 'locked' && !force) return;
  if (authSheetMode === 'nudge') {
    if (authSheetSnoozeWanted) {
      state.authDismissedUntil = Date.now() + 10 * 24 * 60 * 60 * 1000;
      persist();
    }
    authSheetDismissed = true;
  }
  authSheetMode = null;
  authSheetSnoozeWanted = false;
  $('.auth-sheet').classList.remove('is-locked');
  $('#authSheetBackdrop').classList.add('hidden');
  $('main.shell').inert = false;
  if (authSheetReturnFocus && document.body.contains(authSheetReturnFocus))
    authSheetReturnFocus.focus();
  authSheetReturnFocus = null;
}
// The page behind the sheet is inert while it is open, so neither Tab nor a
// screen reader's cursor can reach controls the sheet is meant to hold back,
// most of all behind the locked set-password step.
function showSheetBackdrop() {
  $('main.shell').inert = true;
  $('#authSheetBackdrop').classList.remove('hidden');
}
function openSheet(mode) {
  if (authSheetMode === null) authSheetReturnFocus = document.activeElement;
  authSheetMode = mode;
  $('.auth-sheet').classList.toggle('is-locked', mode === 'locked');
  showSheetBackdrop();
}
function showAuthSheetNudge() {
  if (session || authSheetDismissed || Date.now() < state.authDismissedUntil) return;
  authSheetReturnFocus = document.activeElement;
  authSheetMode = 'nudge';
  authSheetSnoozeWanted = false;
  // A bare literal (not built from a variable) for the no-unsanitized rule;
  // the sign-in and join forms the buttons open are built as DOM instead.
  $('#authSheetBody').innerHTML =
    `<p class="auth-sheet-hint">Sign in to add or edit race information. New here? Sign up, and the club admin will approve your account. You can view the calendar anytime without signing in.</p><p class="auth-sheet-hint">Want to know more about the club? Visit <a href="https://balancetriclub.com.au" target="_blank" rel="noopener">balancetriclub.com.au</a>.</p><div class="auth-sheet-actions"><button type="button" class="primary-button" id="authSheetSignInButton">Sign In</button><button type="button" class="secondary-button" id="authSheetJoinButton">Sign Up</button><button type="button" class="secondary-button" id="authSheetBrowseButton">View Calendar</button></div><label class="auth-sheet-checkbox"><input type="checkbox" id="authSheetSnooze" /><span>Don't ask me to sign in again for 10 days</span></label>`;
  $('.auth-sheet').setAttribute('aria-label', 'Sign in');
  $('#authSheetSnooze').onchange = e => {
    authSheetSnoozeWanted = e.target.checked;
  };
  $('#authSheetSignInButton').onclick = () => {
    openSignInForm($('#authSheetBody'), {
      heading: 'Sign in',
      cancel: closeAuthSheet,
      skipIntro: true,
    });
    focusStep($('#authSheetBody'));
  };
  $('#authSheetJoinButton').onclick = () => {
    openJoinForm($('#authSheetBody'), { cancel: closeAuthSheet });
    focusStep($('#authSheetBody'));
  };
  $('#authSheetBrowseButton').onclick = closeAuthSheet;
  showSheetBackdrop();
  focusAuthSheet();
}
// Called before a write; opens the gate and returns false if signed out
// (callers must return immediately), or returns true if already signed in.
function requireSignIn(title) {
  if (session) return true;
  authSheetReturnFocus = document.activeElement;
  authSheetMode = 'gate';
  openSignInForm($('#authSheetBody'), { heading: title, cancel: closeAuthSheet });
  showSheetBackdrop();
  focusAuthSheet();
  return false;
}
// Same gate as requireSignIn, opened on the Join form for a new member.
function requireSignUp() {
  if (session) return;
  authSheetReturnFocus = document.activeElement;
  authSheetMode = 'gate';
  openJoinForm($('#authSheetBody'), { cancel: closeAuthSheet });
  showSheetBackdrop();
  focusStep($('#authSheetBody'));
}
// The name step for a signed-in account that hasn't asked to join.
function showNameSheet() {
  if (authSheetMode === 'locked') return;
  openSheet('account');
  openNameStep($('#authSheetBody'), { cancel: closeAuthSheet });
  focusStep($('#authSheetBody'));
}
// Set or change a password while signed in. kind:
//   'forced'  after an admin reset (R5): can't be closed, only signed out of
//   'prompt'  the one-time nudge for older accounts without a password (E1)
//   'change'  "Change password" in the account menu (P8)
// The database clears the reset flag when told to (password_changed), and in
// phase 1 it trusts this step to have actually changed the password (R6).
function showPasswordSheet(kind) {
  if (authSheetMode === 'locked') return;
  const host = $('#authSheetBody');
  openSheet(kind === 'forced' ? 'locked' : 'account');
  const title = {
    forced: 'Set a new password',
    prompt: 'Set a password',
    change: 'Change password',
  }[kind];
  const intro = {
    forced: `Welcome back${firstName() ? ', ' + firstName() : ''}. Choose a new password to finish signing in.`,
    prompt: 'Set a password so you can sign in without an email code.',
    change: "Choose a new password. You'll use it the next time you sign in.",
  }[kind];
  const password = passwordField({
    label: 'New password',
    name: 'password',
    autocomplete: 'new-password',
    hint: PASSWORD_HINT,
  });
  const again = passwordField({
    label: 'Confirm new password',
    name: 'confirm',
    autocomplete: 'new-password',
  });
  const button = elt('button', { type: 'submit', class: 'send-link-button' }, 'Save password');
  const form = elt(
    'form',
    { class: 'sign-in-form auth-form' },
    password.field,
    again.field,
    button,
  );
  const formError = elt('p', { class: 'auth-sheet-error hidden', role: 'alert' });
  const nodes = [
    elt('h2', {}, title),
    elt('p', { class: 'auth-sheet-hint' }, intro),
    form,
    formError,
  ];
  if (kind === 'forced') nodes.push(stepCancelButton('Sign out instead', () => db.auth.signOut()));
  else if (kind === 'prompt')
    // Only an explicit "Not now", or saving, ends the prompt for good; closing
    // the sheet any other way (or a failed save) lets it come back.
    nodes.push(
      stepCancelButton('Not now', () => {
        localStorage.setItem(passwordPromptKey(), '1');
        closeAuthSheet();
      }),
    );
  else nodes.push(stepCancelButton('Cancel', closeAuthSheet));
  showStep(host, title, nodes);
  // Once updateUser has worked, a retry only needs to finish the job: asking
  // Supabase to set the same password again would be refused as unchanged.
  let saved = false;
  // Back on, with a message, when something stops the save.
  const fail = (message, focusEl) => {
    showFormError(formError, message, focusEl);
    setBusy(button, false, 'Save password', 'Saving…');
  };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    formError.classList.add('hidden');
    // Off from the first tap, so a double tap can't save twice while the
    // common-password list is still loading.
    if (button.disabled) return;
    button.disabled = true;
    if (!saved) {
      const problem = await passwordProblem(password.input.value);
      if (problem) return fail(problem, password.input);
      if (password.input.value !== again.input.value)
        return fail("The two passwords don't match.", again.input);
      const { error } = await db.auth.updateUser({
        password: password.input.value,
        data: { has_password: true },
      });
      if (error) {
        return fail(
          error.code === 'same_password'
            ? "That's the same as your current password. Choose a different one."
            : error.code === 'reauthentication_needed'
              ? reauthText(kind)
              : 'Could not save your password: ' + error.message,
          password.input,
        );
      }
      saved = true;
    }
    if (kind === 'forced') {
      const { error } = await db.rpc('password_changed');
      // A database without the function can't hold the flag either.
      if (error && error.code !== 'PGRST202') {
        // The password is changed but the flag isn't cleared: remember it here
        // so the next load retries before asking for another password.
        localStorage.setItem(pwChangedKey(), '1');
        return fail(
          "Your password is saved, but we couldn't finish. Press Save password to try again.",
        );
      }
      localStorage.removeItem(pwChangedKey());
    }
    if (kind === 'prompt') localStorage.setItem(passwordPromptKey(), '1');
    await checkMembership();
    renderAuth();
    closeAuthSheet({ force: true });
    showToast('Password saved.');
  });
  focusStep(host);
}
// Supabase wants a recent sign-in to change a password. Someone who has a
// password can sign out and in again. Someone who has none (the one-time
// prompt) must not be told to: they couldn't get back in.
function reauthText(kind) {
  if (kind === 'change' && session.user.user_metadata?.has_password)
    return 'For your security, sign out and sign in again, then change your password.';
  return "We couldn't save it from this session. Stay signed in, and ask the club admin for a temporary password if you need one.";
}
const pwChangedKey = () => `balance-pwchanged-${session.user.id}`;
// The forced step changed the password but couldn't clear the reset flag (the
// network dropped, say). Finish that before anything else reads the account,
// or the member would be asked for yet another new password.
async function settlePasswordChange() {
  if (!session || !localStorage.getItem(pwChangedKey())) return;
  const { error } = await db.rpc('password_changed');
  if (error && error.code !== 'PGRST202') return;
  localStorage.removeItem(pwChangedKey());
  await checkMembership();
}
const passwordPromptKey = () => `balance-password-prompt-${session.user.id}`;
// What to do about the account that just signed in or loaded, in order of
// priority: sign out an expired temporary password (R6) or a rejected or
// revoked account, then make a reset password be changed (R5), then the
// one-time prompts. Nothing here runs without a session.
function reactToAccess() {
  if (!session || !access) return;
  const contact = `If you think that's a mistake, contact the club at ${CLUB_EMAIL}.`;
  if (access.reset_expired)
    return signOutWithMessage(
      'This temporary password has expired. Ask the club admin for a new one.',
      12000,
    );
  if (access.state === 'rejected')
    return signOutWithMessage(`Your account wasn't approved. ${contact}`, 12000);
  if (access.state === 'revoked')
    return signOutWithMessage(`Your access has been removed. ${contact}`, 12000);
  if (access.state === 'legacy') return rejectNonMember();
  if (access.password_change_due) return showPasswordSheet('forced');
  if (access.state === 'approved') {
    if (
      !session.user.user_metadata?.has_password &&
      !localStorage.getItem(passwordPromptKey()) &&
      promptedThisView !== session.user.id
    ) {
      promptedThisView = session.user.id;
      showPasswordSheet('prompt');
    }
  } else if (access.state === 'none' && autoAskedFor !== session.user.id) {
    autoAskedFor = session.user.id;
    showNameSheet();
  }
}
// Offer the name step on its own once per pageview; after that the banner's
// "Ask to join" button is the way back to it.
let autoAskedFor = null;
// Likewise the password prompt: once a pageview, so closing it (not saving, not
// "Not now") doesn't bring it straight back on the next auth event.
let promptedThisView = null;
async function initAuth() {
  const {
    data: { session: s },
  } = await db.auth.getSession();
  session = s;
  if (session) {
    await loadProfile();
    await checkMembership();
  }
  await settlePasswordChange();
  renderAuth();
  if (session) reactToAccess();
  showAuthSheetNudge();
  reloadIfNamesChanged();
  db.auth.onAuthStateChange(async (_event, s) => {
    session = s;
    // The join form is mid-way through signUp then request_access and
    // finishes the job itself (see openJoinForm). USER_UPDATED is our own
    // updateUser call (a password or flag); its callers refresh what they
    // need, and re-reading here could briefly overwrite that with older state.
    if (authBusy || _event === 'USER_UPDATED') return;
    if (session) {
      signOutNotice = null;
      await loadProfile();
      await checkMembership();
      if (authSheetMode === 'nudge' || authSheetMode === 'gate') closeAuthSheet();
      await settlePasswordChange();
      reactToAccess();
    } else {
      profile = null;
      isMember = false;
      access = null;
      // Forget the name and the name search on sign-out, so the next person
      // on a shared device doesn't find them in localStorage.
      state.user = '';
      state.filter = '';
      state.form = { ...state.form, editingName: '' };
      persist();
      // Drop the names already in memory now, not when the reload returns.
      races.forEach(r => (r.entries = []));
      resultDraft = null;
      if (authSheetMode === 'locked' || authSheetMode === 'account')
        closeAuthSheet({ force: true });
    }
    renderAuth();
    // Signing in never reloads the page, so the name loadProfile just seeded
    // into state.user would sit unrendered until the next redraw.
    render();
    reloadIfNamesChanged();
  });
}
// Approval, sign-in or sign-out can change whether this viewer may see full
// names. Reload the races when it no longer matches what's on screen.
function reloadIfNamesChanged() {
  if (loadedFullNames !== null && loadedFullNames !== isMember) loadRaces();
}
// Postgres/PostgREST report a write the allow-list blocked in two different
// shapes: an INSERT's WITH CHECK failure comes back as a real "row-level
// security" error, while an UPDATE/DELETE whose USING clause excludes every
// row returns success with zero rows instead. Both mean the same thing here
// — requireSignIn() already guarantees the caller is signed in by this
// point, so a rejection can only mean their email isn't on the allow-list —
// and both get the same message rather than raw Postgres text or looking
// like nothing happened.
//
// A refusal also means the member's standing may have changed (access removed
// while the page was open), so each one re-reads it: a revoked member is told
// so and signed out at once instead of finding out on the next load.
async function refusedWrite(err) {
  await checkMembership();
  reactToAccess();
  renderAuth();
  render();
  reloadIfNamesChanged();
  return err;
}
async function friendlyWriteError(message) {
  return /row-level security/i.test(message)
    ? refusedWrite(new Error('This action is for approved members only.'))
    : new Error(message);
}
async function removeEntry(raceId, name) {
  const { data, error } = await db
    .from('entries')
    .delete()
    .eq('race_id', raceId)
    .eq('name', name)
    .select('id');
  if (error) throw await friendlyWriteError(error.message);
  if (!data || !data.length)
    throw await refusedWrite(new Error('This action is for approved members only.'));
}
async function addEvent(raceId, event) {
  const race = races.find(r => r.id === raceId);
  const events = [...new Set([...(race?.events || []), event])];
  const { data, error } = await db.from('races').update({ events }).eq('id', raceId).select('id');
  if (error) throw await friendlyWriteError(error.message);
  if (!data || !data.length)
    throw await refusedWrite(new Error('This action is for approved members only.'));
}
// Only for a name already loaded into the form as the entry being edited
// (state.form.editingName), via the Edit button or picking up your own
// existing entry — never for a first-time commitment, which is addEntry,
// below. An UPDATE, not an upsert: if the entry was removed or renamed by an
// admin meanwhile, this finds nothing and says so, rather than inserting a
// new row under the old name.
async function saveEntry(raceId, name, events, level) {
  const { data, error } = await db
    .from('entries')
    .update({ events, level })
    .eq('race_id', raceId)
    .eq('name', name)
    .select('id');
  if (error) throw await friendlyWriteError(error.message);
  if (!data || !data.length)
    throw await refusedWrite(
      new Error(
        `Could not find ${name} on this race any more. It may have just been changed. Refresh and try again. (This action is also for approved members only.)`,
      ),
    );
}
// A first-time commitment (no entry was loaded into the form to begin with)
// is an INSERT, not an upsert: typing a name already on the roster must be
// refused, not silently take over that member's row and commitment level.
// The unique (race_id, name) constraint does the refusing; an INSERT can't
// upsert by definition, so this gets it for free the way saveEntry can't.
async function addEntry(raceId, name, events, level) {
  const { error } = await db.from('entries').insert({ race_id: raceId, name, events, level });
  if (error) {
    if (error.code === '23505')
      throw new Error(
        `${name} is already on this race. If that's you, use their "Edit" link on the roster instead of adding a new entry.`,
      );
    throw await friendlyWriteError(error.message);
  }
}
// Results. One row per entry, so a save is an upsert on entry_id. RLS lets
// the entry's owner or an admin through, and only from race day. A refused
// INSERT comes back as a "row-level security" error, so that message is
// reworded for what it means here.
function friendlyResultError(message) {
  if (/row-level security/i.test(message))
    return new Error(
      'Only the member on this entry, or a club admin, can save a result here. Results open on race day.',
    );
  if (/check constraint/i.test(message))
    return new Error('That result is not valid. Check the time and the places.');
  return new Error(message);
}
async function saveResult(entryId, fields) {
  const { data, error } = await db
    .from('results')
    .upsert({ entry_id: entryId, ...fields }, { onConflict: 'entry_id' })
    .select('id');
  if (error) throw friendlyResultError(error.message);
  if (!data || !data.length)
    throw await refusedWrite(new Error('This action is for approved members only.'));
}
async function removeResult(entryId) {
  const { data, error } = await db.from('results').delete().eq('entry_id', entryId).select('id');
  if (error) throw friendlyResultError(error.message);
  if (!data || !data.length)
    throw await refusedWrite(
      new Error('That result is already gone, or it is not yours to remove.'),
    );
}
async function addRace(payload) {
  const { error } = await db.from('races').insert({
    name: payload.name,
    date: payload.date,
    location: payload.location || 'Location TBC',
    url: payload.url || null,
    events: payload.events || [],
    event_type: payload.eventType || null,
    club_focus: payload.eventType === 'Balance Bolt' || payload.clubFocus === 'Y',
    balance_bolt: payload.eventType === 'Balance Bolt',
  });
  if (error) throw await friendlyWriteError(error.message);
}
// Removing a race is a soft delete: it stamps deleted_at rather than dropping
// the row. A race carries its roster, so a hard delete destroys other people's
// commitments too. There is no delete policy on races any more, and the update
// policy only matches live rows, so this cannot resurrect one either.
async function deleteRace(raceId) {
  // .select() makes the updated rows come back, so a write that matches nothing
  // (row-level security returns success with zero rows rather than an error)
  // surfaces instead of looking like it worked.
  const { data, error } = await db
    .from('races')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', raceId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw await friendlyWriteError(error.message);
  if (!data || !data.length)
    throw await refusedWrite(
      new Error('This action is for approved members only, or the race was already removed.'),
    );
}
async function updateRace(raceId, payload) {
  const { data, error } = await db
    .from('races')
    .update({
      name: payload.name,
      date: payload.date,
      url: payload.url || null,
      events: payload.events || [],
      event_type: payload.eventType || null,
      club_focus: payload.eventType === 'Balance Bolt' || payload.clubFocus === 'Y',
      balance_bolt: payload.eventType === 'Balance Bolt',
    })
    .eq('id', raceId)
    .select('id');
  if (error) throw await friendlyWriteError(error.message);
  if (!data || !data.length)
    throw await refusedWrite(new Error('This action is for approved members only.'));
}
// ---------------------------------------------------------------------------
// Routing. Every race is shareable at <base>race/<slug>.
//
// The site is served from a GitHub Pages *project* path
// (jthoyer.github.io/BalanceTRI-app/), not the domain root, so the base is
// derived from the URL at load rather than hardcoded to '/'. Deriving it from
// the one route shape we have means no repo-name constant to keep in sync —
// see 404.html and the restore script in index.html for the other half of the
// GitHub Pages deep-link story.
// ---------------------------------------------------------------------------
const ROUTE_RE = /^(.*?)\/race\/([^/]+)\/?$/;
function computeBasePath(pathname) {
  const m = pathname.match(ROUTE_RE);
  if (m) return (m[1] || '') + '/';
  return pathname.replace(/[^/]*$/, '') || '/';
}
const BASE_PATH = computeBasePath(location.pathname);
// A plain href (no click handler) so it's a real navigation to the app root —
// clicking it from a race screen, or from the main page itself, reloads fresh.
$('#brandLink').href = BASE_PATH;
function slugFromPath(pathname) {
  const m = pathname.match(ROUTE_RE);
  if (!m) return null;
  try {
    return decodeURIComponent(m[2]);
  } catch {
    return m[2];
  }
}
function slugify(value) {
  // NFD splits "ä" into "a" + a combining mark; \p{M} then drops the mark, so
  // accented names slug the same way the database's translate() table does.
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
// Mirrors the database's slugify()/races_assign_slug(). Used only as a fallback
// so the app still routes if a row predates the slug migration (loadRaces
// selects *, so a missing column comes back undefined rather than erroring).
// It cannot reproduce the -2/-3 de-dup suffix, which is why the real column is
// matched first in findRaceBySlug.
function fallbackSlug(race) {
  // Balance Bolt race names already say "BALANCE BOLT #1" in the data, so strip
  // that lead-in before re-adding it — otherwise it doubles up, mirroring the
  // same fix in the database's races_assign_slug().
  const base =
    slugify(
      race.eventType === 'Balance Bolt'
        ? `balance-bolt-${(race.name || '').replace(/^\s*balance\s*bolt\s*/i, '')}`
        : race.name,
    ) || 'race';
  const year = (race.date || '').slice(0, 4);
  return year ? `${base}-${year}` : base;
}
function raceSlug(race) {
  return race.slug || fallbackSlug(race);
}
function racePath(race) {
  return `${BASE_PATH}race/${encodeURIComponent(raceSlug(race))}`;
}
function findRaceBySlug(slug) {
  if (!slug) return null;
  const key = slug.toLowerCase();
  return (
    races.find(r => (r.slug || '').toLowerCase() === key) ||
    races.find(r => fallbackSlug(r).toLowerCase() === key) ||
    null
  );
}
function navigate(path, { replace = false } = {}) {
  if (path === location.pathname) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
}
// bootstrapped: the first load attempt has finished, so popstate has something
// to route against. deepLinkResolved: a *successful* load has had a chance to
// match the incoming URL — kept separate so that a first load which failed and
// was then retried with Refresh still resolves the deep link.
let bootstrapped = false;
let deepLinkResolved = false;
function routeFromUrl() {
  if (editingId !== null) {
    editingId = null;
    $('#editScreen').classList.add('hidden');
  }
  const slug = slugFromPath(location.pathname);
  let missing = false;
  if (slug) {
    const race = findRaceBySlug(slug);
    // 'replace' rather than 'none': an exact match is a no-op, but a slug that
    // differs only in case or encoding gets rewritten to its canonical form
    // without adding a history entry.
    if (race) {
      openRaceScreen(race.id, { history: 'replace', scroll: false });
      return;
    }
    // If Supabase is unreachable we have no races to match against, so the slug
    // isn't known to be bad — leave the URL alone and let the list show the
    // fetch error, rather than destroying a link that may be perfectly good.
    if (!loadError) {
      missing = true;
      navigate(BASE_PATH, { replace: true });
    }
  }
  if (openId !== null) closeRaceScreen({ history: 'none' });
  else render();
  if (missing) showToast('That race link no longer works — showing the race list instead.');
}
function openRaceScreen(raceId, opts = {}) {
  const race = races.find(r => r.id === raceId);
  if (!race) return false;
  const mine = myEntry(race);
  raceScreenReturnFocus = document.activeElement;
  openId = raceId;
  state.form = {
    events: mine ? mine.events.slice() : [],
    otherText: '',
    otherOpen: false,
    level: mine?.level || 'considering',
    commitOpen: !!mine,
    editingName: mine?.name || '',
  };
  persist();
  if (editingId !== null) {
    editingId = null;
    $('#editScreen').classList.add('hidden');
  }
  $('#top').classList.add('hidden');
  document.querySelector('.toolbar').classList.add('hidden');
  $('#addPanel').classList.add('hidden');
  $('#upcomingHeading').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#raceList').classList.add('hidden');
  $('#raceScreen').classList.remove('hidden');
  if (opts.history !== 'none') navigate(racePath(race), { replace: opts.history === 'replace' });
  if (opts.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
  // Hiding #raceList doesn't move a keyboard user anywhere; land them on the
  // new screen's back button rather than stranding focus on a now-hidden
  // element (or nothing, on a fresh page load).
  $('#raceScreenBackButton').focus();
  return true;
}
function closeRaceScreen(opts = {}) {
  openId = null;
  $('#raceScreen').classList.add('hidden');
  $('#top').classList.remove('hidden');
  document.querySelector('.toolbar').classList.remove('hidden');
  $('#raceList').classList.remove('hidden');
  if (opts.history !== 'none') navigate(BASE_PATH, { replace: opts.history === 'replace' });
  render();
  // Return focus to whatever opened this screen (the race's card, usually);
  // if that's gone — filtered out, or this was a deep link — #raceList has
  // tabindex="-1" for exactly this fallback.
  const target =
    raceScreenReturnFocus && document.body.contains(raceScreenReturnFocus)
      ? raceScreenReturnFocus
      : $('#raceList');
  target.focus({ preventScroll: true });
  raceScreenReturnFocus = null;
}
// After a reload, keep the URL pointing at the open race — a rename changes the
// slug, so the address bar would otherwise still hold the old one.
function syncOpenRaceUrl() {
  if (openId === null) return;
  const race = races.find(r => r.id === openId);
  if (race) navigate(racePath(race), { replace: true });
}
// Balance Bolt races only need a date and a race number, and they are always club
// focus races — so the other fields are hidden and the name field is relabelled.
// Shared by #raceForm and #editForm, whose field markup comes from the same
// #raceFormFieldsTemplate (see the querySelectorAll('#raceForm,#editForm')
// block, below), so the two can never drift out of sync with each other.
function applyEventTypeFields(form) {
  const bolt = form.eventType.value === 'Balance Bolt';
  form
    .querySelectorAll('.field-url,.field-events,.checkbox-field')
    .forEach(el => el.classList.toggle('hidden', bolt));
  const nameField = form.querySelector('.field-name');
  nameField.querySelector('.field-label').textContent = bolt ? 'Race #' : 'Race name';
  nameField.querySelector('input').placeholder = bolt ? 'e.g. 3' : 'e.g. Melbourne Marathon';
}
function openEditScreen(raceId) {
  const race = races.find(r => r.id === raceId);
  if (!race) return;
  editScreenReturnFocus = document.activeElement;
  editingId = raceId;
  $('#editBackLabel').textContent = `Back to ${race.name}`;
  $('#editScreenTitle').textContent = race.name;
  const f = $('#editForm');
  f.name.value = race.name;
  f.date.value = race.date;
  f.url.value = race.url || '';
  f.events.value = race.events.join(', ');
  f.eventType.value = eventTypes.includes(race.eventType) ? race.eventType : '';
  f.clubFocus.checked = race.clubFocus === 'Y';
  applyEventTypeFields(f);
  $('#top').classList.add('hidden');
  document.querySelector('.toolbar').classList.add('hidden');
  $('#addPanel').classList.add('hidden');
  $('#upcomingHeading').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#raceList').classList.add('hidden');
  $('#raceScreen').classList.add('hidden');
  $('#editScreen').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#editBackButton').focus();
}
function closeEditScreen() {
  editingId = null;
  $('#editScreen').classList.add('hidden');
  if (openId) {
    $('#raceScreen').classList.remove('hidden');
  } else {
    $('#top').classList.remove('hidden');
    document.querySelector('.toolbar').classList.remove('hidden');
    $('#raceList').classList.remove('hidden');
  }
  render();
  const fallback = openId ? $('#raceScreenEditButton') : $('#raceList');
  const target =
    editScreenReturnFocus && document.body.contains(editScreenReturnFocus)
      ? editScreenReturnFocus
      : fallback;
  target.focus({ preventScroll: true });
  editScreenReturnFocus = null;
}
// Which names the last load fetched. Names are for approved members only (the
// entries read policy). Everyone else gets public_race_counts(): how many
// members are going to each race and how many are locked in, with no names.
// When membership changes, the races are loaded again so the roster matches.
let loadedFullNames = null;
async function loadRaces() {
  try {
    loadError = null;
    const fullNames = isMember;
    const racesQuery = db
      .from('races')
      .select(fullNames ? '*, entries(id,name,events,level,created_by)' : '*')
      // Signed-in members can read removed races (the select policy has to
      // let them, or the soft delete itself is rejected — see the
      // races_auth_writes_and_soft_delete migration). Filter them here so a
      // removed race doesn't reappear on the calendar just because you
      // signed in. Anonymous visitors never see them at all.
      .is('deleted_at', null)
      .order('date');
    const [{ data, error }, publicCounts, resultRows] = await Promise.all([
      racesQuery,
      fullNames ? null : loadPublicCounts(),
      // Results are for approved members only; nobody else asks for them.
      fullNames
        ? db
            .from('results')
            .select('entry_id,status,finish_seconds,place_overall,place_age_group,is_pb,note')
        : null,
    ]);
    if (error) throw error;
    // A database without the results table (or a failed read) shows the
    // calendar with no results rather than failing the whole load.
    if (resultRows?.error) console.warn('results not loaded:', resultRows.error);
    resultsLoaded = !!resultRows && !resultRows.error;
    const resultByEntry = new Map((resultRows?.data || []).map(r => [r.entry_id, r]));
    const countsByRace = publicCounts || new Map();
    loadedFullNames = fullNames;
    races = (data || []).map(r => {
      const entries = (fullNames ? r.entries || [] : []).map(e => ({
        ...e,
        events: (e.events || []).map(String),
        level: String(e.level),
        result: resultByEntry.get(e.id) || null,
      }));
      const counts = fullNames
        ? {
            committed: entries.filter(e => e.level !== 'not').length,
            locked: entries.filter(e => e.level === 'locked').length,
          }
        : countsByRace.get(r.id) || { committed: 0, locked: 0 };
      return {
        id: r.id,
        name: r.name,
        date: r.date,
        location: r.location,
        url: r.url,
        slug: r.slug || null,
        events: r.events || [],
        eventType: r.event_type || '',
        clubFocus: r.club_focus ? 'Y' : 'N',
        balanceBolt: r.event_type === 'Balance Bolt' ? 'Y' : 'N',
        entries,
        committed: counts.committed,
        locked: counts.locked,
      };
    });
  } catch (err) {
    // The member sees a generic "could not reach" message; the real cause
    // (network, RLS, a bad column in the select) is only ever visible here.
    console.error('loadRaces failed:', err);
    loadError = 'fetch-failed';
    races = [];
  }
  $('#raceLoading')?.remove();
  // Sign-in can finish while this load was in flight: if membership changed
  // meanwhile, load again with the right names.
  if (!loadError) queueMicrotask(reloadIfNamesChanged);
  // Only a load that actually returned races can resolve a deep link: until
  // then a valid /race/<slug> is indistinguishable from a stale one.
  bootstrapped = true;
  if (!deepLinkResolved) {
    if (!loadError) deepLinkResolved = true;
    routeFromUrl();
    return;
  }
  syncOpenRaceUrl();
  render();
}
// Counts for everyone who isn't an approved member: race id -> { committed,
// locked }. No names. public_race_counts() sends counts only. Until that
// migration is live, fall back to the old public_entries() and keep only the
// counts, so no name is ever stored or shown on the page. PGRST202 on both
// means an older database: the races show with no counts.
async function loadPublicCounts() {
  const counts = new Map();
  const res = await db.rpc('public_race_counts');
  // Any other failure shows the races with no counts rather than failing the
  // whole calendar for every visitor.
  if (res.error && res.error.code !== 'PGRST202') {
    console.warn('race counts not loaded:', res.error);
    return counts;
  }
  if (!res.error) {
    for (const c of res.data || [])
      counts.set(c.race_id, { committed: Number(c.committed) || 0, locked: Number(c.locked) || 0 });
    return counts;
  }
  const old = await db.rpc('public_entries');
  if (old.error) {
    if (old.error.code !== 'PGRST202') console.warn('race counts not loaded:', old.error);
    return counts;
  }
  for (const e of old.data || []) {
    const c = counts.get(e.race_id) || { committed: 0, locked: 0 };
    if (e.level !== 'not') c.committed += 1;
    if (e.level === 'locked') c.locked += 1;
    counts.set(e.race_id, c);
  }
  return counts;
}
function render() {
  // Supabase fires its start-up auth event, which re-renders, before the
  // first load returns. Rendering then would swap the loader for "No races
  // here yet". loadRaces renders as soon as it finishes.
  if (!bootstrapped) return;
  const list = $('#raceList');
  list.innerHTML = '';
  document
    .querySelectorAll('.view-toggle-btn')
    .forEach(b => b.classList.toggle('selected', b.dataset.view === state.viewFilter));
  const past = state.whenFilter === 'past';
  document.querySelectorAll('.when-toggle-btn').forEach(b => {
    const on = b.dataset.when === state.whenFilter;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#upcomingHeadingText').textContent = past ? 'Past races' : 'Upcoming races';
  $('#updateBannerText').textContent = toast || '';
  $('#updateBanner').classList.toggle('hidden', !toast);
  $('#updateBanner').classList.toggle('error', toastKind === 'error');
  $('#updateBannerCheck').classList.toggle('hidden', toastKind === 'error');
  $('#updateBannerAlert').classList.toggle('hidden', toastKind !== 'error');
  renderResultReminder();
  if (loadError === 'fetch-failed') {
    $('#emptyState').textContent =
      'Could not reach the Supabase backend. Check your connection and try refreshing.';
    $('#emptyState').classList.remove('hidden');
    $('#nextRace').classList.add('hidden');
    return;
  }
  renderNextRace();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const byType = r => !state.eventTypeFilter || r.eventType === state.eventTypeFilter;
  // Past races run newest first, so last month's race is at the top.
  const sorted = [...races]
    .filter(r => (past ? r.date < todayStr : r.date >= todayStr))
    .filter(r => (state.viewFilter === 'club' ? r.clubFocus === 'Y' : true))
    .filter(byType)
    .sort((a, b) => (past ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));
  // The name search is for approved members: nobody else has names to search.
  $('#athleteFilterLabel').classList.toggle('hidden', !isMember);
  const query = isMember ? state.filter.trim().toLocaleLowerCase() : '';
  const shown = query
    ? sorted.filter(r => r.entries.some(e => e.name.toLocaleLowerCase().includes(query)))
    : sorted;
  const filter = $('#athleteFilter');
  filter.value = state.filter;
  $('#eventTypeFilter').value = state.eventTypeFilter;
  const active = [],
    tips = [];
  if (query) {
    active.push(`the name “${state.filter.trim()}”`);
    tips.push('clearing the name search');
  }
  if (state.eventTypeFilter) {
    active.push(`the type “${state.eventTypeFilter}”`);
    tips.push('choosing “All types”');
  }
  if (state.viewFilter === 'club') {
    active.push('the club-races view');
    tips.push('choosing “View all”');
  }
  const joinWith = (a, w) =>
    a.length < 2 ? a[0] : `${a.slice(0, -1).join(', ')} ${w} ${a[a.length - 1]}`;
  $('#emptyState').textContent = active.length
    ? `No ${past ? 'past' : 'upcoming'} races match ${joinWith(active, 'and')}. Try ${joinWith(tips, 'or')}.`
    : past
      ? 'No past races yet. Races move here once their date has passed.'
      : session
        ? 'No races here yet. Add a race to get started.'
        : 'No races here yet.';
  if (!editingId && !openId) {
    $('#emptyState').classList.toggle('hidden', shown.length > 0);
    $('#upcomingHeading').classList.toggle('hidden', shown.length === 0);
  }
  let last = '';
  const appendRace = (race, container) => {
    const p = dateParts(race.date);
    if (p.group !== last) {
      const h = document.createElement('div');
      h.className = 'month-label';
      h.textContent = p.group;
      container.append(h);
      last = p.group;
    }
    const node = $('#raceTemplate').content.cloneNode(true);
    const summary = node.querySelector('.race-summary');
    summary.classList.toggle('club-focus', race.clubFocus === 'Y');
    summary.classList.toggle('past', past);
    summary.setAttribute('aria-label', `View commitments for ${race.name}`);
    node.querySelector('.date-tile strong').textContent = p.day;
    node.querySelector('.date-tile span').textContent = p.month;
    const h2 = node.querySelector('.race-info h2');
    h2.textContent = race.name;
    if (race.eventType) {
      h2.append(' ');
      const b = document.createElement('span');
      b.className = 'event-type-badge';
      b.textContent = race.eventType;
      h2.append(b);
    }
    if (race.clubFocus === 'Y') {
      h2.append(' ');
      const b = document.createElement('span');
      b.className = 'club-focus-badge';
      b.textContent = 'Club focus';
      h2.append(b);
    }
    const locked = race.locked;
    // Approved members also see how many results are in; everyone else gets
    // the line they always had.
    const resultCount = isMember ? race.entries.filter(e => e.result).length : 0;
    node.querySelector('.race-meta').textContent = past
      ? `${locked} raced` +
        (resultCount ? ` · ${resultCount} result${resultCount === 1 ? '' : 's'}` : '')
      : `${locked} locked in of ${race.committed}`;
    summary.href = racePath(race);
    summary.onclick = e => {
      // A real href is what makes "open in new tab" and "copy link address" work,
      // so hand those cases back to the browser and only intercept the plain
      // left click that means "show me this race here".
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      e.preventDefault();
      openRaceScreen(race.id);
    };
    container.append(node);
  };
  shown.forEach(race => appendRace(race, list));
  // The one thing screen readers should hear after a filter change: not the
  // whole rebuilt list (see the comment on #raceList in index.html), just
  // how many races matched.
  $('#raceListStatus').textContent = `${shown.length} race${shown.length === 1 ? '' : 's'} shown`;
  if (openId) {
    const openRace = races.find(r => r.id === openId);
    if (openRace) {
      const p = dateParts(openRace.date);
      $('#raceScreenEyebrow').textContent =
        `${p.day} ${p.month.toUpperCase()} ${p.group.split(' ')[1]}`;
      $('#raceScreenTitle').textContent = openRace.name;
      $('#raceScreenEditButton').onclick = () => {
        if (!requireSignIn('Sign in to edit this race')) return;
        openEditScreen(openRace.id);
      };
      gateButton($('#raceScreenEditButton'));
      const body = $('#raceScreenBody');
      // A toast re-renders this screen. Keep keyboard focus on a row's result
      // button across the rebuild instead of dropping it to the page.
      const focused = document.activeElement;
      const focusedResultId = focused?.classList?.contains('result-edit')
        ? focused.closest('.result-entry')?.dataset.entryId
        : null;
      body.innerHTML = '';
      body.append(makeDetails(openRace));
      if (focusedResultId)
        body
          .querySelector(
            `.result-entry[data-entry-id="${CSS.escape(focusedResultId)}"] .result-edit`,
          )
          ?.focus({ preventScroll: true });
    } else {
      openId = null;
      $('#raceScreen').classList.add('hidden');
      $('#top').classList.remove('hidden');
      document.querySelector('.toolbar').classList.remove('hidden');
      $('#raceList').classList.remove('hidden');
    }
  }
  applyMemberGating();
}
// What a visitor, or an account waiting for approval, sees in place of the
// roster: the counts, and why there are no names. They are never sent names.
function buildMembersOnlyRoster(host, race) {
  const count = document.createElement('p');
  count.className = 'members-only-count';
  const past = race.date < sydneyToday();
  count.textContent = past
    ? `${race.locked} raced`
    : race.committed
      ? `${race.committed} member${race.committed === 1 ? '' : 's'} going · ${race.locked} locked in`
      : 'No commitments yet.';
  const note = document.createElement('p');
  note.className = 'helper-text members-only-note';
  note.textContent = session
    ? 'Names show once the club approves your account.'
    : 'Names are for club members. Sign in to see who is going.';
  host.append(count, note);
}
// Builds the club-commitments roster as DOM nodes. Every member-supplied
// string — the event-group label and the entry name — goes in via textContent
// or setAttribute, never as markup. See the shell comment in makeDetails.
function buildRoster(host, eventKeys, eventGroups, levelLabel) {
  if (!eventKeys.length) {
    const empty = document.createElement('p');
    empty.className = 'helper-text';
    empty.textContent = 'No commitments yet — be the first.';
    host.append(empty);
    return;
  }
  eventKeys.forEach(key => {
    const group = document.createElement('div');
    group.className = 'roster-group';
    const label = document.createElement('p');
    label.className = 'roster-group-label';
    label.textContent = key;
    group.append(label);
    eventGroups[key].forEach(entry => {
      const row = document.createElement('div');
      row.className = 'roster-entry';
      const who = document.createElement('div');
      who.className = 'roster-who';
      const name = document.createElement('span');
      name.className = 'roster-name';
      name.textContent = entry.name;
      const level = document.createElement('span');
      // The level comes from the database too. It only ever reaches a class
      // name, so it cannot inject markup, but an unrecognised value would
      // still put an arbitrary string in the class list — so it is checked
      // against the levels this app actually knows about.
      const known = levels.some(([levelKey]) => levelKey === entry.level);
      level.className = known ? `roster-level level-${entry.level}` : 'roster-level';
      level.textContent = levelLabel[entry.level] || entry.level;
      who.append(name, level);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'roster-edit';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${entry.name}'s commitment for this race`);
      row.append(who, edit);
      group.append(row);
    });
    host.append(group);
  });
}
// ---------------------------------------------------------------------------
// The race screen for an approved member once results are open: "Club
// results" in place of "Club commitments". Everything member-supplied (names,
// notes, event labels) goes in via textContent, never as markup.
// ---------------------------------------------------------------------------
function resultEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
// Where focus goes once the screen has been rebuilt: the form's first field
// when it opens, the row's Edit button when it closes.
let resultFocusEntryId = null;
// Within a group: fastest finishers first, then DNF, then DNS, then members
// with no result yet, each by name.
function resultOrder(a, b) {
  const rank = e =>
    !e.result ? 3 : e.result.status === 'finished' ? 0 : e.result.status === 'dnf' ? 1 : 2;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 0 && a.result.finish_seconds !== b.result.finish_seconds)
    return a.result.finish_seconds - b.result.finish_seconds;
  return a.name.localeCompare(b.name);
}
function resultSummary(result) {
  const who = resultEl('span', 'result-summary');
  const status = RESULT_STATUSES.find(([key]) => key === result.status);
  who.append(
    resultEl(
      'span',
      `result-status result-${status ? result.status : 'other'}`,
      result.status === 'finished' && result.finish_seconds
        ? formatFinishTime(result.finish_seconds)
        : status
          ? status[1]
          : result.status,
    ),
  );
  const places = [];
  if (result.place_overall) places.push(`Overall ${result.place_overall}`);
  if (result.place_age_group) places.push(`Age group ${result.place_age_group}`);
  if (places.length) who.append(resultEl('span', 'result-places', places.join(' · ')));
  if (result.is_pb) who.append(resultEl('span', 'result-pb', 'PB'));
  return who;
}
function buildResultForm(entry) {
  const d = resultDraft;
  const form = resultEl('form', 'result-form');
  form.noValidate = true;
  const set = resultEl('fieldset', 'result-fieldset');
  set.append(resultEl('legend', 'result-legend', `Result for ${entry.name}`));

  set.append(resultEl('p', 'choice-label', 'How did it go?'));
  const statusRow = resultEl('div', 'choices');
  statusRow.setAttribute('role', 'group');
  statusRow.setAttribute('aria-label', 'Result status');
  const statusButtons = RESULT_STATUSES.map(([key, label]) => {
    const b = resultEl('button', 'choice', label);
    b.type = 'button';
    b.onclick = () => {
      d.status = key;
      sync();
    };
    statusRow.append(b);
    return [key, b];
  });
  set.append(statusRow);

  // Fields that only a finished race has: hidden for DNF and DNS.
  const finishedOnly = resultEl('div', 'result-finished-fields');
  const field = (labelText, id, value, attrs, hint) => {
    const wrap = resultEl('div', 'result-field');
    const label = resultEl('label', 'choice-label', labelText);
    label.htmlFor = id;
    const input = resultEl('input', 'result-input');
    input.id = id;
    input.type = 'text';
    input.autocomplete = 'off';
    input.value = value;
    for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
    wrap.append(label, input);
    if (hint) {
      const h = resultEl('p', 'helper-text', hint);
      h.id = id + '-hint';
      input.setAttribute('aria-describedby', h.id);
      wrap.append(h);
    }
    return [wrap, input];
  };
  const [timeWrap, timeInput] = field(
    'Finish time',
    'result-time',
    d.time,
    { placeholder: '1:23:45', inputmode: 'numeric' },
    'Hours, minutes and seconds, like 1:23:45. Under an hour: 45:30.',
  );
  timeInput.oninput = () => (d.time = timeInput.value);
  const [overallWrap, overallInput] = field('Overall place', 'result-overall', d.overall, {
    inputmode: 'numeric',
  });
  overallInput.oninput = () => (d.overall = overallInput.value);
  const [ageWrap, ageInput] = field('Age-group place', 'result-age', d.ageGroup, {
    inputmode: 'numeric',
  });
  ageInput.oninput = () => (d.ageGroup = ageInput.value);
  const placesRow = resultEl('div', 'result-places-row');
  placesRow.append(overallWrap, ageWrap);
  const pbLabel = resultEl('label', 'result-pb-check');
  const pb = document.createElement('input');
  pb.type = 'checkbox';
  pb.checked = d.pb;
  pb.onchange = () => (d.pb = pb.checked);
  pbLabel.append(pb, ' Personal best');
  finishedOnly.append(timeWrap, placesRow, pbLabel);
  set.append(finishedOnly);

  const noteWrap = resultEl('div', 'result-field');
  const noteLabel = resultEl('label', 'choice-label', 'Note ');
  noteLabel.htmlFor = 'result-note';
  noteLabel.append(resultEl('span', 'optional', 'optional'));
  const note = resultEl('textarea', 'result-input result-note-input');
  note.id = 'result-note';
  note.rows = 2;
  note.maxLength = RESULT_NOTE_MAX;
  note.value = d.note;
  note.oninput = () => (d.note = note.value);
  noteWrap.append(noteLabel, note);
  set.append(noteWrap);

  const error = resultEl('p', 'result-error', d.error);
  error.setAttribute('role', 'alert');
  error.classList.toggle('hidden', !d.error);
  set.append(error);

  const actions = resultEl('div', 'save-row');
  const save = resultEl('button', 'save-button', 'Save result');
  save.type = 'submit';
  actions.append(save);
  if (entry.result) {
    const remove = resultEl('button', 'remove-commit-button', 'Remove result');
    remove.type = 'button';
    remove.onclick = async () => {
      if (!requireSignIn('Sign in to remove this result')) return;
      if (
        !(await confirmDialog({
          title: 'Remove result?',
          body: `Remove ${entry.name}'s result from this race?`,
        }))
      )
        return;
      remove.disabled = true;
      remove.textContent = 'Removing…';
      try {
        await removeResult(entry.id);
        resultDraft = null;
        await loadRaces();
        resultFocusEntryId = entry.id;
        showToast('Result removed.');
      } catch (err) {
        remove.disabled = false;
        remove.textContent = 'Remove result';
        showToast('Could not remove: ' + err.message, 'error');
      }
    };
    actions.append(remove);
  }
  const cancel = resultEl('button', 'roster-edit', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => {
    resultDraft = null;
    resultFocusEntryId = entry.id;
    render();
  };
  actions.append(cancel);
  set.append(actions);
  form.append(set);

  // Show only what the chosen status needs.
  function sync() {
    for (const [key, b] of statusButtons) {
      b.classList.toggle('selected', d.status === key);
      b.setAttribute('aria-pressed', String(d.status === key));
    }
    finishedOnly.classList.toggle('hidden', d.status !== 'finished');
  }
  sync();

  const fail = (message, input) => {
    d.error = message;
    error.textContent = message;
    error.classList.remove('hidden');
    input.focus();
  };
  form.onsubmit = async ev => {
    ev.preventDefault();
    if (!requireSignIn('Sign in to save your result')) return;
    const fields = {
      status: d.status,
      finish_seconds: null,
      place_overall: null,
      place_age_group: null,
      is_pb: false,
      note: d.note.trim() || null,
    };
    if (d.status === 'finished') {
      const seconds = parseFinishTime(d.time);
      if (seconds === null)
        return fail(
          'Enter the time as h:mm:ss, like 1:23:45. It must be under 48 hours.',
          timeInput,
        );
      const overall = parsePlace(d.overall);
      if (overall === undefined)
        return fail('Overall place must be a whole number, 1 or more.', overallInput);
      const age = parsePlace(d.ageGroup);
      if (age === undefined)
        return fail('Age-group place must be a whole number, 1 or more.', ageInput);
      Object.assign(fields, {
        finish_seconds: seconds,
        place_overall: overall,
        place_age_group: age,
        is_pb: d.pb,
      });
    }
    d.error = '';
    error.classList.add('hidden');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await saveResult(entry.id, fields);
      resultDraft = null;
      await loadRaces();
      resultFocusEntryId = entry.id;
      showToast('Result saved.');
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Save result';
      d.error = err.message;
      showToast('Could not save: ' + err.message, 'error');
      // The toast rebuilt the form from the draft; put focus back on Save.
      $('#raceScreenBody .result-form button[type=submit]')?.focus();
    }
  };
  if (d.focus) {
    d.focus = false;
    setTimeout(() => (d.status === 'finished' ? timeInput : statusButtons[0][1]).focus(), 0);
  }
  return form;
}
function buildResultsRoster(host, race, eventKeys, eventGroups) {
  if (!eventKeys.length) {
    host.append(resultEl('p', 'helper-text', 'Nobody was on the roster for this race.'));
    return;
  }
  eventKeys.forEach(key => {
    const group = resultEl('div', 'roster-group');
    group.append(resultEl('p', 'roster-group-label', key));
    eventGroups[key].forEach(entry => {
      const item = resultEl('div', 'result-entry');
      item.dataset.entryId = entry.id;
      const row = resultEl('div', 'roster-entry');
      const who = resultEl('div', 'roster-who');
      who.append(resultEl('span', 'roster-name', entry.name));
      if (entry.result) who.append(resultSummary(entry.result));
      row.append(who);
      const editing = resultDraft?.entryId === entry.id;
      if (canEditResult(entry) && !editing) {
        const btn = resultEl(
          'button',
          'roster-edit result-edit',
          entry.result ? 'Edit result' : 'Add result',
        );
        btn.type = 'button';
        btn.setAttribute(
          'aria-label',
          `${entry.result ? 'Edit' : 'Add'} ${entry.name}'s result for this race`,
        );
        btn.onclick = () => {
          if (!requireSignIn('Sign in to add a result')) return;
          resultDraft = draftFrom(entry);
          resultDraft.focus = true;
          render();
        };
        row.append(btn);
        if (resultFocusEntryId === entry.id) {
          resultFocusEntryId = null;
          setTimeout(() => btn.focus({ preventScroll: true }), 0);
        }
      }
      item.append(row);
      if (entry.result?.note) item.append(resultEl('p', 'result-note', entry.result.note));
      if (editing) item.append(buildResultForm(entry));
      group.append(item);
    });
    host.append(group);
  });
}
function makeResultsDetails(race) {
  const wrap = resultEl('div', 'details-card');
  const section = title => {
    wrap.append(resultEl('div', 'card-header', title));
    const body = resultEl('div', 'card-body');
    wrap.append(body);
    return body;
  };
  const websiteUrl = race.url ? safeLinkUrl(race.url) : null;
  if (websiteUrl) {
    const a = resultEl('a', 'race-link', websiteUrl);
    a.href = websiteUrl;
    a.title = websiteUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', `${race.name} website: ${websiteUrl}`);
    section('Race website').append(a);
  }
  // A draft left over from another race is dropped.
  if (resultDraft && !race.entries.some(e => e.id === resultDraft.entryId)) resultDraft = null;
  const entries = race.entries.filter(e => e.level !== 'not');
  const eventGroups = {};
  entries.forEach(e => {
    const key = e.events.length ? e.events.join(', ') : 'Event TBC';
    (eventGroups[key] ||= []).push(e);
  });
  const eventKeys = Object.keys(eventGroups).sort((a, b) => a.localeCompare(b));
  eventKeys.forEach(k => eventGroups[k].sort(resultOrder));
  buildResultsRoster(section('Club results'), race, eventKeys, eventGroups);

  // A member who raced without ever committing: add them to the roster as
  // locked in, then open the form on their new row.
  if (ownName() && !myEntry(race)) {
    const body = section('Your result');
    body.append(
      resultEl(
        'p',
        'helper-text',
        'You are not on this race’s roster. If you raced, add yourself, then record your result.',
      ),
    );
    const raced = resultEl('button', 'commit-toggle-button', 'I raced this');
    raced.type = 'button';
    raced.onclick = async () => {
      if (!requireSignIn('Sign in to add your result')) return;
      raced.disabled = true;
      raced.textContent = 'Adding…';
      try {
        await addEntry(race.id, ownName(), [], 'locked');
        await loadRaces();
        const fresh = races.find(r => r.id === race.id)?.entries.find(e => e.name === ownName());
        if (fresh) {
          resultDraft = draftFrom(fresh);
          resultDraft.focus = true;
          render();
        }
      } catch (err) {
        raced.disabled = false;
        raced.textContent = 'I raced this';
        showToast('Could not add you: ' + err.message, 'error');
      }
    };
    gateButton(raced);
    body.append(raced);
  }
  return wrap;
}
function makeDetails(race) {
  const wrap = document.createElement('div');
  wrap.className = 'details-card';
  // Approved members get the results view once the race has started.
  if (isMember && resultsOpen(race)) return makeResultsDetails(race);
  if (race.balanceBolt === 'Y') {
    const embedUrl = safeLinkUrl(boltEmbedUrl(race) || '');
    const canEmbed = embedUrl !== null && isEmbeddableBoltUrl(embedUrl);
    wrap.innerHTML = `<div class="card-header race-website-header">Race website</div><div class="card-body race-website-body"></div>`;
    const body = wrap.querySelector('.race-website-body');
    if (!embedUrl) {
      wrap.querySelector('.race-website-header').remove();
      body.remove();
    } else if (!canEmbed) {
      // A URL we will not frame stays a plain link: it is the only way to reach it.
      const a = document.createElement('a');
      a.className = 'race-link';
      a.href = embedUrl;
      a.textContent = embedUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.setAttribute('aria-label', `${race.name} website: ${embedUrl}`);
      body.append(a);
    } else {
      // The framed page fills the card edge to edge.
      body.classList.add('race-embed-body');
    }
    if (canEmbed) {
      const iframe = document.createElement('iframe');
      iframe.className = 'race-embed';
      iframe.src = embedUrl;
      iframe.loading = 'lazy';
      iframe.title = `${race.name} embedded website`;
      // Same origin as this app (both under jthoyer.github.io), so the frame's
      // own scroll height is readable — resize to it instead of clipping at a
      // fixed height or leaving a scrollbar inside a scrollbar. That access is
      // only safe because isEmbeddableBoltUrl has already established this is
      // BalanceBolt and not some other page on the same host.
      const resize = () => {
        try {
          iframe.style.height = iframe.contentDocument.documentElement.scrollHeight + 'px';
        } catch (e) {}
      };
      // BalanceBolt's own topbar (its logo, a "Club calendar" link back to this
      // very app, sync status and refresh) is chrome for when it's visited on
      // its own — all redundant once it's sitting inside our "Race website" card.
      const hideChrome = () => {
        try {
          const doc = iframe.contentDocument;
          if (doc.querySelector('.topbar') && !doc.getElementById('embed-chrome-hide')) {
            const style = doc.createElement('style');
            style.id = 'embed-chrome-hide';
            // Its .shell gutter (16px each side, from BalanceBolt's own width:min(1100px, calc(100% - 32px)))
            // is chrome too here — our own card already carries the padding (.race-embed-body is
            // padding:0 for this reason), so left alone the two stack and the sign-up form reads as
            // a page inside our page instead of part of it.
            style.textContent = '.topbar{display:none}.shell{width:100%;margin:0}';
            doc.head.append(style);
          }
        } catch (e) {}
      };
      iframe.addEventListener('load', () => {
        hideChrome();
        resize();
        try {
          new ResizeObserver(resize).observe(iframe.contentDocument.documentElement);
        } catch (e) {}
      });
      body.append(iframe);
    }
    return wrap;
  }
  if (state.form.commitOpen === undefined) {
    state.form.commitOpen = !!myEntry(race);
    state.form.editingName = myEntry(race)?.name || '';
  }
  const entries = race.entries.filter(e => e.level !== 'not');
  const eventGroups = {};
  entries.forEach(e => {
    const key = e.events.length ? e.events.join(', ') : 'Event TBC';
    (eventGroups[key] ||= []).push(e);
  });
  const eventKeys = Object.keys(eventGroups).sort((a, b) => a.localeCompare(b));
  eventKeys.forEach(k => eventGroups[k].sort((a, b) => a.name.localeCompare(b.name)));
  const orderedEntries = eventKeys.flatMap(k => eventGroups[k]);
  const levelLabel = Object.fromEntries(levels);
  const editingEntry = state.form.editingName
    ? race.entries.find(e => e.name === state.form.editingName)
    : null;
  // Static shell, no interpolation. Everything that varies is a class toggle
  // or a node removed below, and everything carrying member-supplied text is
  // built with textContent. Entry names and event labels are typed by members
  // and stored in a row any signed-in member can write, so putting them
  // through innerHTML let one member run script in every other member's
  // browser — with the Supabase session sitting in localStorage.
  wrap.innerHTML = `<div class="card-header race-website-header">Race website</div><div class="card-body race-website-body"></div><div class="card-header">Club commitments</div><div class="card-body roster-body"></div><div class="card-header">Your commitment</div><div class="card-body"><button type="button" class="commit-toggle-button">Add your commitment</button><div class="commitment-fields"><p class="choice-label">Your name</p><div class="name-row"><input class="name-input" readonly aria-readonly="true" title="Your display name. A club admin can change it."></div><p class="choice-label">Commitment level</p><div class="level-choices choices"></div><p class="choice-label">Participation type <span class="optional">select all that apply</span></p><div class="event-choices choices"></div><div class="other-row hidden"><input class="other-input" placeholder="Type your event or distance"></div><div class="save-row"><button type="button" class="save-button">Save commitment</button><button type="button" class="remove-commit-button">Remove commitment</button></div></div></div>`;
  if (!(race.url && safeLinkUrl(race.url))) {
    wrap.querySelector('.race-website-header').remove();
    wrap.querySelector('.race-website-body').remove();
  }
  // Signed out, the toggle and the form stay hidden (even if a saved draft
  // left the form open) and the Sign in / Sign up lockup takes their place.
  wrap
    .querySelector('.commit-toggle-button')
    .classList.toggle('hidden', !session || !!state.form.commitOpen);
  wrap
    .querySelector('.commitment-fields')
    .classList.toggle('hidden', !session || !state.form.commitOpen);
  if (!session)
    wrap
      .querySelector('.commit-toggle-button')
      .before(authLockup({ message: 'Sign in to add your commitment' }));
  if (!editingEntry) wrap.querySelector('.remove-commit-button').remove();
  if (isMember) buildRoster(wrap.querySelector('.roster-body'), eventKeys, eventGroups, levelLabel);
  else buildMembersOnlyRoster(wrap.querySelector('.roster-body'), race);
  const commitToggle = wrap.querySelector('.commit-toggle-button'),
    commitFields = wrap.querySelector('.commitment-fields');
  commitToggle.onclick = () => {
    if (!requireSignIn('Sign in to add your commitment')) return;
    state.form.commitOpen = true;
    persist();
    commitToggle.classList.add('hidden');
    commitFields.classList.remove('hidden');
    nameInput.focus();
  };
  gateButton(commitToggle);
  const websiteUrl = race.url ? safeLinkUrl(race.url) : null;
  if (websiteUrl) {
    const a = document.createElement('a');
    a.className = 'race-link';
    a.href = websiteUrl;
    a.textContent = websiteUrl;
    a.title = websiteUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', `${race.name} website: ${websiteUrl}`);
    wrap.querySelector('.race-website-body').append(a);
  }
  wrap.querySelectorAll('.roster-edit').forEach((btn, i) => {
    btn.onclick = () => {
      if (!requireSignIn('Sign in to edit this entry')) return;
      const entry = orderedEntries[i];
      const opts = participationOptions();
      const known = [],
        extra = [];
      entry.events.forEach(ev => {
        const k = ev.trim().toLowerCase();
        const hit =
          opts.find(o => o.toLowerCase() === k) ||
          (k === 'to' ? 'TO (Technical official)' : k === 'team' ? 'Team' : null);
        if (hit) known.includes(hit) || known.push(hit);
        else extra.push(ev);
      });
      state.form = {
        events: known,
        otherText: extra.join(', '),
        otherOpen: !!extra.length,
        level: entry.level,
        commitOpen: true,
        editingName: entry.name,
      };
      persist();
      render();
      const fields = $('.commitment-fields');
      if (fields) {
        fields.querySelector('.name-input').focus({ preventScroll: true });
        fields.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
    gateButton(btn);
  });
  const removeCommitButton = wrap.querySelector('.remove-commit-button');
  if (removeCommitButton)
    removeCommitButton.onclick = async () => {
      if (!requireSignIn('Sign in to remove this entry')) return;
      if (
        !(await confirmDialog({
          title: 'Remove commitment?',
          body: `Remove ${editingEntry.name} from this race?`,
        }))
      )
        return;
      removeCommitButton.disabled = true;
      removeCommitButton.textContent = 'Removing…';
      try {
        await removeEntry(race.id, editingEntry.name);
        state.form = {
          events: [],
          otherText: '',
          otherOpen: false,
          level: 'considering',
          commitOpen: false,
          editingName: '',
        };
        persist();
        await loadRaces();
      } catch (err) {
        removeCommitButton.disabled = false;
        removeCommitButton.textContent = 'Remove commitment';
        showToast('Could not remove: ' + err.message, 'error');
      }
    };
  gateButton(removeCommitButton);
  const nameInput = wrap.querySelector('.name-input');
  // The name is the member's display name, shown read-only. An entry opened
  // from the roster shows its own name instead. Only an admin changes a name
  // (admin console, Accounts); the database refuses it from anyone else.
  nameInput.value = state.form.editingName || ownName();
  const eventChoices = wrap.querySelector('.event-choices');
  const otherRow = wrap.querySelector('.other-row');
  const otherInput = wrap.querySelector('.other-input');
  otherInput.value = state.form.otherText || '';
  otherInput.oninput = () => {
    state.form.otherText = otherInput.value;
    persist();
  };
  function participationOptions() {
    const merged = [...race.events];
    const ensure = (label, aliases) => {
      const idx = merged.findIndex(e => aliases.includes(e.trim().toLowerCase()));
      if (idx >= 0) merged[idx] = label;
      else merged.push(label);
    };
    ensure('TO (Technical official)', ['to', 'to (technical official)']);
    ensure('Team', ['team']);
    return merged;
  }
  function update() {
    eventChoices.innerHTML = '';
    participationOptions().forEach(event => {
      const b = document.createElement('button');
      b.type = 'button';
      const active = state.form.events.includes(event);
      b.className = 'choice ' + (active ? 'selected' : '');
      b.setAttribute('aria-pressed', String(active));
      b.textContent = event;
      b.onclick = () => {
        state.form.events = active
          ? state.form.events.filter(x => x !== event)
          : [...state.form.events, event];
        persist();
        update();
      };
      eventChoices.append(b);
    });
    const otherBtn = document.createElement('button');
    otherBtn.type = 'button';
    otherBtn.className = 'choice ' + (state.form.otherOpen ? 'selected' : '');
    otherBtn.setAttribute('aria-pressed', String(!!state.form.otherOpen));
    otherBtn.textContent = 'Other';
    otherBtn.onclick = () => {
      state.form.otherOpen = !state.form.otherOpen;
      persist();
      update();
      if (state.form.otherOpen) otherInput.focus();
    };
    eventChoices.append(otherBtn);
    otherRow.classList.toggle('hidden', !state.form.otherOpen);
    const lc = wrap.querySelector('.level-choices');
    lc.innerHTML = '';
    levels.forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `choice level-${key} ${state.form.level === key ? 'selected' : ''}`;
      b.textContent = label;
      b.onclick = () => {
        state.form.level = key;
        persist();
        update();
      };
      lc.append(b);
    });
    const btn = wrap.querySelector('.save-button');
    // A pending member never sees an enabled Save (5.3).
    gateButton(btn);
    btn.onclick = async () => {
      // editingName tells this handler whether it's updating an existing
      // entry or adding a new one, so it stays untouched until the save
      // succeeds, below.
      const previousEditingName = state.form.editingName;
      const name = previousEditingName || ownName();
      if (!name) {
        showToast('Your display name has not loaded. Refresh and try again.', 'error');
        return;
      }
      if (!requireSignIn('Sign in to save your commitment')) return;
      const extra = (state.form.otherText || '').trim();
      const events = [...new Set([...state.form.events, ...(extra ? [extra] : [])])];
      if (!events.length) {
        (state.form.otherOpen ? otherInput : eventChoices).focus?.();
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        for (const ev of events) {
          if (!race.events.includes(ev)) await addEvent(race.id, ev);
        }
        if (previousEditingName) await saveEntry(race.id, name, events, state.form.level);
        else await addEntry(race.id, name, events, state.form.level);
        state.form.editingName = name;
        if (name === ownName()) state.user = name;
        persist();
        await loadRaces();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Save commitment';
        showToast('Could not save: ' + err.message, 'error');
      }
    };
  }
  update();
  return wrap;
}
function toggleAdd(open) {
  const panel = $('#addPanel');
  panel.classList.toggle('hidden', !open);
  if (open) panel.querySelector('input').focus();
}
// Today's date as YYYY-MM-DD in Sydney, whatever the device's time zone: the
// countdown counts club days, so a race tomorrow reads "Tomorrow" at 11:30 pm
// Sydney time even on a phone still set to another zone.
function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}
// Whole days between two YYYY-MM-DD dates. Both parse as UTC midnight, so
// daylight saving never makes a day 23 or 25 hours long.
function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}
// "How did it go?": a card above the hero for an approved member who was
// locked in on a recent race and has no result yet. One race at a time, the
// most recent first. The member can add a time, say they did not start (saves
// a DNS), or put it off ("Later" hides that race on this device).
const REMINDER_DAYS = 14;
function reminderTarget() {
  if (!session || !isMember || !resultsLoaded) return null;
  const today = sydneyToday();
  const oldest = new Date(Date.parse(today) - REMINDER_DAYS * 86400000).toISOString().slice(0, 10);
  const dismissed = state.dismissedReminders || [];
  return (
    [...races]
      .filter(
        r =>
          r.balanceBolt !== 'Y' && r.date < today && r.date >= oldest && !dismissed.includes(r.id),
      )
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(race => ({
        race,
        entry: race.entries.find(e => e.level === 'locked' && !e.result && isOwnEntry(e)),
      }))
      .find(t => t.entry) || null
  );
}
function renderResultReminder() {
  const card = $('#resultReminder');
  const target = openId || editingId !== null ? null : reminderTarget();
  card.classList.toggle('hidden', !target);
  if (!target) return;
  const { race, entry } = target;
  const when = new Date(race.date + 'T12:00:00').toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
  });
  $('#resultReminderTitle').textContent = `How did ${race.name} go?`;
  $('#resultReminderText').textContent =
    `You were locked in on ${when}. Add your time so the club can see how you went.`;
  const buttons = card.querySelectorAll('button');
  const settle = () => $('#raceList').focus({ preventScroll: true });
  $('#resultReminderAdd').onclick = () => {
    openRaceScreen(race.id);
    resultDraft = draftFrom(entry);
    resultDraft.focus = true;
    render();
  };
  $('#resultReminderLater').onclick = () => {
    state.dismissedReminders = [...new Set([...(state.dismissedReminders || []), race.id])];
    persist();
    render();
    settle();
  };
  $('#resultReminderDns').onclick = async () => {
    buttons.forEach(b => (b.disabled = true));
    try {
      await saveResult(entry.id, {
        status: 'dns',
        finish_seconds: null,
        place_overall: null,
        place_age_group: null,
        is_pb: false,
        note: null,
      });
      await loadRaces();
      showToast(`Marked as did not start for ${race.name}. You can change it from the race.`);
      settle();
    } catch (err) {
      showToast('Could not save: ' + err.message, 'error');
    } finally {
      buttons.forEach(b => (b.disabled = false));
    }
  };
}
// The hero's next race card. Follows the view toggle only, not the type or
// name filters: "Club races" counts down to the next club focus race, "View
// all" to the next race of any type. Every string goes in via textContent.
function renderNextRace() {
  const card = $('#nextRace');
  const today = sydneyToday();
  const club = state.viewFilter === 'club';
  const race = races
    .filter(r => r.date >= today && (!club || r.clubFocus === 'Y'))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  card.classList.toggle('hidden', !race);
  if (!race) return;
  const days = daysBetween(today, race.date);
  const count = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : String(days);
  const unit = days > 1 ? 'days to go' : '';
  const eyebrow = club ? 'NEXT CLUB RACE' : 'NEXT ON THE CALENDAR';
  $('#nextRaceEyebrow').textContent = eyebrow;
  const badge = $('#nextRaceBadge');
  const badgeText = club ? 'Club focus' : race.eventType;
  badge.textContent = badgeText;
  badge.classList.toggle('hidden', !badgeText);
  badge.classList.toggle('club-focus', club);
  $('#nextRaceDays').textContent = count;
  $('#nextRaceUnit').textContent = unit;
  $('#nextRaceUnit').classList.toggle('hidden', !unit);
  card.querySelector('.next-race-count').classList.toggle('is-word', days < 2);
  $('#nextRaceName').textContent = race.name;
  const when = new Date(race.date + 'T12:00:00').toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  $('#nextRaceMeta').textContent = race.location ? `${when} · ${race.location}` : when;
  const label = days > 1 ? `${days} days to go` : count;
  card.setAttribute(
    'aria-label',
    `${club ? 'Next club race' : 'Next on the calendar'}: ${race.name}, ${label}, ${when}`,
  );
  card.href = racePath(race);
  card.onclick = e => {
    // Same as the race cards: let the browser handle new-tab and copy-link.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    openRaceScreen(race.id);
  };
}
document.querySelectorAll('.view-toggle-btn').forEach(
  b =>
    (b.onclick = () => {
      state.viewFilter = b.dataset.view;
      persist();
      render();
    }),
);
document.querySelectorAll('.when-toggle-btn').forEach(
  b =>
    (b.onclick = () => {
      state.whenFilter = b.dataset.when;
      // Past opens on "View all": few past races are club focus, so the club
      // view would look empty. The member can still switch back.
      if (state.whenFilter === 'past') state.viewFilter = 'all';
      persist();
      render();
    }),
);
document.querySelectorAll('#raceForm,#editForm').forEach(f => {
  f.querySelector('.add-form-fields').append($('#raceFormFieldsTemplate').content.cloneNode(true));
  f.eventType.onchange = () => applyEventTypeFields(f);
  applyEventTypeFields(f);
});
$('#athleteFilter').oninput = e => {
  state.filter = e.target.value;
  persist();
  render();
};
$('#eventTypeFilter').onchange = e => {
  state.eventTypeFilter = e.target.value;
  persist();
  render();
};
$('#heroAddButton').onclick = () => {
  if (!requireSignIn('Sign in to add a race')) return;
  if (editingId) closeEditScreen();
  toggleAdd(true);
  $('#addPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('#closeAddButton').onclick = () => toggleAdd(false);
$('#cancelAddButton').onclick = () => toggleAdd(false);
$('#raceForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireSignIn('Sign in to add a race')) return;
  const f = new FormData(e.target);
  const submitBtn = e.target.querySelector('.primary-button');
  submitBtn.disabled = true;
  let url = f.get('url').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const name = f.get('name').trim();
  try {
    await addRace({
      name,
      date: f.get('date'),
      location: 'Location TBC',
      url,
      events: f
        .get('events')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean),
      eventType: f.get('eventType'),
      clubFocus: f.get('clubFocus') ? 'Y' : 'N',
    });
    e.target.reset();
    applyEventTypeFields(e.target);
    toggleAdd(false);
    await loadRaces();
    // Editing and removing a race both toasted; adding one succeeded
    // silently. Same event, same feedback.
    showToast(`${name} added`);
  } catch (err) {
    showToast('Could not add race: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
$('#editCancelButton').onclick = closeEditScreen;
$('#editBackButton').onclick = closeEditScreen;
$('#raceScreenBackButton').onclick = () => closeRaceScreen();
// Back/forward between the list and a race. Ignored until the first load has
// resolved, because findRaceBySlug has nothing to match against before then.
window.addEventListener('popstate', () => {
  if (bootstrapped) routeFromUrl();
});
$('#removeRaceButton').onclick = async () => {
  const raceId = editingId;
  if (!raceId) return;
  if (!requireSignIn('Sign in to remove this race')) return;
  const race = races.find(r => r.id === raceId);
  if (
    !(await confirmDialog({
      title: 'Remove race?',
      body: `Remove ${race?.name || 'this race'} from the calendar? This can't be undone.`,
    }))
  )
    return;
  const btn = $('#removeRaceButton');
  btn.disabled = true;
  btn.textContent = 'Removing…';
  try {
    await deleteRace(raceId);
    const wasOpen = openId === raceId;
    editingId = null;
    openId = null;
    if (wasOpen) navigate(BASE_PATH, { replace: true });
    $('#editScreen').classList.add('hidden');
    $('#raceScreen').classList.add('hidden');
    $('#top').classList.remove('hidden');
    document.querySelector('.toolbar').classList.remove('hidden');
    $('#raceList').classList.remove('hidden');
    await loadRaces();
    showToast(`${race?.name || 'Race'} removed`);
  } catch (err) {
    showToast('Could not remove race: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Remove race';
  }
};
$('#editForm').addEventListener('submit', async e => {
  e.preventDefault();
  const raceId = editingId;
  if (!raceId) return;
  if (!requireSignIn('Sign in to save these changes')) return;
  const f = new FormData(e.target);
  const submitBtn = e.target.querySelector('.primary-button');
  submitBtn.disabled = true;
  let url = f.get('url').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const name = f.get('name').trim();
  try {
    await updateRace(raceId, {
      name,
      date: f.get('date'),
      url,
      events: f
        .get('events')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean),
      eventType: f.get('eventType'),
      clubFocus: f.get('clubFocus') ? 'Y' : 'N',
    });
    closeEditScreen();
    await loadRaces();
    showToast(`${name} updated`);
  } catch (err) {
    showToast('Could not save changes: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
loadRaces();
$('#authSheetBackdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAuthSheet();
});
$('#authSheetClose').onclick = closeAuthSheet;
// A tap anywhere outside the account menu closes it; Escape inside it is
// handled where the menu is built.
document.addEventListener('click', e => {
  if (!e.target.closest('.account-menu-wrap')) closeAccountMenu();
});
// Escape backs out same as the × button; Tab is trapped inside the sheet so
// a keyboard user can't tab into the page behind what's meant to be modal.
$('#authSheetBackdrop').addEventListener('keydown', e => {
  if ($('#authSheetBackdrop').classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAuthSheet();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = focusableElements($('.auth-sheet'));
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// ---------------------------------------------------------------------------
// App feedback: the "Send feedback" button at the foot of the page opens an
// inline form. Sending goes to the send-feedback Edge Function, which checks
// everything again (origin, a signed form token, honeypot, minimum fill time,
// lengths, hCaptcha, rate limits) and emails the maintainer. The recipient
// address is a server secret: it is never in this file or any request.
//
// Nothing a member types is lost: the draft is kept in sessionStorage as they
// type, so it survives a failed send, a collapse of the panel and a reload,
// and is cleared only once the server says it was sent.
const FEEDBACK_URL = `${SUPABASE_URL}/functions/v1/send-feedback`;
const FEEDBACK_DRAFT_KEY = 'balance-feedback-draft';
// The server refuses a send under 4 seconds after the form token was issued.
// Wait a little longer than that here, so a quick typist never sees it.
const FEEDBACK_MIN_FILL_MS = 4500;
const FEEDBACK_MIN_LENGTH = 5;
const FEEDBACK_MAX_LENGTH = 2000;
const FEEDBACK_ERRORS = {
  too_short: `Write a little more: at least ${FEEDBACK_MIN_LENGTH} characters.`,
  too_long: `That's over ${FEEDBACK_MAX_LENGTH.toLocaleString('en-AU')} characters. Trim it a little and try again.`,
  contact_too_long: 'The name or email is too long. Keep it under 120 characters.',
  too_many_links: 'Please include no more than three links.',
  too_fast: 'That was quick! Give it a second and press Send again.',
  form_expired: 'This form timed out. Press Send again.',
  captcha: "The bot check didn't pass. Please try again.",
  rate_limited: "You've sent a few messages in a short time. Try again in a little while.",
  daily_limit: "We've had a lot of feedback today. Please try again tomorrow.",
  not_configured: "Feedback isn't switched on yet. Please try again later.",
  mail_failed: "We couldn't send it just now. Please try again in a minute.",
  unavailable: "We couldn't send it just now. Please try again in a minute.",
};
const feedback = {
  token: null,
  tokenAt: 0,
  tokenLoading: null,
  sending: false,
};
const feedbackChars = s => Array.from(s).length;

function saveFeedbackDraft() {
  try {
    sessionStorage.setItem(
      FEEDBACK_DRAFT_KEY,
      JSON.stringify({
        message: $('#feedbackMessage').value,
        contact: $('#feedbackContact').value,
      }),
    );
  } catch {
    // Storage full or blocked: the text is still in the form.
  }
}
function restoreFeedbackDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(FEEDBACK_DRAFT_KEY) || 'null');
    if (draft && !$('#feedbackMessage').value && !$('#feedbackContact').value) {
      $('#feedbackMessage').value = typeof draft.message === 'string' ? draft.message : '';
      $('#feedbackContact').value = typeof draft.contact === 'string' ? draft.contact : '';
    }
  } catch {
    clearFeedbackDraft();
  }
}
// Storage can be blocked (private modes, strict settings). A failure to
// forget a draft must never turn a successful send into an error.
function clearFeedbackDraft() {
  try {
    sessionStorage.removeItem(FEEDBACK_DRAFT_KEY);
  } catch {
    // Nothing stored, or nothing we can reach.
  }
}
function updateFeedbackCount() {
  const n = feedbackChars($('#feedbackMessage').value);
  $('#feedbackCount').textContent =
    `${n.toLocaleString('en-AU')} of ${FEEDBACK_MAX_LENGTH.toLocaleString('en-AU')} characters`;
}
function showFeedbackError(message, focusEl) {
  $('#feedbackStatus').textContent = message;
  if (focusEl) {
    focusEl.setAttribute('aria-invalid', 'true');
    focusEl.setAttribute(
      'aria-describedby',
      `${focusEl.id === 'feedbackMessage' ? 'feedbackCount' : 'feedbackContactHint'} feedbackStatus`,
    );
    focusEl.focus();
  }
}
function clearFeedbackError() {
  $('#feedbackStatus').textContent = '';
  for (const el of [$('#feedbackMessage'), $('#feedbackContact')]) {
    el.removeAttribute('aria-invalid');
  }
  $('#feedbackMessage').setAttribute('aria-describedby', 'feedbackCount');
  $('#feedbackContact').setAttribute('aria-describedby', 'feedbackContactHint');
}

// The form token is the server's signed record of when the form opened. It is
// fetched as the panel opens, so the minimum fill time is usually long past
// by the time anyone presses Send. A failure here is retried at send.
async function postFeedback(body) {
  const {
    data: { session },
  } = await db.auth.getSession();
  const res = await fetch(FEEDBACK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      // A signed-in member's own token, so the email says who they are.
      authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  let out = {};
  try {
    out = await res.json();
  } catch {
    out = {};
  }
  return { ok: res.ok, out };
}
function loadFeedbackToken() {
  feedback.tokenLoading ||= postFeedback({ action: 'start' })
    .then(({ ok, out }) => {
      if (!ok || typeof out.form_token !== 'string') throw new Error(out.error || 'no token');
      feedback.token = out.form_token;
      feedback.tokenAt = Date.now();
    })
    .finally(() => {
      feedback.tokenLoading = null;
    });
  return feedback.tokenLoading;
}

function openFeedback() {
  const panel = $('#feedbackPanel');
  $('#feedbackButton').setAttribute('aria-expanded', 'true');
  panel.classList.remove('hidden');
  $('#feedbackForm').classList.remove('hidden');
  $('#feedbackDone').classList.add('hidden');
  restoreFeedbackDraft();
  updateFeedbackCount();
  if (!feedback.token) loadFeedbackToken().catch(() => {});
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('#feedbackMessage').focus({ preventScroll: true });
}
function closeFeedback() {
  // Collapsing keeps whatever was typed, both in the form and in storage.
  $('#feedbackPanel').classList.add('hidden');
  $('#feedbackButton').setAttribute('aria-expanded', 'false');
  $('#feedbackButton').focus();
}
function setFeedbackSending(sending) {
  feedback.sending = sending;
  setBusy($('#feedbackSend'), sending, 'Send', 'Sending…');
  $('#feedbackForm').setAttribute('aria-busy', String(sending));
}

async function sendFeedback() {
  if (feedback.sending) return;
  clearFeedbackError();
  const message = $('#feedbackMessage').value.trim();
  const contact = $('#feedbackContact').value.trim();
  if (feedbackChars(message) < FEEDBACK_MIN_LENGTH) {
    showFeedbackError(FEEDBACK_ERRORS.too_short, $('#feedbackMessage'));
    return;
  }
  if (feedbackChars(message) > FEEDBACK_MAX_LENGTH) {
    showFeedbackError(FEEDBACK_ERRORS.too_long, $('#feedbackMessage'));
    return;
  }
  saveFeedbackDraft();
  setFeedbackSending(true);
  try {
    if (!feedback.token) await loadFeedbackToken();
    const wait = feedback.tokenAt + FEEDBACK_MIN_FILL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const captchaToken = await getCaptchaToken($('#feedbackForm'));
    const { ok, out } = await postFeedback({
      action: 'send',
      form_token: feedback.token,
      captcha_token: captchaToken || '',
      message,
      contact,
      page: location.pathname.slice(0, 200),
      website: $('#feedbackWebsite').value,
    });
    if (ok && out.sent) {
      clearFeedbackDraft();
      $('#feedbackForm').reset();
      updateFeedbackCount();
      $('#feedbackForm').classList.add('hidden');
      $('#feedbackDone').classList.remove('hidden');
      $('#feedbackDoneTitle').focus();
      return;
    }
    if (out.error === 'form_expired') feedback.token = null;
    const focusEl = {
      too_short: $('#feedbackMessage'),
      too_long: $('#feedbackMessage'),
      too_many_links: $('#feedbackMessage'),
      contact_too_long: $('#feedbackContact'),
    }[out.error];
    showFeedbackError(
      (FEEDBACK_ERRORS[out.error] ||
        "We couldn't send it just now. Please try again in a minute.") +
        ' Your message is still here.',
      focusEl,
    );
  } catch (err) {
    // A network failure, or the bot check couldn't load or was closed.
    console.error('send feedback failed:', err);
    feedback.token = null;
    const reason = err?.message?.startsWith('the bot check')
      ? `Couldn't send: ${err.message}`
      : "Couldn't reach the server. Check your connection and try again.";
    showFeedbackError(reason + ' Your message is still here.');
  } finally {
    setFeedbackSending(false);
  }
}

$('#feedbackButton').onclick = () => {
  if ($('#feedbackButton').getAttribute('aria-expanded') === 'true') closeFeedback();
  else openFeedback();
};
$('#feedbackCancel').onclick = closeFeedback;
$('#feedbackDoneClose').onclick = closeFeedback;
$('#feedbackAgain').onclick = () => {
  $('#feedbackDone').classList.add('hidden');
  $('#feedbackForm').classList.remove('hidden');
  feedback.token = null;
  loadFeedbackToken().catch(() => {});
  $('#feedbackMessage').focus();
};
$('#feedbackForm').addEventListener('submit', e => {
  e.preventDefault();
  sendFeedback();
});
$('#feedbackForm').addEventListener('input', () => {
  updateFeedbackCount();
  saveFeedbackDraft();
});
$('#feedbackPanel').addEventListener('keydown', e => {
  if (e.key === 'Escape' && !feedback.sending) {
    e.preventDefault();
    closeFeedback();
  }
});
initAuth();
