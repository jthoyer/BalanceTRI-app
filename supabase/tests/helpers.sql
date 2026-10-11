-- Helpers shared by the SQL tests. Each test file \i's this inside its own
-- transaction, so everything here is rolled back with it.
--
-- A failed check raises an exception that starts "FAILED:", and psql stops.

create schema t;
grant usage on schema t to anon, authenticated, service_role;
create table t.u (name text primary key, id uuid not null);
grant select on t.u to anon, authenticated, service_role;

create function t.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAILED: %', msg; end if;
end $$;

-- A confirmed account, as it would look with "Confirm email" off. The profile
-- trigger gives it a profile named after the local part of the address.
create function t.mk(p_name text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, email_confirmed_at) values (v, p_name || '@example.com', now());
  insert into t.u values (p_name, v);
  return v;
end $$;

create function t.id(p_name text) returns uuid language sql stable as $$
  select id from t.u where name = p_name
$$;

-- An existing member: on the allow-list, no request row.
create function t.list(p_name text) returns void language plpgsql as $$
begin
  insert into private.allowed_emails (email_hash) values (private.email_hash(p_name || '@example.com'));
end $$;

create function t.listed(p_email text) returns boolean language sql as $$
  select exists (select 1 from private.allowed_emails where email_hash = private.email_hash(p_email))
$$;

-- Act as a signed-in user (or anon), the way the API would: JWT claims in a
-- session setting, and the matching database role. Undo with: reset role;
create function t.as_user(p_name text, p_aal text default 'aal1') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', t.id(p_name), 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function t.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

-- Run a statement and require it to fail with a message matching the pattern
-- (LIKE) or with that SQLSTATE.
create function t.fails(stmt text, pat text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlerrm like pat or sqlstate = pat then return; end if;
    raise exception 'FAILED: [%] raised "%" (%), expected %', stmt, sqlerrm, sqlstate, pat;
  end;
  raise exception 'FAILED: [%] did not fail, expected %', stmt, pat;
end $$;

-- Run a statement and return how many rows it touched.
create function t.rows(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end $$;

-- A friendly error: the message is shown to the member as it is.
create function t.msg(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end $$;
