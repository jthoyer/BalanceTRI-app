# Balance Tri Club — Race commitment prototype

Open `index.html` in any modern browser. The prototype supports member selection, race filtering, commitments, custom event distances, and adding new races.

## Backend

Data is stored in Supabase (project **Balance Tri Club**, `shkfwuogrldbqldpipxd`). `app.js` connects directly with the project's public URL and anon/publishable key — both are safe to expose client-side.

Schema (`public` schema):

- **races** — `id`, `name`, `date`, `location`, `url`, `events` (text array), `event_type` (text — Triathlon, Swim, Bike, Run, SwimRun, or a free-text "Other" value), `club_focus` (boolean), `balance_bolt` (boolean — hides the club commitments/your commitment sections on the race card, since sign-up happens on the separate Balance Bolt site), `created_at`
- **entries** — `id`, `race_id` (references `races`), `name`, `event`, `level`, `created_at`, unique on `(race_id, name)`

Row Level Security is enabled on both tables with policies that allow anonymous read/write, matching this app's no-login, honour-system trust model (members identify themselves by typing their name — there's no account or password).

Use **Refresh** to reload the latest data from Supabase.
