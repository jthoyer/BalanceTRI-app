#!/bin/sh
# Rebuilds assets/common-passwords.txt, the list the join and set-password
# forms check new passwords against (P3). Run it from the repository root:
#
#   sh scripts/build-common-passwords.sh
#
# Source: SecLists, Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt,
# by Daniel Miessler and contributors, MIT licence. https://github.com/danielmiessler/SecLists
# Pinned to one commit, and the download must match the sha256 below, so the
# list can't change under us. To move to a newer list, change both together.
#
# The source is ordered most common first. Passwords under 12 characters are
# already refused by length, so only entries of 12 to 72 characters are kept,
# lower-cased (the check ignores case) and de-duplicated, and the first 10,000
# of those are the list.
set -eu
COMMIT=04a690dde43143a3b2a6733317c0916e21d85cde
FILE=xato-net-10-million-passwords-1000000.txt
SHA256=424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51
KEEP=10000
SOURCE_URL="https://raw.githubusercontent.com/danielmiessler/SecLists/$COMMIT/Passwords/Common-Credentials/$FILE"
OUT=assets/common-passwords.txt
RAW=$(mktemp)
TMP=$(mktemp)
trap 'rm -f "$RAW" "$TMP"' EXIT
curl -fsS "$SOURCE_URL" -o "$RAW"
echo "$SHA256  $RAW" | sha256sum -c - >/dev/null || { echo "sha256 mismatch for $SOURCE_URL" >&2; exit 1; }
tr -d '\r' < "$RAW" |
  awk -v keep="$KEEP" '{ s = tolower($0); n = length(s); if (n >= 12 && n <= 72 && !(s in seen)) { seen[s] = 1; print s; if (++c == keep) exit } }' > "$TMP"
{
  echo "# Common passwords of 12 to 72 characters, lower-cased, most common first, one per line."
  echo "# Source: $SOURCE_URL"
  echo "# SecLists commit $COMMIT, $FILE (sha256 $SHA256)."
  echo "# SecLists by Daniel Miessler and contributors, MIT licence."
  echo "# Regenerate with: sh scripts/build-common-passwords.sh"
  cat "$TMP"
} > "$OUT"
echo "$(grep -vc '^#' "$OUT") entries written to $OUT"
