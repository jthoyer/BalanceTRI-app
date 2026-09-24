-- ---------------------------------------------------------------------------
-- Admin console (admin.html): the database side.
--
-- private.change_history (add_change_history) records every write to entries
-- and races, but using it meant writing SQL in the Supabase dashboard. These
-- functions let one named admin review activity, undo a single change,
-- restore a removed race, manage the email allow-list and see a few stats
-- from a page in the app.
--
-- Design rules:
--   * Admins are rows in private.admins, never a flag the browser can set.
--   * The page never reads a private table. Every action is a public
--     SECURITY DEFINER function that calls private.require_admin() first.
--   * An admin must have passed two-factor sign-in in this session (the JWT's
--     aal claim is 'aal2'). A stolen inbox alone is not enough. To relax it
--     for one admin: update private.admins set mfa_required = false ...
--   * Every admin action is logged in private.admin_actions, and the writes
--     it makes land in change_history like any other.
--   * Admin functions run as the table owner, so RLS and the bulk-write
--     guard don't apply. Each one touches a single row by design.
-- ---------------------------------------------------------------------------

create table private.admins (
  user_id uuid primary key references auth.users on delete cascade,
  mfa_required boolean not null default true,
  added_at timestamptz not null default now()
);
alter table private.admins enable row level security;
revoke all on private.admins from public, anon, authenticated;

-- The club's one admin at launch. A user id, not an email, so no address
-- sits in the repo. Add more by user id from the dashboard.
insert into private.admins (user_id) values ('ff177de1-36e1-44ce-8c7b-3361fcf78054');

create table private.admin_actions (
  id bigint generated always as identity primary key,
  admin_id uuid not null,
  action text not null,
  change_id bigint references private.change_history on delete set null,
  target jsonb,
  at timestamptz not null default now()
);
create index admin_actions_change_idx on private.admin_actions (change_id);
alter table private.admin_actions enable row level security;
revoke all on private.admin_actions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers. Private, and callable only by the definer functions below.
-- ---------------------------------------------------------------------------
create function private.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from private.admins a
    where a.user_id = auth.uid()
      and (not a.mfa_required or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
  );
$$;

create function private.require_admin()
returns void
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
end;
$$;

-- Same keyed hash as private.is_allow_listed(), for an address an admin types.
create function private.email_hash(p_email text)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  hmac_key text;
begin
  select decrypted_secret into hmac_key
    from vault.decrypted_secrets
    where name = 'allowed_emails_hmac_key';
  if hmac_key is null then
    raise exception 'The allow-list key is missing from Vault.';
  end if;
  return encode(extensions.hmac(lower(trim(p_email)), hmac_key, 'sha256'), 'hex');
end;
$$;

-- A label for whoever made a change: their display name, else their email.
create function private.user_label(p_user_id uuid)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(
    (select nullif(p.display_name, '') from public.profiles p where p.id = p_user_id),
    (select u.email from auth.users u where u.id = p_user_id)
  );
$$;

revoke execute on function private.is_admin() from public, anon, authenticated;
revoke execute on function private.require_admin() from public, anon, authenticated;
revoke execute on function private.email_hash(text) from public, anon, authenticated;
revoke execute on function private.user_label(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_status(): the only function a non-admin may usefully call. It says
-- whether the caller is an admin and whether this session has passed
-- two-factor, so the page knows which screen to show. It reveals nothing
-- about anyone else.
-- ---------------------------------------------------------------------------
create function public.admin_status()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'admin', a.user_id is not null,
    'mfa_required', coalesce(a.mfa_required, false),
    'aal', auth.jwt() ->> 'aal',
    'ready', private.is_admin()
  )
  from (select 1) one
  left join private.admins a on a.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Stats for the top of the page. Days are Sydney days.
