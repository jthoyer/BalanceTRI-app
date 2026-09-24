-- app.js calls db.rpc('is_allow_listed') against the client's default
-- (public) schema -- createClient() here takes no `db: { schema }` override,
-- and supabase/config.toml only exposes public and graphql_public to
-- PostgREST. private.is_allow_listed() has therefore never been reachable
-- from the app: every call 404s, checkMembership() reads that as
-- isMember = false, and rejectNonMember() signs every real member straight
-- back out right after they sign in. This adds the public wrapper the
-- client actually calls; the real check and its allow-list table stay in
-- the private schema.
create function public.is_allow_listed()
returns boolean
language sql
security invoker
set search_path = ''
stable
as $$
  select private.is_allow_listed();
$$;

revoke execute on function public.is_allow_listed() from public, anon;
grant execute on function public.is_allow_listed() to authenticated;
