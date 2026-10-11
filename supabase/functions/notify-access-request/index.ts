// Entry point. Deploy with:  supabase functions deploy notify-access-request
// The Database Webhook, the secrets and the setup order are in README.md
// ("Access-request alerts").
import { handle } from './handler.ts';

Deno.serve(req =>
  handle(req, {
    env: name => Deno.env.get(name),
    fetch,
    now: () => new Date(),
  }),
);