-- ---------------------------------------------------------------------------
create function public.admin_stats()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
begin
  perform private.require_admin();
  return jsonb_build_object(
    'races_upcoming', (select count(*) from public.races where deleted_at is null and date >= today),
    'races_live', (select count(*) from public.races where deleted_at is null),
    'races_removed', (select count(*) from public.races where deleted_at is not null),
    'entries', (select count(*) from public.entries),
    'users', (select count(*) from auth.users),
    'users_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'users_unconfirmed', (select count(*) from auth.users where email_confirmed_at is null),
    'users_not_listed', (
      select count(*) from auth.users u
      where not exists (
        select 1 from private.allowed_emails a where a.email_hash = private.email_hash(u.email)
      )
    ),
    'allow_list_size', (select count(*) from private.allowed_emails),
    'changes_7d', (select count(*) from private.change_history where changed_at > now() - interval '7 days'),
    'deletes_7d', (
      select count(*) from private.change_history
      where op = 'DELETE' and changed_at > now() - interval '7 days'
    ),
    'signups_by_day', (
      select jsonb_agg(jsonb_build_object('day', d.day, 'count', (
        select count(*) from auth.users u
        where (u.created_at at time zone 'Australia/Sydney')::date = d.day
      )) order by d.day)
      from (select (today - n) as day from generate_series(0, 13) n) d
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Activity feed: newest first, with who made each change and whether an
-- admin has already undone it.
-- ---------------------------------------------------------------------------
create function public.admin_activity(p_days int default 30, p_limit int default 300)
returns table (
  id bigint,
  table_name text,
  row_id uuid,
  op text,
  old_row jsonb,
  new_row jsonb,
  changed_at timestamptz,
  changed_by uuid,
  changed_by_label text,
  changed_role text,
  undone_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
    select h.id, h.table_name, h.row_id, h.op, h.old_row, h.new_row, h.changed_at,
           h.changed_by, private.user_label(h.changed_by), h.changed_role,
           (select max(a.at) from private.admin_actions a
             where a.change_id = h.id and a.action = 'undo')
      from private.change_history h
     where h.changed_at > now() - make_interval(days => least(greatest(p_days, 1), 365))
     order by h.id desc
     limit least(greatest(p_limit, 1), 1000);
end;
$$;

-- ---------------------------------------------------------------------------
-- Undo one change.
--
--   INSERT  -> remove the row (a race is soft-deleted, so its roster stays)
--   UPDATE  -> put the old values back
--   DELETE  -> put the row back
--
-- Only when the row is still exactly as that change left it. If something
-- changed it since, undo the later change first. That keeps an undo from
-- silently wiping someone else's newer edit.
--
-- A restored entry's created_by becomes the admin: entries_set_created_by()
-- stamps every insert with auth.uid(). The history keeps the original.
-- ---------------------------------------------------------------------------
create function public.admin_undo(p_change_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h private.change_history%rowtype;
  tbl text;
  cur jsonb;
  cols text;
begin
  perform private.require_admin();

  select * into h from private.change_history where id = p_change_id;
  if not found then
    raise exception 'No such change.';
  end if;
  if h.table_name not in ('entries', 'races') then
    raise exception 'Changes to % cannot be undone here.', h.table_name;
  end if;
  if exists (select 1 from private.admin_actions where change_id = h.id and action = 'undo') then
    raise exception 'That change has already been undone.';
  end if;

  tbl := format('public.%I', h.table_name);
  execute format('select to_jsonb(t) from %s t where t.id = $1', tbl) into cur using h.row_id;

  begin
    if h.op = 'DELETE' then
      if cur is not null then
        raise exception 'That row exists again, so there is nothing to restore.';
      end if;
      execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', tbl, tbl)
        using h.old_row;
    elsif cur is null then
      raise exception 'That row no longer exists. Undo its deletion first.';
    elsif cur is distinct from h.new_row then
      raise exception 'That row has changed since. Undo the later change first.';
    elsif h.op = 'INSERT' then
      if h.table_name = 'races' then
        update public.races set deleted_at = now() where id = h.row_id;
      else
        delete from public.entries where id = h.row_id;
      end if;
    else
      -- Every column but the identity and the audit columns the triggers own.
      select string_agg(format('%I = o.%I', c.column_name, c.column_name), ', ')
        into cols
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = h.table_name
         and c.column_name not in ('id', 'created_at', 'created_by', 'updated_at', 'updated_by');
      execute format(
        'update %s t set %s from jsonb_populate_record(null::%s, $1) o where t.id = $2',
        tbl, cols, tbl
      ) using h.old_row, h.row_id;
    end if;
  exception
    when unique_violation then
      raise exception 'Undoing this would clash with a live row: a race with the same name and date, or an entry with the same name on that race.';
    when foreign_key_violation then
      raise exception 'The race this entry belonged to no longer exists.';
  end;

  insert into private.admin_actions (admin_id, action, change_id, target)
  values (auth.uid(), 'undo', h.id,
          jsonb_build_object('table', h.table_name, 'row_id', h.row_id, 'op', h.op));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Removed races, and restoring one.
-- ---------------------------------------------------------------------------
create function public.admin_removed_races()
returns table (
  id uuid,
  name text,
  date date,
  deleted_at timestamptz,
  removed_by_label text,
  entry_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
    select r.id, r.name, r.date, r.deleted_at, private.user_label(r.updated_by),
           (select count(*) from public.entries e where e.race_id = r.id)
      from public.races r
     where r.deleted_at is not null
     order by r.deleted_at desc;
end;
$$;

create function public.admin_restore_race(p_race_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  perform private.require_admin();
  begin
    update public.races set deleted_at = null where id = p_race_id and deleted_at is not null;
    get diagnostics n = row_count;
  exception when unique_violation then
    raise exception 'A live race already has this race''s name and date. Rename or remove that one first.';
  end;
  if n = 0 then
    raise exception 'That race is not removed, or does not exist.';
  end if;
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'restore_race', jsonb_build_object('race_id', p_race_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Everyone who has signed up, and whether they're on the allow-list. The
-- quickest way to spot a bot account: signed up, not on the list, never
-- confirmed.
-- ---------------------------------------------------------------------------
create function public.admin_users()
returns table (
  id uuid,
  email text,
  display_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  confirmed boolean,
  on_allow_list boolean,
  is_admin boolean,
  entries_created bigint,
  changes_30d bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query
    select u.id, u.email::text, p.display_name, u.created_at, u.last_sign_in_at,
           u.email_confirmed_at is not null,
           exists (select 1 from private.allowed_emails a where a.email_hash = private.email_hash(u.email)),
           exists (select 1 from private.admins ad where ad.user_id = u.id),
           (select count(*) from public.entries e where e.created_by = u.id),
           (select count(*) from private.change_history h
             where h.changed_by = u.id and h.changed_at > now() - interval '30 days')
      from auth.users u
      left join public.profiles p on p.id = u.id
     order by u.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- The allow-list. It stores only keyed hashes, so it can't be listed; an
-- admin checks, adds or removes one address at a time. The log keeps the
-- hash, not the address.
-- ---------------------------------------------------------------------------
create function public.admin_allow_list_check(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return exists (select 1 from private.allowed_emails where email_hash = private.email_hash(p_email));
end;
$$;

create function public.admin_allow_list_add(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
  added boolean;
begin
  perform private.require_admin();
  if coalesce(trim(p_email), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That doesn''t look like an email address.';
  end if;
  h := private.email_hash(p_email);
  insert into private.allowed_emails (email_hash) values (h) on conflict do nothing;
  added := found;
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'allow_list_add', jsonb_build_object('email_hash', h, 'added', added));
  return jsonb_build_object('added', added);
end;
$$;

create function public.admin_allow_list_remove(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text;
  removed boolean;
begin
  perform private.require_admin();
  h := private.email_hash(p_email);
  delete from private.allowed_emails where email_hash = h;
  removed := found;
  insert into private.admin_actions (admin_id, action, target)
  values (auth.uid(), 'allow_list_remove', jsonb_build_object('email_hash', h, 'removed', removed));
  return jsonb_build_object('removed', removed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: signed-in users may call these; each one refuses non-admins.
-- ---------------------------------------------------------------------------
revoke execute on function public.admin_status() from public, anon;
revoke execute on function public.admin_stats() from public, anon;
revoke execute on function public.admin_activity(int, int) from public, anon;
revoke execute on function public.admin_undo(bigint) from public, anon;
revoke execute on function public.admin_removed_races() from public, anon;
revoke execute on function public.admin_restore_race(uuid) from public, anon;
revoke execute on function public.admin_users() from public, anon;
revoke execute on function public.admin_allow_list_check(text) from public, anon;
revoke execute on function public.admin_allow_list_add(text) from public, anon;
revoke execute on function public.admin_allow_list_remove(text) from public, anon;

grant execute on function public.admin_status() to authenticated;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.admin_activity(int, int) to authenticated;
grant execute on function public.admin_undo(bigint) to authenticated;
grant execute on function public.admin_removed_races() to authenticated;
grant execute on function public.admin_restore_race(uuid) to authenticated;
grant execute on function public.admin_users() to authenticated;
grant execute on function public.admin_allow_list_check(text) to authenticated;
grant execute on function public.admin_allow_list_add(text) to authenticated;
grant execute on function public.admin_allow_list_remove(text) to authenticated;
