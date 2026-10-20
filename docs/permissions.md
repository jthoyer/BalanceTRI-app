# Permissions: who may read and write each table, by role

This is the intent record. The next security audit checks the code and the live
database against it. Where the two differ, one of them is wrong, and the owner decides which.

Last checked against the live **Balance Tri Club** project (`shkfwuogrldbqldpipxd`) on
2026-10-20, from `pg_policies`, table grants, function grants and trigger definitions.

## Roles

| Role | Who they are | How the database tells |
|---|---|---|
| Visitor | Not signed in | `anon` |
| Pending | Signed in, not on the allow-list: no request yet, waiting, rejected or revoked | `authenticated` and `private.is_allow_listed()` is false |
| Approved member | Signed in, confirmed email, on the allow-list | `private.is_allow_listed()` is true |
| Admin | A row in `private.admins`. Every admin function also needs a two-factor session (`aal2`) | `private.is_admin()` |

An admin is also an approved member only if their address is on the allow-list. The
console warns about this and offers to add it.

## Tables

`R` read, `W` write (insert, update or delete as noted), `-` none.

| Data | Visitor | Pending | Approved member | Admin |
|---|---|---|---|---|
| **races** | R live races only | R all rows (the app filters removed ones) | R all. W insert and update live races. No delete policy: removal is a soft delete | As member. Restore a removed race (`admin_restore_race`) |
| **entries** (commitments) | - (counts only, see below) | - | R all. W insert, update, delete **any** entry. A new entry must carry your own display name. Only an admin changes a name | As member, plus rename, Link and Unlink |
| **results** | - | - | R all. W only your own entry's result, and only for a past, non-Bolt, live race | W any entry's result on the same race rules |
| **profiles** | - | R and update own row | R and update own row | As member. Rename others via `admin_rename_member` |
| **allow-list** (`private.allowed_emails`) | - | - | - | Add, remove, check one address at a time |
| **access requests** (`private.access_requests`) | - | Create and read own via `request_access()` and `my_access_status()` | Same | Read all, approve, reject, revoke |
| **change history** (`private.change_history`) | - | - | - | Read through `admin_activity`. Undo through `admin_undo` |
| **feedback, admins, admin log, password resets** (`private.*`) | - | - | - | Through `admin_*` functions only |

Every `private` table has row security on and no policy, and `anon` and `authenticated`
hold no grant on it. They are reachable only through the functions below.

## Functions callable from the app

| Function | Visitor | Pending | Member | Admin |
|---|---|---|---|---|
| `public_race_counts()` (committed and locked counts per live race, no names) | yes | yes | yes | yes |
| `request_access()`, `my_access_status()`, `password_changed()` | - | yes | yes | yes |
| `add_race_event()` (append one distance to a race) | - | refused | yes | yes |
| `is_allow_listed()` | - | yes | yes | yes |
| `admin_*` (22 functions) | - | refused | refused | yes, with two-factor |
| `feedback_*`, `notifier_*`, `handle_new_user()` | - | - | - | - (no grant to `anon` or `authenticated`) |

## Rules behind the table

- **Allow-list, not sign-in, is the door.** Sign-in alone grants a pending account nothing
  except its own profile and the request functions.
- **Confirmed email only.** `is_allow_listed()` reads `auth.users`, and only counts an
  address with `email_confirmed_at` set.
- **Honour system on entries and races.** Any approved member may edit or remove any
  entry or race. Only the name is locked (`guard_entry_name`). `created_by` is
  write-once for API callers, admins included.
- **Results belong to the entry's owner.** The owner is `created_by`. For an entry with
  no owner, the owner is the member whose display name matches the entry name.
- **Bulk guard.** An API request cannot change more than 5 rows of `entries`, `races`
  or `results` at once. The dashboard, service role and admin functions are exempt.
- **Every change to `entries`, `races` and `results` is copied to `change_history`.**

## Open owner questions

The code answers these today. The doc cannot say whether the answers are intended.

1. **Entries: honour system or owner-only?** Today an approved member can change or
   delete anyone's commitment. `README.md` line 36 calls this the honour system. Is that
   the decision, or should update and delete be limited to the owner and admins, as
   results already are?
2. **Results: who owns an entry with no owner?** Today the member whose display name
   matches the entry name may write its result. Is a name match enough proof, or should
   an admin Link the entry first (`admin_link_entries`)? `README.md` line 33 says
   results are written by the owner or an admin, which reads stricter than the name match.

Fill in the answers here, then change the code or the doc to match.

## Not covered here

Supabase Auth settings (two-factor, email confirmation), the Telegram notifier, storage
buckets and edge functions. This record covers the `public` and `private` schemas only.
