#!/usr/bin/env bash
# Extracts the shell scripts that provision-host.sh embeds as quoted heredocs
# (stop-game.sh, update-game.sh) so CI can shellcheck them. They are the
# data-loss-critical ones and would otherwise be invisible to a *.sh glob.
# Usage: extract-embedded-scripts.sh <out-dir>
set -euo pipefail
out="${1:?usage: extract-embedded-scripts.sh <out-dir>}"
src="infrastructure/scripts/provision-host.sh"
mkdir -p "$out"

# Matches:  write_if_changed /path/to/NAME.sh 0755 <<'TAG'   ...body...   TAG
awk -v out="$out" '
  match($0, /write_if_changed [^ ]+\.sh [0-9]+ <<'"'"'[A-Z_]+'"'"'/) {
    split($2, p, "/"); name = p[length(p)]
    tag = $0; sub(/.*<<'"'"'/, "", tag); sub(/'"'"'.*/, "", tag)
    file = out "/" name; capturing = 1; next
  }
  capturing && $0 == tag { capturing = 0; close(file); next }
  capturing { print > file }
' "$src"

count="$(find "$out" -name '*.sh' | wc -l)"
if [ "$count" -lt 2 ]; then
  echo "expected >=2 embedded scripts (stop-game.sh, update-game.sh), found $count" >&2
  exit 1
fi
for want in stop-game.sh update-game.sh; do
  [ -s "$out/$want" ] || { echo "missing embedded script: $want" >&2; exit 1; }
done
find "$out" -name '*.sh' -print
