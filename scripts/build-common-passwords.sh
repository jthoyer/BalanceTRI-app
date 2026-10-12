#!/bin/sh
# Rebuilds assets/common-passwords.txt, the list the join and set-password
# forms check new passwords against (P3). Run it from the repository root:
#
#   sh scripts/build-common-passwords.sh
#
# Source: SecLists, Passwords/Common-Credentials/10k-most-common.txt, by Daniel
# Miessler and contributors, MIT licence. https://github.com/danielmiessler/SecLists
# To use a bigger list, point SOURCE_URL at another file in that repository.
#
# Passwords under 12 characters are already refused by length, so only entries
# of 12 to 72 characters are kept. They are lower-cased (the check ignores
# case) and de-duplicated.
set -eu
SOURCE_URL="${SOURCE_URL:-https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10k-most-common.txt}"
OUT=assets/common-passwords.txt
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsS "$SOURCE_URL" | tr -d '\r' |
  awk '{ s = tolower($0); n = length(s); if (n >= 12 && n <= 72 && !(s in seen)) { seen[s] = 1; print s } }' > "$TMP"
{
  echo "# Common passwords of 12 to 72 characters, lower-cased, one per line."
  echo "# Source: $SOURCE_URL"
  echo "# SecLists by Daniel Miessler and contributors, MIT licence."
  echo "# Regenerate with: sh scripts/build-common-passwords.sh"
  cat "$TMP"
} > "$OUT"
echo "$(grep -vc '^#' "$OUT") entries written to $OUT"
