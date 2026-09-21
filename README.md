# Balance Tri Club — Race commitment prototype

Open `index.html` in any modern browser. The prototype supports member selection, race filtering, commitments, custom event distances, and adding new races.

## Backend

Data is stored in Supabase (project **Balance Tri Club**, `shkfwuogrldbqldpipxd`). `app.js` connects directly with the project's public URL and anon/publishable key — both are safe to expose client-side.

Schema (`public` schema):

- **races** — `id`, `name`, `date`, `location`, `url`, `deleted_at` (timestamptz — set when a race is removed; see *Removing a race* below), `updated_at`, `created_by` / `updated_by` (reference `auth.users`, stamped by the `races_audit_biu` trigger; null for rows predating the change or edited from the dashboard), `slug` (text, unique, not null — see *Shareable race URLs* below), `events` (text array), `event_type` (text — Triathlon, Swim, Bike, Run, Multi-sport, or Balance Bolt), `club_focus` (boolean — set from the "Club focus race" checkbox, except for Balance Bolt races, which the app always saves as `true`; the checkbox is hidden in the form while Balance Bolt is the selected event type), `balance_bolt` (boolean — hides the club commitments/your commitment sections on the race card, since sign-up happens on the separate Balance Bolt site; the app sets this automatically from `event_type === 'Balance Bolt'` rather than exposing a separate form field), `created_at`
- **entries** — `id`, `race_id` (references `races`), `name`, `event`, `level`, `created_at`, unique on `(race_id, name)`
- **profiles** — `id` (references `auth.users`), `display_name`, `justgo_status` (`unverified` / `verified` / `not_found` — reserved for a future JustGo membership check, unused for now), `justgo_member_number`, `justgo_checked_at`, `created_at`

Row Level Security is enabled on all three tables. `races` is **read open, write authenticated** (`races_auth_writes_and_soft_delete` migration): anyone can browse the calendar, but adding, editing or removing a race requires being signed in. Before that change anonymous visitors could delete every race on the calendar, which sat oddly next to the rule that you must sign in to commit to one. Sign-in still isn't tied to ownership — any signed-in member can edit or remove any race, exactly as with entries — so the honour system continues once you're past the door. `entries` allows anonymous **read** the same way — every roster stays visible to anyone — but insert/update/delete are restricted to the `authenticated` role (`require_auth_for_entries_writes` migration): saving, editing or removing a commitment requires being signed in. Sign-in still isn't tied to ownership — any signed-in member can add or edit any entry by typed name, so the honour system continues once you're past the door. `profiles` is different again: each row is readable and writable only by the signed-in user it belongs to (`auth.uid() = id`).

## Removing a race

Removing a race is a **soft delete**: `deleted_at` is stamped and the row stays. A race carries its roster, so a hard delete would destroy other people's commitments as well. `app.js` never issues a `DELETE` against `races`, and there is no delete policy on the table.

Two consequences worth knowing:

- **Restoring a race is a deliberate act** in the dashboard or via the service role (`update races set deleted_at = null`). The update policy only matches live rows, so the app itself cannot bring one back.
- **The select policy is split by role on purpose.** Anonymous visitors see live races only; signed-in members can read every row. A single `using (deleted_at is null)` policy looks correct and silently makes the soft delete impossible — on `UPDATE`, Postgres checks the *new* row against the SELECT policies too, so the statement that sets `deleted_at` produces a row the updater may no longer see and is rejected. `loadRaces` therefore filters `deleted_at` itself, so a removed race doesn't reappear just because you signed in.

The unique index on `slug` is partial (`where deleted_at is null`), so removing a race frees its slug. Without that, re-adding the same race next season would silently become `berlin-marathon-2026-2`. The `races_assign_slug` de-duplication also skips removed races, stated explicitly rather than left resting on the select policy.

## Sign-in

`app.js` uses Supabase Auth's email magic-link flow (`signInWithOtp`): entering an email sends a link, and opening it signs the browser in. The `handle_new_user` trigger (in the `add_profiles_table` migration) creates a matching `profiles` row the first time someone signs in, seeding `display_name` from the email's local part. Once signed in, that `display_name` fills the "Your name" field automatically (but never overwrites a name already typed in this browser).

Browsing is always open — the calendar and every race's roster are visible whether or not you're signed in. Saving, editing or removing a commitment is not: a signed-out attempt opens a bottom sheet asking you to sign in first (`requireSignIn` in `app.js`), and the click that started it resumes once you are.

Separately, a bottom-sheet **nudge** appears once per visit for a signed-out browser (unless snoozed), offering "Sign in" or "Just browsing" with equal weight — tapping outside it, scrolling the page, or "Just browsing" all dismiss it the same way, since it never blocks anything. Checking "Don't ask me to sign in again for 10 days" before dismissing snoozes the nudge for 10 days (tracked client-side in `localStorage` as `authDismissedUntil`, not in Supabase); leaving it unchecked just dismisses it for the current visit. The small sign-in control in the header stays available regardless, on mobile included.

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
