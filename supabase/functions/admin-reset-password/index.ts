// Entry point. Deploy with:  supabase functions deploy admin-reset-password
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
// by Supabase. ADMIN_ORIGIN is optional (default https://jthoyer.github.io).
// See README.md, "Password resets".
import { handle } from './handler.ts';

Deno.serve(req =>
  handle(req, {
    env: name => Deno.env.get(name),
    fetch,
    random: n => crypto.getRandomValues(new Uint32Array(n)),
  }),
);
