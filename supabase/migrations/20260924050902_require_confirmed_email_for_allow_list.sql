-- ---------------------------------------------------------------------------
-- private.is_allow_listed(): trust only a confirmed address.
--
-- Until now the check read the email claim straight from the JWT. Supabase
-- issues a JWT for a password sign-up at once when "Confirm email" is off, so
-- a bot could sign up with the address of an allow-listed member who hasn't
-- joined yet and get write access without ever opening that inbox. The
-- dashboard setting is the first line of defence; this makes the function
-- safe even if that setting is ever switched off.
--
-- The address now comes from auth.users, matched on auth.uid() and only when
-- email_confirmed_at is set. auth.users.email only changes once a new address
-- is confirmed, so a pending email change cannot slip through either.
--
-- Same signature, same grants, same HMAC lookup: only the source of
-- caller_email changes.
-- ---------------------------------------------------------------------------
create or replace function private.is_allow_listed()
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_email text;
  hmac_key text;
begin
  select lower(trim(u.email)) into caller_email
    from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null;

  if coalesce(caller_email, '') = '' then
    return false;
  end if;

  select decrypted_secret into hmac_key
    from vault.decrypted_secrets
    where name = 'allowed_emails_hmac_key';

  if hmac_key is null then
    return false;
  end if;

  return exists (
    select 1
    from private.allowed_emails
    where email_hash = encode(extensions.hmac(caller_email, hmac_key, 'sha256'), 'hex')
  );
end;
$$;
