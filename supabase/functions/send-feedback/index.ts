// Entry point. Deploy with:  supabase functions deploy send-feedback
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
// by Supabase. The secrets it needs (FEEDBACK_TO_EMAIL, RESEND_API_KEY,
// HCAPTCHA_SECRET) and the setup order are in README.md ("App feedback").
import { handle } from './handler.ts';

Deno.serve(req =>
  handle(req, {
    env: name => Deno.env.get(name),
    fetch,
    now: () => Date.now(),
  }),
);
