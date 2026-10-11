#!/usr/bin/env bash
# Replays every migration on a scratch Postgres, then runs the SQL tests here.
#
#   PGHOST=/tmp/pgtest PGUSER=nobody supabase/tests/run.sh
#
# Needs a running Postgres (16 or newer) with the pgcrypto extension available,
# and a database user that may create databases and roles. It creates a
# throwaway database, runs everything, and drops it. It never touches a real
# Supabase project: stubs.sql builds stand-ins for auth, vault and pg_net.
#
# Lines starting "create extension" are dropped from each migration because
# the stand-ins replace pg_net. A failed check raises an error and stops the run.
set -euo pipefail
cd "$(dirname "$0")/../.."

export PGOPTIONS='-c client_min_messages=warning'
db="tri_tests_$$"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database $db"
trap 'psql -q -d postgres -c "drop database if exists $db" >/dev/null' EXIT
run() { psql -v ON_ERROR_STOP=1 -q -d "$db" "$@"; }

run -f supabase/tests/stubs.sql
for f in supabase/migrations/*.sql; do
  echo "migration: $(basename "$f")"
  sed '/^create extension/d' "$f" | run -f -
done
for t in supabase/tests/*.test.sql; do
  echo "test: $(basename "$t")"
  run -f "$t"
done
echo "all SQL tests passed"
