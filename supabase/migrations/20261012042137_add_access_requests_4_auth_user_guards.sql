-- Gated member accounts, step B3, part 4 of 8: G3, triggers on auth.users.
-- The design notes are at the top of part 1 (20261012042054).

-- ---------------------------------------------------------------------------
-- G3: an address's hash must not outlive its account. With "Confirm email" off
-- an address proves nothing, so a hash left behind is a pre-approval that
-- anyone can claim by signing up with that address.
-- ---------------------------------------------------------------------------
create function private.forget_deleted_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_account(old.id);
  if old.email is not null then
    delete from private.allowed_emails where email_hash = private.email_hash(old.email);
  end if;
  return null;
end;
$$;

-- The old address loses its hash, and an approved request becomes revoked so
-- the owner has to approve the new address. The new address is not added. A
-- change of letter case alone is the same address and is ignored. A member who
-- joined before requests existed gets a revoked row, so they see "access
-- removed" rather than the join form.
create function private.forget_changed_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_listed boolean := false;
begin
  -- The lock comes first, and each statement below takes a fresh snapshot, so a
  -- hash an admin inserted while this waited is seen and removed.
  perform private.lock_account(new.id);
  if old.email is not null then
    delete from private.allowed_emails where email_hash = private.email_hash(old.email);
    was_listed := found;
  end if;
  update private.access_requests
     set status = 'revoked', decided_by = null, decided_at = now(),
         reason = 'Email address changed'
   where user_id = new.id and status = 'approved';
  if was_listed and not found then
    insert into private.access_requests (user_id, display_name, status, decided_at, reason)
    values (new.id, private.fallback_name(new.id), 'revoked', now(), 'Email address changed')
    on conflict (user_id) do nothing;
  end if;
  return null;
end;
$$;

-- The foreign-key cascade to access_requests runs before the AFTER trigger
-- below. Taking the account lock in a BEFORE trigger keeps the lock order the
-- same as the admin functions (lock, then request row), so a deletion and an
-- admin decision wait for each other instead of deadlocking.
create function private.lock_deleted_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_account(old.id);
  return old;
end;
$$;

create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function private.forget_deleted_account();

create trigger before_auth_user_deleted
  before delete on auth.users
  for each row execute function private.lock_deleted_account();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (lower(trim(old.email)) is distinct from lower(trim(new.email)))
  execute function private.forget_changed_email();

revoke execute on function private.forget_deleted_account() from public, anon, authenticated;
revoke execute on function private.forget_changed_email() from public, anon, authenticated;
revoke execute on function private.lock_deleted_account() from public, anon, authenticated;
