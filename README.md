# Balance Tri Club — Race commitment prototype

Open `index.html` in any modern browser. The prototype supports member selection, race filtering, commitments, custom event distances, and adding new races.

## Working on the code

There is **no build step**. GitHub Pages serves the files in this repository exactly as they are, and `index.html` loads `app.js` directly. The tooling below only formats and checks the source in place — it never produces an artefact to deploy.

```sh
npm install      # once
npm run format   # Prettier, writes in place
npm run lint     # ESLint
npm run check    # both, as CI runs them
```

Prettier owns the formatting of `*.html`, `*.css` and `*.js`. Markdown and the SQL migrations are left alone: the prose is hand-wrapped, and Prettier has no SQL parser.

ESLint carries two rules that exist because of specific bugs this codebase shipped:

- `no-unsanitized/property` — flags `innerHTML` written from anything that isn't a literal. The stored XSS in the race roster sat at column 1278 of a 2,500-character line, where no human reading a diff would find it.
- `no-unused-vars` with `caughtErrors: 'all'` — flags a caught error that is bound and then discarded, which is how a Supabase fetch failure became undiagnosable in the field.

`eslint-suppressions.json` is a **baseline, not an exemption**. It records the nine findings that already existed when linting was introduced, so CI is green today while any *new* violation fails. Fixing one of those bugs means deleting its entry — regenerate with `npx eslint --suppress-all .` only when you mean to accept something new, which should be rare.

## Backend

Data is stored in Supabase (project **Balance Tri Club**, `shkfwuogrldbqldpipxd`). `app.js` connects directly with the project's public URL and anon/publishable key — both are safe to expose client-side.

Schema (`public` schema):

- **races** — `id`, `name`, `date`, `location`, `url`, `deleted_at` (timestamptz — set when a race is removed; see *Removing a race* below), `updated_at`, `created_by` / `updated_by` (reference `auth.users`, stamped by the `races_audit_biu` trigger; null for rows predating the change or edited from the dashboard), `slug` (text, unique, not null — see *Shareable race URLs* below), `events` (text array), `event_type` (text — Triathlon, Swim, Bike, Run, Multi-sport, or Balance Bolt), `club_focus` (boolean — set from the "Club focus race" checkbox, except for Balance Bolt races, which the app always saves as `true`; the checkbox is hidden in the form while Balance Bolt is the selected event type), `balance_bolt` (boolean — hides the club commitments/your commitment sections on the race card, since sign-up happens on the separate Balance Bolt site; the app sets this automatically from `event_type === 'Balance Bolt'` rather than exposing a separate form field), `created_at`
- **entries** — `id`, `race_id` (references `races`), `name`, `event`, `level`, `created_at`, `created_by` (references `auth.users`, stamped by the `entries_created_by_biu` trigger; null for rows predating the change or written from the dashboard — see below), unique on `(race_id, name)`
- **profiles** — `id` (references `auth.users`), `display_name`, `justgo_status` (`unverified` / `verified` / `not_found` — reserved for a future JustGo membership check, unused for now), `justgo_member_number`, `justgo_checked_at`, `created_at`

Row Level Security is enabled on all three tables. `races` is **read open, write authenticated** (`races_auth_writes_and_soft_delete` migration): anyone can browse the calendar, but adding, editing or removing a race requires being signed in. Before that change anonymous visitors could delete every race on the calendar, which sat oddly next to the rule that you must sign in to commit to one. Sign-in still isn't tied to ownership — any signed-in member can edit or remove any race, exactly as with entries — so the honour system continues once you're past the door. `entries` holds full names, so only **approved members** may read the table (`first_names_for_visitors` migration, the same `private.is_allow_listed()` gate the writes use). Everyone else, visitors and accounts that are pending, rejected or revoked, sees each roster through `public_entries()`, which cuts every name to its first word on the server ("Sam Lee" becomes "Sam"). A full name never leaves the database for them. "Signed in" alone isn't the bar, because since cutover anyone can make an account in seconds. Insert, update and delete are restricted to the `authenticated` role (`require_auth_for_entries_writes` migration), and to approved members by the allow-list. Sign-in still isn't tied to ownership — any signed-in member can add or edit any entry by typed name, so the honour system continues once you're past the door. `entries.created_by` (`entries_created_by_attribution` migration) records who created each row, the same way `races.created_by` already does, but it's attribution only for now: write access hasn't been narrowed to it. Doing so would protect nothing on the rows that exist today (they'd all have `created_by is null` forever) and would let whoever types a teammate's name in first become that entry's sole future editor — a real cost for a protection that doesn't cover current data. `profiles` is different again: each row is readable and writable only by the signed-in user it belongs to (`auth.uid() = id`).

Write access to `entries` and `races` is further narrowed to an email allow-list (`add_email_allow_list` migration): `private.is_allow_listed()` checks the caller's JWT-verified email against `private.allowed_emails`, which stores only a keyed HMAC hash of each address, never the address itself. The app calls this from `checkMembership()` in `app.js` via `db.rpc('is_allow_listed')`, which hits the client's default (`public`) schema — so a thin `public.is_allow_listed()` wrapper (`expose_is_allow_listed_via_public_wrapper` migration) delegates to the private function; without it every RPC call 404s and `rejectNonMember()` signs every real member back out right after they sign in, which is exactly what happened between `add_email_allow_list` landing and this fix. A signed-in account that isn't allow-listed no longer gets bounced: it waits for approval (or is asked to join), and only a rejected or revoked account is signed out. On a database without `my_access_status()` the old bounce still applies.

