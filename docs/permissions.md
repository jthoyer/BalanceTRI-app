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
| **entries** (commitments) | - (counts only, see below) | - | R all. W insert; update and delete **own only** (`created_by` is you). A new entry must carry your own display name. Only an admin changes a name | W any, with two-factor and on the allow-list. Plus rename, Link and Unlink |
| **results** | - | - | R all. W only your own entry's result (`created_by` is you), and only for a past, non-Bolt, live race | W any entry's result on the same race rules, with two-factor and on the allow-list |
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
- **Entries belong to their owner (pending apply).** Insert needs an approved member and
  your own display name. Update and delete need you to be the entry's owner
  (`created_by`), or an admin with a two-factor session who is also on the allow-list
  (`restrict_entry_writes_to_owners` migration, via `private.can_change_entry()`, which
  members may execute; `private.is_admin()` they may not). An entry with no owner is
  admin-only. Only the name is locked (`guard_entry_name`). `created_by` is write-once
  for API callers, admins included. This replaced an honour system, decided by the
  owner on 22 October 2026, when every commitment and result was deleted so that every
  entry has an owner. **Races** stay an honour system: any approved member may edit or
  remove any race.
- **Results belong to the entry's owner.** The owner is `created_by`, and only that. An
  entry with no owner can be written by an admin alone.
- **Display names use one alphabet, and no blank letters.** A name that mixes Latin, Greek
  and Cyrillic letters, or holds a letter that draws nothing (Hangul fillers, braille
  blank), is refused by `private.clean_display_name()` (same migration).
- **Pick your races is app-only.** The one-time screen that offers upcoming races writes
  through the same entries insert policy, one row per race. It adds no permission and no
  server state (its "seen" flag is in the browser).
- **Undoing a deleted entry keeps its owner.** `admin_undo` restores `created_by` from
  the history row, so the member keeps the entry.
- **Bulk guard.** An API request cannot change more than 5 rows of `entries`, `races`
  or `results` at once. The dashboard, service role and admin functions are exempt.
- **Every change to `entries`, `races` and `results` is copied to `change_history`.**

## Owner questions, decided

1. **Entries: honour system or owner-only?** Decided 22 October 2026 by the owner:
   owner-only. Update and delete are limited to the entry's owner and to admins with a
   two-factor session. Needs the `restrict_entry_writes_to_owners` migration applied.
2. **Results: who owns an entry with no owner?** Decided 22 October 2026 by the owner:
   nobody. A name match is no longer enough. An admin writes the result, or Links the
   entry to the member first (`admin_link_entries`).

The "Last checked" date above is not advanced: this record states the intended rules, and the
live project has not been checked since the migration was written. Advance it after the
migration is applied and `pg_policies` is read again.

## Not covered here

Supabase Auth settings (two-factor, email confirmation), the Telegram notifier, storage
buckets and edge functions. This record covers the `public` and `private` schemas only.
