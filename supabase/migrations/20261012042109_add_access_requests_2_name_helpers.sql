-- Gated member accounts, step B3, part 2 of 8: display-name rules, the name-clash check,
-- the per-account lock and the fallback name.
-- The design notes are at the top of part 1 (20261012042054).

-- ---------------------------------------------------------------------------
-- Display names (S4, S5, F7).
-- ---------------------------------------------------------------------------

-- Trim, collapse repeated spaces, and check the rules: 2 to 40 characters;
-- letters in any language, spaces, apostrophes, hyphens and full stops; at
-- least one letter. Look-alike letters from other scripts (a Cyrillic "а" for
-- a Latin "a") are not caught; entry names are an honour system anyway.
-- [[:alpha:]] follows the database's locale, so this relies on
-- a UTF-8 database (Supabase's is). Raises a message fit to show the member.
create function private.clean_display_name(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  -- NFC first, so "Zoë" typed as one character or as "e" plus an accent mark
  -- is the same name to the uniqueness check.
  v text := normalize(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), NFC);
begin
  -- U+034F is a combining mark that draws nothing, so "Sam" + U+034F would
  -- look exactly like "Sam" yet pass the uniqueness check. Drop it.
  v := trim(regexp_replace(v, '\u034f', '', 'g'));
  if char_length(v) < 2 or char_length(v) > 40 then
    raise exception 'Your name needs to be 2 to 40 characters.';
  end if;
  if v !~ '^([[:alpha:]\u0300-\u036f]|[ ''.’-])+$' then
    raise exception 'Use letters, spaces, apostrophes, hyphens and full stops in your name.';
  end if;
  if v !~ '[[:alpha:]]' then
    raise exception 'Your name needs at least one letter.';
  end if;
  return v;
end;
$$;

-- Is this name used by someone else who is pending or approved? Approved
-- includes members who joined before requests existed, who have no request
-- row: their profile name counts if their address is on the allow-list.
create function private.display_name_taken(p_name text, p_except uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
           select 1 from private.access_requests r
            where r.user_id is distinct from p_except
              and r.status in ('pending', 'approved')
              and lower(normalize(r.display_name, NFC)) = lower(p_name)
         )
      or exists (
           select 1
             from public.profiles p
             join auth.users u on u.id = p.id
            where p.id is distinct from p_except
              and lower(normalize(p.display_name, NFC)) = lower(p_name)
              and exists (
                    select 1 from private.allowed_emails a
                     where a.email_hash = private.email_hash(u.email)
                  )
         );
$$;

-- One account's access changes one at a time. Admin decisions, request_access
-- and the G3 triggers all take this lock first, so an approval can't interleave
-- with an email change or a deletion and leave a hash behind for an address no
-- account uses (that would be the 5.2 attack again). An advisory lock, because
-- locking rows in auth.users needs privileges this project may not grant.
create function private.lock_account(p_user_id uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtext('account:' || p_user_id::text));
$$;

-- A name for a request row made on someone's behalf (an existing member who
-- loses their listing). Their profile name if it fits the column, else "Member".
create function private.fallback_name(p_user_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(
    (select left(p.display_name, 40) from public.profiles p
      where p.id = p_user_id and char_length(p.display_name) >= 2),
    'Member'
  );
$$;

revoke execute on function private.clean_display_name(text) from public, anon, authenticated;
revoke execute on function private.display_name_taken(text, uuid) from public, anon, authenticated;
revoke execute on function private.lock_account(uuid) from public, anon, authenticated;
revoke execute on function private.fallback_name(uuid) from public, anon, authenticated;