`entries_set_created_by()` only re-stamps `created_by` back to its old value when `auth.uid()` is not null, i.e. on a member's own authenticated write (`fix_entries_created_by_set_null_on_user_delete` migration). Applying that write-once rule unconditionally also caught the internal `UPDATE` Postgres runs to enforce `entries.created_by`'s `on delete set null`, silently defeating it: deleting a member's auth account left their entries pointing at the now-nonexistent id forever instead of clearing it.

`public.handle_new_user()` has no `EXECUTE` grant on it at all (`revoke_handle_new_user_execute` migration). It is `SECURITY DEFINER`, and Supabase's linter flagged that `anon` and `authenticated` could call it directly over `/rest/v1/rpc/`. Its only legitimate caller is the `on_auth_user_created` trigger, and that still works: PostgreSQL checks `EXECUTE` on a trigger function when the trigger is *created*, not each time it fires. Don't "fix" a future permission error by granting it back to `supabase_auth_admin` — the trigger does not need it.

### Bot and abuse defences

Four migrations limit what a bot, or one bad member account, can do once past the allow-list:

- **Confirmed email only** (`require_confirmed_email_for_allow_list`). `private.is_allow_listed()` reads the caller's address from `auth.users`, and only when `email_confirmed_at` is set, rather than trusting the JWT's `email` claim. If "Confirm email" were ever switched off in the dashboard, a bot could otherwise sign up with a password as a member who hasn't joined yet and get write access.
- **Size and value limits** (`add_size_and_value_limits`). Check constraints cap name, location, URL and event lengths, force `url` to `http(s)://`, and pin `entries.level` and `races.event_type` to known values. Both lists keep a legacy value existing rows hold (`not`, `SwimRun`). **Adding a level or event type to `app.js` now needs a migration too.** A value past a limit comes back as a raw `violates check constraint` error.
- **Bulk-write guard** (`add_bulk_write_guard`). Statement-level triggers reject any API request (`authenticated` or `anon`) that inserts, updates or deletes more than 5 rows of `entries` or `races` at once. The app only ever writes one row per request. The dashboard and the service role are not limited, so bulk fixes and restores still work there.
- **Change history** (`add_change_history`). Every insert, update and delete on `entries` and `races` is copied to `private.change_history`: the old row, the new row, `auth.uid()` and the time. The app can't read it. To restore entries deleted in the last day, run this in the SQL editor:

  ```sql
  insert into public.entries
  select (jsonb_populate_record(null::public.entries, old_row)).*
    from private.change_history
   where table_name = 'entries' and op = 'DELETE'
     and changed_at > now() - interval '1 day';
  ```

### supabase-js is committed, not loaded from a CDN

`index.html` loads `vendor/supabase-js-2.117.1.js`, a copy of the library's UMD build taken from the npm package, with its licence alongside. It used to load `cdn.jsdelivr.net/npm/@supabase/supabase-js@2`, which floated to whatever 2.x release was newest and carried no integrity check. That script runs with full access to a member's session, so a bad release or a CDN compromise could have acted as every signed-in member. Now an upgrade happens only when someone commits one.

To upgrade:

```sh
npm pack @supabase/supabase-js@<version>   # checks the tarball against the registry's hash
tar xzf supabase-supabase-js-<version>.tgz
cp package/dist/umd/supabase.js vendor/supabase-js-<version>.js
```

Then point the `<script>` tags in `index.html` and `admin.html` at the new file, delete the old one, and check sign-in and saving a commitment still work. `vendor/` is excluded from Prettier and ESLint on purpose, so the file stays byte-for-byte what was published.

If the file ever fails to load, `app.js` and `admin.js` check for `window.supabase` before creating the client and show a "could not load, try refreshing" message instead of a blank page.

## Admin console

`admin.html` is a page for club admins. It shows:

