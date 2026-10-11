#!/usr/bin/env bash
# Two-session checks for private.lock_account(): an admin decision and an email
# change on the same account must never leave a hash behind for an address no
# account uses (the 5.2 attack). Called by run.sh with the scratch database
# name. The data it makes is committed; run.sh drops the database afterwards.
set -euo pipefail
db="$1"
q() { psql -v ON_ERROR_STOP=1 -qAt -d "$db" "$@"; }
owner='ff177de1-36e1-44ce-8c7b-3361fcf78054'

# Run SQL as the admin (two-factor session), keeping the transaction open for
# two seconds so the other session has to wait on it.
admin_slow() {
  q >/dev/null <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$owner","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
$1;
select pg_sleep(2);
commit;
SQL
}
listed() { q -c "select exists (select 1 from private.allowed_emails where email_hash = private.email_hash('$1'))"; }
check() { if [ "$1" != "$2" ]; then echo "FAILED: $3 (got $1, wanted $2)"; exit 1; fi; }

id1=$(q -c "insert into auth.users (email, email_confirmed_at) values ('race1@example.com', now()) returning id")
id2=$(q -c "insert into auth.users (email, email_confirmed_at) values ('race2@example.com', now()) returning id")
id3=$(q -c "insert into auth.users (email, email_confirmed_at) values ('race3@example.com', now()) returning id")
q -c "insert into private.access_requests (user_id, display_name, status) values ('$id1', 'Race One', 'pending')" >/dev/null

# 1. The admin approves; the member changes email while the approval is open.
admin_slow "select public.admin_decide_request('$id1', 'approve')" & pid=$!
sleep 0.5
q -c "update auth.users set email = 'race1.new@example.com' where id = '$id1'" >/dev/null
wait "$pid" || { echo "FAILED: scenario 1: the approval itself failed"; exit 1; }
check "$(listed race1@example.com)" f "approve then email change: the old address is not left listed"
check "$(q -c "select status from private.access_requests where user_id = '$id1'")" revoked "approve then email change: the request ends revoked"

# 2. The same with the Allow-list box, for an account with no request row.
admin_slow "select public.admin_allow_list_add('race2@example.com')" & pid=$!
sleep 0.5
q -c "update auth.users set email = 'race2.new@example.com' where id = '$id2'" >/dev/null
wait "$pid" || { echo "FAILED: scenario 2: the add itself failed"; exit 1; }
check "$(listed race2@example.com)" f "add then email change: the old address is not left listed"
check "$(q -c "select status from private.access_requests where user_id = '$id2'")" revoked "add then email change: the existing member ends revoked"

# 3. The email change starts first; the admin adds the old address meanwhile.
q >/dev/null <<SQL &
begin;
update auth.users set email = 'race3.new@example.com' where id = '$id3';
select pg_sleep(2);
commit;
SQL
sleep 0.5
out=$(q -c "begin;
  select set_config('request.jwt.claims', '{\"sub\":\"$owner\",\"role\":\"authenticated\",\"aal\":\"aal2\"}', true);
  set local role authenticated;
  select public.admin_allow_list_add('race3@example.com');
  commit;" 2>&1 || true)
wait
case "$out" in
  *"just changed"*) ;;
  *) echo "FAILED: email change then add: expected 'just changed', got: $out"; exit 1 ;;
esac
check "$(listed race3@example.com)" f "email change then add: nothing is listed"

# 4. The admin approves; the account is deleted meanwhile. No deadlock, no
#    hash left behind.
id4=$(q -c "insert into auth.users (email, email_confirmed_at) values ('race4@example.com', now()) returning id")
q -c "insert into private.access_requests (user_id, display_name, status) values ('$id4', 'Race Four', 'pending')" >/dev/null
admin_slow "select public.admin_decide_request('$id4', 'approve')" & pid=$!
sleep 0.5
del=$(q -c "delete from auth.users where id = '$id4'" 2>&1 || true)
wait "$pid" || { echo "FAILED: scenario 4: the approval itself failed"; exit 1; }
case "$del" in *deadlock*) echo "FAILED: approve then delete: deadlock: $del"; exit 1 ;; esac
check "$(listed race4@example.com)" f "approve then delete: the address is not left listed"

echo "race checks passed"
