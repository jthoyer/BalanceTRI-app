# Repo notes for Claude Code

## Supabase

This app's backend is the **Balance Tri Club** Supabase project:

- Project ref/id: `shkfwuogrldbqldpipxd`
- Dashboard: https://supabase.com/dashboard/project/shkfwuogrldbqldpipxd
- `app.js` connects with this project's public URL and anon/publishable key (both safe to expose client-side, see README.md)

When using the Supabase MCP tools, pass `project_id: shkfwuogrldbqldpipxd` explicitly to `list_tables`, `apply_migration`, `execute_sql`, etc. `list_projects` may not list this project depending on the MCP connector's current scope — call the other tools with this ref directly rather than relying on `list_projects` to surface it.

Schema and RLS policy notes live in README.md. Migration files live in `supabase/migrations/`; when applying one via `apply_migration`, rename the local file afterwards to match the version timestamp Supabase actually recorded (check with `list_migrations`) so the repo's migration history stays in sync with the live database.