- **Requests** (live since the access-requests migrations went in on 12 October 2026): everyone who has asked to join, with their name, email and note. **Approve** or **Reject** a waiting request; **Remove access** from an approved one; **Approve after all** or **Give access back** for a rejected or removed one. An optional reason is kept for admins only. A request whose Telegram message never went out is marked "Telegram message not sent". The title shows how many are waiting, and so does the calendar's **Admin** link. On a database without those migrations, this panel says "Not set up yet" and the rest of the console works as before.
- **Batch approval** (for cutover, when nearly every member joins at once): tick the waiting requests you've checked, or **Choose all waiting**, then **Approve chosen**. One confirm covers the batch, and it's capped at 50, so a mis-tap can't approve the whole queue. Each request still goes through `admin_decide_request()`, with the same rules and one log row per person. A request that can't be approved, for example an unconfirmed account, is skipped and named with the reason, and the rest still go through. Its migration, `20261012210315_add_batch_approve.sql`, is live (12 October 2026). On a database without it, the button says batch approval isn't set up yet.
- **Club roster hint** (spec A10, a hint and never an approval): **Load club roster** takes any CSV or text file with email addresses in it, such as a JustGo export. Waiting requests whose email is on it get an **On club roster** badge, the bar shows how many match, and **Choose all on roster** ticks just those, up to 50, for **Approve chosen**. You still read each name and note. The file is read in your browser only. It's kept in page memory until you reload, and it's never sent to the database or anywhere else.
- **Stats:** upcoming races, commitments, accounts, accounts not on the allow-list, changes this week, and sign-ups over the last 14 days.
- **Activity:** every change to commitments and races in the last 30 days, and every display-name change, with who made it and what changed. Filter by kind of change or by member. Commitment and race changes have an **Undo** button; a rename doesn't.
- **Removed races,** each with a **Restore** button.
- **Accounts:** everyone who has signed up, whether they're on the allow-list and whether they confirmed their email. This is the quickest way to spot a bot account. Each non-admin account has **Reset password** (see "Password resets"). The temporary password shows once, in a dialog with a Copy button that only **Done** closes; nothing on the page can wipe it first. A request shows when a reset is pending, and marks it once the temporary password has expired.
- **Your password:** set a password for your own account, or change it.
- **Allow-list:** check, add or remove one email address at a time. The list stores only keyed hashes, so it can't be displayed. Add works only for an account that already exists and has confirmed its email (guard G2); new members ask to join and appear under Requests.

Signed-in admins see an **Admin** link in the calendar header.

**Access.** Admins are rows in `private.admins` (`add_admin_console` migration); at launch that's one account. Every action is a `public.admin_*` function that refuses anyone else. Admins also need **two-factor sign-in**: the first visit sets up an authenticator app, and every later sign-in asks for its code. The functions check the session's `aal2` claim, so a stolen inbox alone isn't enough.

- To add an admin, find their user id under Authentication → Users and run `insert into private.admins (user_id) values ('<id>');`.
- To drop the two-factor requirement for one admin: `update private.admins set mfa_required = false where user_id = '<id>';`.
- If an admin loses their authenticator, delete their factor under Authentication → Users → the user → MFA. The console then asks them to set up a new one.

**The page has its own sign-in.** The calendar signs out anyone who isn't on the allow-list, so an admin who isn't listed could never reach the console through it. It asks for email and password first, then the authenticator code. **Email me a code instead** is the fallback, and the way in until you've set a password under **Your password**. The code form uses `shouldCreateUser: false`, so it can't create accounts. Both pages share one session, so if an admin who isn't listed opens the calendar, they're signed out of the console too. The console warns about this and offers to add their address.

**Checking it in a browser.** `node scripts/check-admin-ui.mjs` drives the console in headless Chromium against a stand-in Supabase client: the Requests panel, decisions, password reset, "not set up yet", sign-in and the password card. It skips if Playwright isn't installed, and never talks to the real project.

**Undo is careful.** It only goes ahead if the row is still exactly as that change left it; otherwise it asks you to undo the later change first. Undoing a new race removes it softly, so its roster stays. A restored commitment is credited to the admin who restored it, while the history keeps the original. Every admin action is logged in `private.admin_actions`.

## Removing a race

Removing a race is a **soft delete**: `deleted_at` is stamped and the row stays. A race carries its roster, so a hard delete would destroy other people's commitments as well. `app.js` never issues a `DELETE` against `races`, and there is no delete policy on the table.

Two consequences worth knowing:

- **Restoring a race is a deliberate act** in the dashboard or via the service role (`update races set deleted_at = null`). The update policy only matches live rows, so the app itself cannot bring one back.
- **The select policy is split by role on purpose.** Anonymous visitors see live races only; signed-in members can read every row. A single `using (deleted_at is null)` policy looks correct and silently makes the soft delete impossible — on `UPDATE`, Postgres checks the *new* row against the SELECT policies too, so the statement that sets `deleted_at` produces a row the updater may no longer see and is rejected. `loadRaces` therefore filters `deleted_at` itself, so a removed race doesn't reappear just because you signed in.

The unique index on `slug` is partial (`where deleted_at is null`), so removing a race frees its slug. Without that, re-adding the same race next season would silently become `berlin-marathon-2026-2`. The `races_assign_slug` de-duplication also skips removed races, stated explicitly rather than left resting on the select policy.

## Sign-in

Members join with an email address and a password, then wait for the club admin to approve them. Nothing is emailed to a member, and the app has no email-code or magic-link sign-in for them. `admin.html` keeps an email code as the owner's own fallback. This is the flow after cutover (step B9), when "Confirm email" goes off; the database side is under *Access requests* below.

**Joining.** The sheet's **Join** form (`openJoinForm` in `app.js`) takes email, password, confirm password, display name and an optional note, and calls `signUp` then the `request_access()` function. The address is trimmed and lower-cased, and shown back before submit, because nothing is emailed and a typo can't be caught later. If `signUp` works but `request_access()` doesn't (usually a name clash), the person stays signed in and sees the name step again (`openNameStep`); the account sits in state `none` until they fix it. An address that already has an account gets "There's already an account for this email…". That reveals the address has an account, which the spec accepts; hCaptcha and the sign-in rate limit slow anyone probing.

