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

Row Level Security is enabled on all three tables. `races` is **read open, write authenticated** (`races_auth_writes_and_soft_delete` migration): anyone can browse the calendar, but adding, editing or removing a race requires being signed in. Before that change anonymous visitors could delete every race on the calendar, which sat oddly next to the rule that you must sign in to commit to one. Sign-in still isn't tied to ownership — any signed-in member can edit or remove any race, exactly as with entries — so the honour system continues once you're past the door. `entries` allows anonymous **read** the same way — every roster stays visible to anyone — but insert/update/delete are restricted to the `authenticated` role (`require_auth_for_entries_writes` migration): saving, editing or removing a commitment requires being signed in. Sign-in still isn't tied to ownership — any signed-in member can add or edit any entry by typed name, so the honour system continues once you're past the door. `entries.created_by` (`entries_created_by_attribution` migration) records who created each row, the same way `races.created_by` already does, but it's attribution only for now: write access hasn't been narrowed to it. Doing so would protect nothing on the rows that exist today (they'd all have `created_by is null` forever) and would let whoever types a teammate's name in first become that entry's sole future editor — a real cost for a protection that doesn't cover current data. `profiles` is different again: each row is readable and writable only by the signed-in user it belongs to (`auth.uid() = id`).

Write access to `entries` and `races` is further narrowed to an email allow-list (`add_email_allow_list` migration): `private.is_allow_listed()` checks the caller's JWT-verified email against `private.allowed_emails`, which stores only a keyed HMAC hash of each address, never the address itself. The app calls this from `checkMembership()` in `app.js` via `db.rpc('is_allow_listed')`, which hits the client's default (`public`) schema — so a thin `public.is_allow_listed()` wrapper (`expose_is_allow_listed_via_public_wrapper` migration) delegates to the private function; without it every RPC call 404s and `rejectNonMember()` signs every real member back out right after they sign in, which is exactly what happened between `add_email_allow_list` landing and this fix. A signed-in member who isn't allow-listed gets bounced the same way, by design.

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

- **Stats:** upcoming races, commitments, accounts, accounts not on the allow-list, changes this week, and sign-ups over the last 14 days.
- **Activity:** every change to commitments and races in the last 30 days, who made it, and what changed. Each one has an **Undo** button.
- **Removed races,** each with a **Restore** button.
- **Accounts:** everyone who has signed up, whether they're on the allow-list and whether they confirmed their email. This is the quickest way to spot a bot account.
- **Allow-list:** check, add or remove one email address at a time. The list stores only keyed hashes, so it can't be displayed.

Signed-in admins see an **Admin** link in the calendar header.

**Access.** Admins are rows in `private.admins` (`add_admin_console` migration); at launch that's one account. Every action is a `public.admin_*` function that refuses anyone else. Admins also need **two-factor sign-in**: the first visit sets up an authenticator app, and every later sign-in asks for its code. The functions check the session's `aal2` claim, so a stolen inbox alone isn't enough.

- To add an admin, find their user id under Authentication → Users and run `insert into private.admins (user_id) values ('<id>');`.
- To drop the two-factor requirement for one admin: `update private.admins set mfa_required = false where user_id = '<id>';`.
- If an admin loses their authenticator, delete their factor under Authentication → Users → the user → MFA. The console then asks them to set up a new one.

**The page has its own sign-in.** The calendar signs out anyone who isn't on the allow-list, so an admin who isn't listed could never reach the console through it. The admin form uses `shouldCreateUser: false`, so it can't create accounts. Both pages share one session, so if an admin who isn't listed opens the calendar, they're signed out of the console too. The console warns about this and offers to add their address.

**Undo is careful.** It only goes ahead if the row is still exactly as that change left it; otherwise it asks you to undo the later change first. Undoing a new race removes it softly, so its roster stays. A restored commitment is credited to the admin who restored it, while the history keeps the original. Every admin action is logged in `private.admin_actions`.

## Removing a race

Removing a race is a **soft delete**: `deleted_at` is stamped and the row stays. A race carries its roster, so a hard delete would destroy other people's commitments as well. `app.js` never issues a `DELETE` against `races`, and there is no delete policy on the table.

Two consequences worth knowing:

- **Restoring a race is a deliberate act** in the dashboard or via the service role (`update races set deleted_at = null`). The update policy only matches live rows, so the app itself cannot bring one back.
- **The select policy is split by role on purpose.** Anonymous visitors see live races only; signed-in members can read every row. A single `using (deleted_at is null)` policy looks correct and silently makes the soft delete impossible — on `UPDATE`, Postgres checks the *new* row against the SELECT policies too, so the statement that sets `deleted_at` produces a row the updater may no longer see and is rejected. `loadRaces` therefore filters `deleted_at` itself, so a removed race doesn't reappear just because you signed in.

The unique index on `slug` is partial (`where deleted_at is null`), so removing a race frees its slug. Without that, re-adding the same race next season would silently become `berlin-marathon-2026-2`. The `races_assign_slug` de-duplication also skips removed races, stated explicitly rather than left resting on the select policy.

## Sign-in

`app.js` uses Supabase Auth's email magic-link flow (`signInWithOtp`): entering an email sends a link, and opening it signs the browser in. The same email also carries a **6-digit code**, and the sheet shows a box for it (`showCodeStep` in `app.js`, calling `verifyOtp` with `type: 'email'`, which covers both a brand-new address and a returning one). The code is there because of the usual way a magic link fails on a phone: tapping the link inside the Gmail or Outlook app opens an in-app browser, which signs *that* browser in and leaves the tab the member started in signed out. Typing the code signs them in where they already are. Supabase issues one token per request, so the link and the code are the same credential — using either retires the other. The `handle_new_user` trigger (in the `add_profiles_table` migration) creates a matching `profiles` row the first time someone signs in, seeding `display_name` from the email's local part. Once signed in, that `display_name` fills the "Your name" field automatically (but never overwrites a name already typed in this browser).

Browsing is always open — the calendar and every race's roster are visible whether or not you're signed in. Saving, editing or removing a commitment is not: a signed-out attempt opens a bottom sheet asking you to sign in first (`requireSignIn` in `app.js`), and the click that started it resumes once you are.

Separately, a bottom-sheet **nudge** appears once per visit for a signed-out browser (unless snoozed), offering "Sign in" or "Just browsing" with equal weight — tapping outside it or "Just browsing" both dismiss it the same way, since it never blocks anything. (An earlier version also dismissed it on any page scroll; that closed the sheet the moment a phone's keyboard opened for the email field, since focusing an input inside a fixed-position sheet makes mobile browsers scroll the document to keep it in view — so scroll-to-dismiss was removed.) Checking "Don't ask me to sign in again for 10 days" before dismissing snoozes the nudge for 10 days (tracked client-side in `localStorage` as `authDismissedUntil`, not in Supabase); leaving it unchecked just dismisses it for the current visit. The small sign-in control in the header stays available regardless, on mobile included.

### Bot check (hCaptcha)

Anyone can ask Supabase to send a sign-in email to any address, and the allow-list can't stop that: it only controls writes. A script could burn through the project's email quota and lock real members out of sign-in. hCaptcha makes each send prove it came from a browser.

It's off until a site key is set. With `HCAPTCHA_SITE_KEY` empty in `shared.js`, sign-in works exactly as before. With a key, pressing **Send link** loads hCaptcha's script (browsing never loads it), gets a single-use token via an invisible widget (`size: 'invisible'`, triggered with `execute()`), and passes it to `signInWithOtp` as `captchaToken`. hCaptcha only surfaces a visible challenge when it decides one is needed — most members never see anything.

**Switching it on — in this order:**

1. In the [hCaptcha dashboard](https://dashboard.hcaptcha.com/), add a site for `jthoyer.github.io`. Copy the **site key** and the **secret key**.
2. Put the site key in `HCAPTCHA_SITE_KEY` in `shared.js` and deploy. Both the calendar and the admin console read it from there. Sign-in still works, because Supabase ignores a token it isn't checking.
3. In Supabase, go to **Authentication → Attack Protection**, enable CAPTCHA protection, choose hCaptcha, paste the **secret key** and save.

Doing step 3 before step 2 breaks sign-in for everyone: once CAPTCHA protection is on, every send without a token is refused. To switch it off, reverse the order: turn it off in Supabase first, then clear the key.

(An earlier version of this used Cloudflare Turnstile; it was replaced with hCaptcha before Turnstile's site key was ever set, so no live sign-in flow depended on it.)

### Sign-in emails

The sign-in email is the whole funnel — nobody who doesn't open it ever signs in — so it's branded rather than left on Supabase's default. Two templates live in `supabase/templates/`:

- `confirmation.html` — what a brand-new email address gets ("Confirm your email"). This is the first impression, so the copy says what the calendar is before it asks for a tap.
- `magic_link.html` — what an address that has signed in before gets.

The app makes one `signInWithOtp()` call; Supabase picks the template based on whether the address is new. Both need to be branded or half the members see the default.

Both carry the link (`{{ .ConfirmationURL }}`) and the code (`{{ .Token }}`), side by side and with similar weight — the code is the way out of the in-app-browser trap above, not a curiosity.

They're styled to match the app (`styles.css`): the `#f7f8fa` canvas, a white card with a `#d9dfe8` hairline and 9px corners, `#182542` headings, `#566177` body, the app's yellow primary button, and `#116b43` for links and the accent word. They're table-based HTML with every style inline, because email clients strip `<style>` blocks and external CSS — keep it that way when editing. Each carries a hidden **preheader**: the grey preview line the inbox shows next to the subject, which is the second thing a member reads and a bigger lever on opens than anything in the body.

**Two places, one source.** `[auth.email.template.*]` in `supabase/config.toml` points at these files, but that only drives a local `supabase start` stack. The hosted project reads its templates from the dashboard, so after editing a file here, paste it into [Authentication → Emails](https://supabase.com/dashboard/project/shkfwuogrldbqldpipxd/auth/templates) (subject line included) or the two drift apart.

The logo is loaded from the live site (`https://jthoyer.github.io/BalanceTRI-app/assets/balance-logo.png`) rather than embedded, so it only appears once a member allows images — which most clients don't by default. Everything the email needs to work is text, and the `alt` carries the club name when the image is blocked.

**The sender still says Supabase.** Emails go out as `Supabase Auth <noreply@mail.app.supabase.io>`, which no member recognises and which spam filters treat accordingly — and the shared sender is capped at a handful of emails per hour, so a club-wide push would silently hit the limit. The template can't fix any of that. Configuring custom SMTP (Resend, Postmark, SendGrid) under Authentication → Settings, with a verified `balancetriclub.com.au` sender and SPF/DKIM records, is the single biggest remaining lever on sign-in rates.

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
