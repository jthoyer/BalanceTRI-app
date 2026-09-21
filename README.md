# Balance Tri Club — Race commitment prototype

Open `index.html` in any modern browser. The prototype supports member selection, race filtering, commitments, custom event distances, and adding new races.

## Backend

Data is stored in Supabase (project **Balance Tri Club**, `shkfwuogrldbqldpipxd`). `app.js` connects directly with the project's public URL and anon/publishable key — both are safe to expose client-side.

Schema (`public` schema):

- **races** — `id`, `name`, `date`, `location`, `url`, `slug` (text, unique, not null — see *Shareable race URLs* below), `events` (text array), `event_type` (text — Triathlon, Swim, Bike, Run, Multi-sport, or Balance Bolt), `club_focus` (boolean — set from the "Club focus race" checkbox, except for Balance Bolt races, which the app always saves as `true`; the checkbox is hidden in the form while Balance Bolt is the selected event type), `balance_bolt` (boolean — hides the club commitments/your commitment sections on the race card, since sign-up happens on the separate Balance Bolt site; the app sets this automatically from `event_type === 'Balance Bolt'` rather than exposing a separate form field), `created_at`
- **entries** — `id`, `race_id` (references `races`), `name`, `event`, `level`, `created_at`, unique on `(race_id, name)`
- **profiles** — `id` (references `auth.users`), `display_name`, `justgo_status` (`unverified` / `verified` / `not_found` — reserved for a future JustGo membership check, unused for now), `justgo_member_number`, `justgo_checked_at`, `created_at`

Row Level Security is enabled on all three tables. `races` keeps policies that allow anonymous read/write, matching this app's no-login, honour-system trust model for races (there's no account or password required to add or edit a race). `entries` allows anonymous **read** the same way — every roster stays visible to anyone — but insert/update/delete are restricted to the `authenticated` role (`require_auth_for_entries_writes` migration): saving, editing or removing a commitment requires being signed in. Sign-in still isn't tied to ownership — any signed-in member can add or edit any entry by typed name, so the honour system continues once you're past the door. `profiles` is different again: each row is readable and writable only by the signed-in user it belongs to (`auth.uid() = id`).

## Sign-in

`app.js` uses Supabase Auth's email magic-link flow (`signInWithOtp`): entering an email sends a link, and opening it signs the browser in. The same email also carries a **6-digit code**, and the sheet shows a box for it (`showCodeStep` in `app.js`, calling `verifyOtp` with `type: 'email'`, which covers both a brand-new address and a returning one). The code is there because of the usual way a magic link fails on a phone: tapping the link inside the Gmail or Outlook app opens an in-app browser, which signs *that* browser in and leaves the tab the member started in signed out. Typing the code signs them in where they already are. Supabase issues one token per request, so the link and the code are the same credential — using either retires the other. The `handle_new_user` trigger (in the `add_profiles_table` migration) creates a matching `profiles` row the first time someone signs in, seeding `display_name` from the email's local part. Once signed in, that `display_name` fills the "Your name" field automatically (but never overwrites a name already typed in this browser).

Browsing is always open — the calendar and every race's roster are visible whether or not you're signed in. Saving, editing or removing a commitment is not: a signed-out attempt opens a bottom sheet asking you to sign in first (`requireSignIn` in `app.js`), and the click that started it resumes once you are.

Separately, a bottom-sheet **nudge** appears once per visit for a signed-out browser (unless snoozed), offering "Sign in" or "Just browsing" with equal weight — tapping outside it, scrolling the page, or "Just browsing" all dismiss it the same way, since it never blocks anything. Checking "Don't ask me to sign in again for 10 days" before dismissing snoozes the nudge for 10 days (tracked client-side in `localStorage` as `authDismissedUntil`, not in Supabase); leaving it unchecked just dismisses it for the current visit. The small sign-in control in the header stays available regardless, on mobile included.

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