**Passwords.** 12 to 72 characters, no composition rules, paste allowed, with a show/hide toggle. The top end is checked in bytes, as bcrypt keeps only 72, so accented letters and emoji use up more of it. A new password is also checked against `assets/common-passwords.txt`, because the leaked-password check is a Supabase Pro feature. The file holds the 10,000 most common entries of 12 to 72 characters from SecLists' `xato-net-10-million-passwords-1000000.txt` (MIT licence), lower-cased and compared ignoring case. `scripts/build-common-passwords.sh` rebuilds it from a pinned SecLists commit and refuses a download whose sha256 differs; the file's header records the source, commit and licence. Bump the `?v=` on its fetch in `app.js` when it changes. The file loads the first time a new password is checked, and if it can't load the form refuses to go on rather than skip the check. The database stays the authority on length and on names; the app only answers sooner. Passwords are sent to Supabase Auth and nowhere else, and are never logged or stored by the app.

**Signing in.** `signInWithPassword`, with the hCaptcha token. There is no "email me a reset link": the sheet says "Forgot your password? Ask the club admin to reset it." with the club's email address. The admin resets from the console (see *Password resets*), and the member signs in with the temporary password.

**What a signed-in account sees** is decided by `my_access_status()` (`reactToAccess` and `renderMemberBanner` in `app.js`):

- `approved` — today's experience.
- `pending` — a banner ("Thanks, Sam. Your account is waiting for the club admin to approve it…"), and the write buttons are disabled with the same text as their hint. They can still browse.
- `none` — the display name and note step opens, and the banner's **Ask to join** button brings it back.
- `rejected` or `revoked` — a message, then signed out.
- A reset password (`password_change_due`) — a **Set a new password** step that can't be closed; the only other choice is to sign out. Saving calls `updateUser`, then `password_changed()`. If the second call fails after the first worked, Save only retries the second, since Supabase refuses to set the same password twice. The device also remembers it (`balance-pwchanged-<user id>` in `localStorage`) and retries on the next load, before asking for another password. A reset older than 7 days (`reset_expired`) signs the person out with "This temporary password has expired…" instead (R6, enforced by the app only in phase 1).
- Older accounts that signed in by emailed code are shown "Set a password so you can sign in without an email code." once (E1). The app marks an account that has a password with `has_password` in its user metadata (set on join, in this step and in Change password), and remembers on the device that the prompt was shown (`localStorage`, `balance-password-prompt-<user id>`). So the prompt can come back on another device, and not at all on this one after **Not now** or a successful save. Closing it any other way, or a failed save, lets it come back on the next load. If Supabase asks for a recent sign-in (`reauthentication_needed`), the prompt says to stay signed in and ask the admin for a temporary password; it never says to sign out, because an account with no password couldn't get back in. Only **Change password** on an account that has a password gives the sign-out-and-in advice.
- **Change password** is in the header's Account menu, along with Sign out. It uses `updateUser`; with Supabase's "Secure password change" on, an old session is asked to sign in again first.

**Refused writes.** When a save is refused (a row-level-security error, or zero rows), the app re-reads the member's standing, so someone whose access was removed while the page was open is told so and signed out at once. While the auth sheet is open the page behind it is `inert`.

**Before cutover and missing functions.** The allow-list (`is_allow_listed()`) is still the only thing the write buttons look at. `my_access_status()` only decides what the member is told. If it doesn't exist (PGRST202) an approved member is untouched, and a non-member is signed out with the old "members only" message. If it fails for another reason nobody is signed out; the old banner shows and the write buttons stay off.

**Sign-in sheet.** Every entry point (the header button, the nudge, and the write gate) opens the one bottom sheet, with a focus trap and an `aria-label` that follows the step. Browsing is always open: the calendar and every race's roster are visible whether or not you're signed in. Saving, editing or removing a commitment is not: a signed-out attempt opens the sheet (`requireSignIn` in `app.js`).

Separately, a **nudge** appears once per visit for a signed-out browser (unless snoozed), offering "Sign In", "Join" or "View Calendar" with equal weight. Tapping outside it or "View Calendar" dismisses it the same way, since it never blocks anything. (An earlier version also dismissed it on any page scroll; that closed the sheet the moment a phone's keyboard opened, since focusing an input inside a fixed-position sheet makes mobile browsers scroll the document, so scroll-to-dismiss was removed.) Checking "Don't ask me to sign in again for 10 days" snoozes it for 10 days (tracked client-side in `localStorage` as `authDismissedUntil`, not in Supabase). The small sign-in control in the header stays available regardless, on mobile included.

**Tests.** `node scripts/check-app-ui.mjs` drives `index.html` in headless Chromium against a stand-in Supabase client (it skips when Playwright isn't installed, and never reaches the real project). It covers joining, a duplicate address, short and common passwords, a name clash and the fix, each account state, the forced and expired reset, the one-time prompt, password sign-in and the missing-function cases. Run it the way `scripts/check-admin-ui.mjs` is run.

### Bot check (hCaptcha)

Anyone can make an account or try a password, and Supabase has no lock-out per account, so a script could guess passwords or fill the project with sign-ups. The allow-list can't stop that: it only controls writes. hCaptcha makes each join and sign-in prove it came from a browser, and Supabase's per-IP rate limit (Authentication → Rate Limits) covers the rest.

It's off until a site key is set. With `HCAPTCHA_SITE_KEY` empty in `shared.js`, sign-in works exactly as before. With a key, pressing **Join** or **Sign in** loads hCaptcha's script (browsing never loads it), gets a single-use token via an invisible widget (`size: 'invisible'`, triggered with `execute()`), and passes it to `signUp` or `signInWithPassword` as `captchaToken`. hCaptcha only surfaces a visible challenge when it decides one is needed — most members never see anything.

**Switching it on — in this order:**

1. In the [hCaptcha dashboard](https://dashboard.hcaptcha.com/), add a site for `jthoyer.github.io`. Copy the **site key** and the **secret key**.
2. Put the site key in `HCAPTCHA_SITE_KEY` in `shared.js` and deploy. Both the calendar and the admin console read it from there. Sign-in still works, because Supabase ignores a token it isn't checking.
3. In Supabase, go to **Authentication → Attack Protection**, enable CAPTCHA protection, choose hCaptcha, paste the **secret key** and save.

Doing step 3 before step 2 breaks sign-in for everyone: once CAPTCHA protection is on, every join and sign-in without a token is refused. To switch it off, reverse the order: turn it off in Supabase first, then clear the key.

(An earlier version of this used Cloudflare Turnstile; it was replaced with hCaptcha before Turnstile's site key was ever set, so no live sign-in flow depended on it.)

### Sign-in emails

Members get no sign-in email once the password flow is live (see *Sign-in*), so these templates now matter for one thing: the email code that `admin.html` keeps as the owner's fallback. They were written for the old member flow, when the sign-in email was the whole funnel, and are branded rather than left on Supabase's default. Two templates live in `supabase/templates/`:

- `confirmation.html` — what a brand-new email address gets ("Confirm your email"). This is the first impression, so the copy says what the calendar is before it asks for a tap.
- `magic_link.html` — what an address that has signed in before gets.

With the old flow the app made one `signInWithOtp()` call and Supabase picked the template by whether the address was new. The console's fallback sends to an existing account, so only `magic_link.html` is used now.

Both carry the link (`{{ .ConfirmationURL }}`) and the code (`{{ .Token }}`), side by side and with similar weight — the code is the way out of the in-app-browser trap above, not a curiosity.

They're styled to match the app (`styles.css`): the `#f7f8fa` canvas, a white card with a `#d9dfe8` hairline and 9px corners, `#182542` headings, `#566177` body, the app's yellow primary button, and `#116b43` for links and the accent word. They're table-based HTML with every style inline, because email clients strip `<style>` blocks and external CSS — keep it that way when editing. Each carries a hidden **preheader**: the grey preview line the inbox shows next to the subject, which is the second thing a member reads and a bigger lever on opens than anything in the body.

**Two places, one source.** `[auth.email.template.*]` in `supabase/config.toml` points at these files, but that only drives a local `supabase start` stack. The hosted project reads its templates from the dashboard, so after editing a file here, paste it into [Authentication → Emails](https://supabase.com/dashboard/project/shkfwuogrldbqldpipxd/auth/templates) (subject line included) or the two drift apart.

The logo is loaded from the live site (`https://jthoyer.github.io/BalanceTRI-app/assets/balance-logo.png`) rather than embedded, so it only appears once a member allows images — which most clients don't by default. Everything the email needs to work is text, and the `alt` carries the club name when the image is blocked.

**The sender still says Supabase.** Emails go out as `Supabase Auth <noreply@mail.app.supabase.io>`, which no member recognises and which spam filters treat accordingly — and the shared sender is capped at a handful of emails per hour, so a club-wide push would silently hit the limit. The template can't fix any of that. Configuring custom SMTP (Resend, Postmark, SendGrid) under Authentication → Settings, with a verified `balancetriclub.com.au` sender and SPF/DKIM records, is the single biggest remaining lever on sign-in rates.

### Keeping the free project awake

Supabase pauses free projects after 7 days without activity, and a paused project takes the whole app down. `.github/workflows/keep-alive.yml` reads one row from `races` every three days, which counts as activity. It uses only the public URL and key, so it needs no secrets. Run it by hand from the Actions tab to test it.

Two limits to know about:

- GitHub switches off scheduled workflows after 60 days without repository activity. Any commit re-enables it, but check the Actions tab now and then.
- This is a workaround, not a Supabase guarantee. Upgrading to Pro removes the pausing, and adds backups.

If the project is already paused, restore it from the dashboard first. The ping can't wake it.

Use **Refresh** to reload the latest data from Supabase.

## Shareable race URLs

Every race has its own address: `<site-base>/race/<slug>`, e.g.
<https://jthoyer.github.io/BalanceTRI-app/race/berlin-marathon-2026>. Opening
that link goes straight to the race's detail screen; opening a race from the
list updates the address bar to match, and browser back/forward move between
the list and a race.

**Slugs are generated in the database, not in the app.** The
`races_slug_biu` trigger derives `slug` from the race name plus the year of its
date (`Berlin Marathon` + 2026 → `berlin-marathon-2026`), prefixes Balance Bolt
races (which are named by number) with `balance-bolt-`, and appends `-2`, `-3`…
on a collision. Nobody types a slug. `app.js` never writes the column — it only
reads it — so `addRace`/`updateRace` need no slug handling and an older cached
copy of the app keeps working.

Renaming a race, or changing its date, regenerates the slug and therefore
**breaks links already shared for that race**. Unrelated edits (URL, events,
club-focus flag) leave the slug alone. A slug can also be set by hand in SQL,
in which case the trigger normalises it but does not overwrite it.

**GitHub Pages has no server-side rewrites**, so a cold hit on `/race/<slug>`
is served by `404.html`, which bounces to `index.html` as `<base>?/race/<slug>`;
a small script at the top of `index.html`'s `<head>` restores the real path
before `app.js` routes on it. `404.html` redirects **only** paths matching
`/race/<slug>` — a missing stylesheet, image or typo'd path still 404s
normally. Neither file hardcodes the repository name: the base is taken from
whatever precedes `/race/`, so this also works if the site ever moves to a
custom domain at the root.

A slug that matches no race falls back to the race list with an explanatory
banner, and rewrites the URL so the dead link isn't re-shared. If Supabase is
unreachable the URL is left untouched, since an unmatched slug can't be
distinguished from an unloaded one.

## Access-request alerts

`supabase/functions/notify-access-request/` is an Edge Function that sends the club admin one Telegram message when someone asks to join: the person's display name and a link to the admin console, nothing more. It is step B4 of the gated member accounts plan. Nothing in this section is live until the owner says go.

**How it works.**

1. An `AFTER INSERT` trigger on `private.access_requests` posts the new row's `user_id` to the function through `pg_net`, for pending rows only. It sends nothing else, plus a shared secret in the `x-notify-secret` header. It fires on the request row, not on a raw `auth.users` signup, so a half-finished sign-up never pings the admin.
2. The function calls `public.notifier_claim(user_id)`. The database checks the request is still `pending`, has not been announced, and that fewer than 20 requests were announced today (Sydney time). If so it stamps `notified_at` and returns the display name.
3. The function builds the text itself, from fixed wording and the name the database returned. It never uses text from the caller. It sends it as plain text, with link previews off, to a fixed chat.
4. If Telegram refuses, the function calls `public.notifier_release(user_id)`, which clears `notified_at`. The console then shows "notification not sent" for that request. The 20th message of the day ends with "Daily limit reached. Check the console for more.", and the 21st sends nothing.

**Why it is not an open relay.** No shared secret, no work, and the anon key proves nothing. The chat ID comes from a secret, never from the request. The name comes from the database, never from the request body. The claim and release functions are callable by `service_role` only. The trigger never blocks a sign-up: if `pg_net` or Vault fails, the request is still saved, and the console's pending count is the backstop. The token is never logged.

**It depends on B3.** The migration `20261012050607_add_access_request_notifier.sql` expects `private.access_requests` with `user_id`, `display_name`, `status` and `notified_at` (spec section 6.1). **It is live** (applied and deployed 12 October 2026), and the file carries the version Supabase recorded. What's left is the owner's: the secrets (steps 1 and 2 below) and the test request (step 5).

**Switching it on — in this order, each step with the owner's go:**

1. Set the Edge Function secrets (dashboard → Edge Functions → Secrets). They never go in the repo or in chat:
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID`, from BotFather (step B1).
   - `NOTIFY_SHARED_SECRET`, a long random string.
   - `ADMIN_CONSOLE_URL`, optional. Defaults to `https://jthoyer.github.io/BalanceTRI-app/admin.html#requests`.
2. Create the matching Vault secret in the SQL editor, never in a migration file. The value is the same string as `NOTIFY_SHARED_SECRET`:
   `select vault.create_secret('<the same string>', 'notify_access_request_secret');`
3. ~~Apply the notifier migration.~~ Done 12 October 2026. It switched on `pg_net`.
4. ~~Deploy: `supabase functions deploy notify-access-request`.~~ Done 12 October 2026. `config.toml` sets `verify_jwt = false`, because the caller is a database trigger, not a signed-in user. With no secrets set, it answers "not configured" and sends nothing.
5. Make a test request. Exactly one message arrives, with the display name and the console link, and no email address.

Until step 2 is done the trigger stays silent. Until the function is deployed, a request still saves, and the console shows it as not announced.

**Tests.** Two sets, neither needs Deno or the live project:

```
node --experimental-strip-types --test supabase/functions/notify-access-request/handler.test.ts

sed '/^create extension/d' supabase/migrations/20261012050607_add_access_request_notifier.sql > /tmp/notifier_migration.sql
psql -v ON_ERROR_STOP=1 -v migration=/tmp/notifier_migration.sql -d <scratch db> \
     -f supabase/functions/notify-access-request/notifier.test.sql
```

The first set covers the secret check (T7), what the caller can and cannot influence, the daily-limit message (T8), and Telegram failures. The second runs against a throwaway Postgres with stand-ins for Supabase and B3. It covers the trigger, the claim and release rules, the daily cap of 20 across the Sydney day, and who may call what.

## Access requests (gated member accounts)

The B3 migrations are the database side of "sign up with email, password and display name, then wait for the club admin". **They are live** (applied 12 October 2026). The connector timed out on the whole file, so B3 went in as eight parts, `20261012042054_add_access_requests_1_tables.sql` to `20261012045350_add_access_requests_8_allow_list_remove.sql`, one file each, named after the version Supabase recorded. The design notes are at the top of part 1. They are safe with "Confirm email" still on: they only add.

**The allow-list stays the only gate.** The RLS policies on `entries` and `races` still check `private.is_allow_listed()` and nothing else. `private.access_requests` is the workflow and the record; it never grants anything by itself. `admin_decide_request()` moves the two together in one transaction. A write stops the moment an address leaves the allow-list, because the policies check it on every write.

**Tables** (`private`, so invisible to the API; RLS on, no policies, every grant revoked):

- `access_requests` — one row per person (the primary key on `user_id`): display name, note, status (`pending`, `approved`, `rejected`, `revoked`), who decided and when, an admin-only reason, and `notified_at` (set by the notifier below).
- `password_resets` — the "must change password" flag and its 7-day expiry. Written by the admin reset function (B5); cleared by `password_changed()`. In phase 1 the app enforces the expiry, not the server.

**Member functions** (signed-in only; each acts on the caller and takes no user id):

- `my_access_status()` — `none`, `pending`, `approved`, `rejected` or `revoked`, plus whether a password change is due. Anyone on the allow-list is `approved` with or without a request row, so existing members need no backfill.
- `request_access(name, note)` — once per account, only if not listed. Writes `profiles.display_name` and a `pending` row. Errors are worded for the member.
- `password_changed()` — clears the caller's reset flag.

**Admin functions** (admins with a two-factor session; every decision is logged in `private.admin_actions` as `access_approve`, `access_reject`, `access_revoke` or `access_reapprove`): `admin_requests(status)`, `admin_decide_request(user, decision, reason)` and `admin_pending_count()`. Transitions: approve and reject act on `pending`; revoke on `approved`; reapprove on `revoked` or `rejected`. An admin can't decide on their own account.

**Display names.** 2 to 40 characters; letters in any language, spaces, apostrophes, hyphens and full stops; at least one letter. Names are stored in Unicode NFC form, so "Zoë" typed two different ways is one name. Names are unique among pending and approved people, ignoring case, because `entries` is unique on `(race_id, name)` and two "Sam"s would collide on a race. A member who joined before requests existed counts if their address is on the allow-list. Approving or reapproving re-checks the name, in case such a member has taken it since. Letter matching uses `[[:alpha:]]`, which needs a UTF-8 database; the live project's is `en_US.UTF-8` and was checked. Look-alike letters from other scripts (a Cyrillic "а" for a Latin "a") are not caught.

**Renames.** The same rules apply when a member renames their own profile (a `BEFORE UPDATE` trigger). A pending member's request follows the rename, so the name guard covers the new name and frees the old one. Each rename is logged in `private.change_history` and shows in the console's activity feed as "Renamed A to B", with no Undo. Renames are capped at 5 a day per member, because each one writes a history row and an uncapped loop could fill the database; the dashboard and the service role are not capped. Choosing a name in `request_access()` replaces the seeded one (the email's local part) and is not counted or logged as a rename. Invisible marks such as U+034F are stripped, so they can't make a copy of a taken name.

**Re-approving an existing member can need a rename first.** When a member who joined before requests existed loses their listing, they get a `revoked` row named after their profile (or "Member" if that is too short). Profile names were never unique, so reapproving can be refused with "Another member now uses that name". Rename the profile in the dashboard to a valid, unused name, then reapprove. The same goes for adding such an account through the Allow-list box.

**Guards for "Confirm email" off.** With confirmation off, an address proves nothing, so a hash left on the allow-list is a pre-approval anyone can claim by signing up with that address.

- **G2.** `admin_allow_list_add()` refuses an address with no account ("No account uses that address."), and an account that hasn't confirmed its email. Listing an address also approves its request, and `admin_allow_list_remove()` revokes it, so the Requests panel and the list never disagree. A member who joined before requests existed and is removed gets a `revoked` row, so they see "access removed" rather than the join form.
- **G3.** Triggers on `auth.users`: deleting an account removes its hash; changing its email removes the old hash and sets the request to `revoked` (or makes a `revoked` row for an existing member) so the owner approves the new address. A change of letter case alone is the same address and is ignored. These fail closed: if the Vault key is missing, the delete or email change is refused.
- **One change per account at a time.** Admin decisions, `request_access()` and the G3 triggers all take a per-account advisory lock first (`private.lock_account`); a deletion takes it in a `BEFORE DELETE` trigger, so it is held before the cascade touches the request row. Without it, an approval and an email change landing together could leave the old address listed with no account behind it. The lock order is the same everywhere, so these wait for each other rather than deadlock; that part is reasoned, not tested, because the window can't be forced in a test.
- **G1 is not in the migration.** It is a one-off for cutover (B9) and must run immediately before "Confirm email" goes off. It deletes every hash that has no **confirmed** account, and **cannot be undone**: the deleted hashes were never readable. Unconfirmed accounts don't count, because anyone can create one on any address while confirmation is on and confirm it later by signing up again.

  ```sql
  delete from private.allowed_emails
   where email_hash not in (
     select private.email_hash(email) from auth.users
      where email is not null and email_confirmed_at is not null
   );
  ```

  Straight after G1, delete the accounts that are still unconfirmed. None of them can be listed by then, and one sitting on a member's address would stop that member joining:

  ```sql
  delete from auth.users where email_confirmed_at is null;
  ```

**Profiles.** Members could edit every column of their own `profiles` row, including `justgo_status`. They can now change `display_name` and nothing else (a table-wide `UPDATE` grant was replaced with a column grant; revoking only the `justgo_*` columns would have done nothing).

**SQL tests.** `supabase/tests/run.sh` replays every migration on a scratch Postgres, with stand-ins for `auth`, `vault` and `pg_net` in `stubs.sql`, then runs each `*.test.sql`. It never touches a real project.

```
PGHOST=/tmp/pgtest PGUSER=nobody supabase/tests/run.sh
```

It needs a running Postgres 16 or newer with `pgcrypto`, and a user who can create databases and roles (the scratch `service_role` is made with `BYPASSRLS`, as on Supabase). `b3_access_requests.test.sql` covers spec tests T1 to T6 and T10, the request state machine, the name rules and the profile changes. `b3_review_fixes.test.sql` covers the fixes from the code and security reviews. `b3_b4_notifier.test.sql` checks that a real `request_access()` call fires the notifier trigger. `races.sh` runs two sessions at once to show the per-account lock holds when an approval and an email change collide.

## Password resets

Members get no email, so Supabase's own "reset password" email isn't used. The owner resets a password from the console instead (step B5). **Not deployed or applied yet.**

1. The console's **Reset password** button calls the Edge Function `admin-reset-password` with the owner's own session.
2. The function calls `public.admin_password_reset_begin(user_id)` **as the owner**, so the usual admin check decides: an admin, signed in with two-factor. Anyone else gets 401 or 403, and nothing changes.
3. That function flags "must change password" in `private.password_resets` for 7 days, signs the member out on every device (it deletes their sessions and refresh tokens), and logs `password_reset` in `private.admin_actions`.
4. The Edge Function makes a temporary password (four random words and two digits, such as `maple-river-swift-cloud-47`) and sets it with the service role through the Auth admin API.
5. It calls `admin_password_reset_finish()`, again as the owner, which signs the member out once more. The old password worked until step 4, so a session opened in between must not survive the reset.
6. It returns the password once. It is never stored, logged or emailed. The owner passes it on by text or in person. If the second sign-out failed, the reply says `signed_out: false`, and the console should say so.

Before any of this, the function checks with Auth that the owner's own session is still live. A stolen admin token whose session was revoked does nothing.

The owner can't reset their own password this way, nor another admin's: admins use Change password or the dashboard.

**Signed out, but not instantly everywhere.** Deleting a member's sessions and refresh tokens stops every device renewing its access token. A token already issued keeps working until it expires, because the database checks its signature and expiry, not whether its session still exists. That is up to `jwt_expiry` (an hour by default). Shortening `jwt_expiry` in the dashboard narrows the window.

When the member signs in with it, the app sends them straight to "Set a new password" (B7), and `password_changed()` clears the flag. The 7-day expiry is enforced by the app in phase 1, not the server (spec R6).

If setting the password fails after step 3, the function undoes the reset (`admin_password_reset_abort()`): the flag goes, and the log records `password_reset_failed`. The member stays signed out, and their old password still works. The owner sees an error and can try again.

**Strength.** Four words from a list of 407 and two digits give about 41 bits, in about 28 characters. The list has no US spellings and no words that sound like others when read out, since R4 lets the owner pass the password on in person. That's enough for a one-time password that the member replaces at once, behind Supabase's sign-in rate limit and hCaptcha. The words are in `supabase/functions/admin-reset-password/words.ts`.

**Calling it from a browser.** Only `https://jthoyer.github.io` gets CORS headers (`ADMIN_ORIGIN` overrides it). `config.toml` keeps `verify_jwt = true`. The function needs only the settings Supabase provides (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).

**It is live** (12 October 2026): migration `20261012205858_add_admin_password_reset.sql` is applied, and `admin-reset-password` is deployed with `verify_jwt = true`. The console's **Reset password** button (B6) works for any non-admin account.

**Tests.** `node --experimental-strip-types --test supabase/functions/admin-reset-password/handler.test.ts` covers the Edge half of spec test T9. `supabase/tests/b5_password_reset.test.sql` (run by `supabase/tests/run.sh`) covers the database half: who may begin a reset, signing out everywhere, the flag and the log.
