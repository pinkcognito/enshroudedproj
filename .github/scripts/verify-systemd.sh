#!/usr/bin/env bash
# Runs `systemd-analyze verify` over infrastructure/systemd/*.service and fails on anything unexpected.
#
# The runner is not the game host, so exactly three "Command ... is not executable: No such file or
# directory" lines are EXPECTED (the binaries only exist after provision-host.sh has run on the host):
#   - the GE-Proton `proton` launcher
#   - /usr/local/lib/enshrouded/stop-game.sh   (written by provision-host.sh)
#   - /usr/local/lib/enshrouded/update-game.sh (written by provision-host.sh)
# Those are filtered by exact path. Everything else - unknown directives, bad values, dependency
# cycles - is an error. This is deliberately NOT a blanket ignore.
set -uo pipefail

src="${1:-infrastructure/systemd}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$src"/*.service "$work"/
chmod 0644 "$work"/*.service   # avoid "marked executable / world-writable" noise from checkouts

cd "$work" || exit 2
out="$(systemd-analyze verify --man=no ./*.service 2>&1)"
rc=$?

expected='^(enshrouded|enshrouded-update)\.service: Command (/opt/steamcmd/compatibilitytools\.d/GE-Proton[0-9A-Za-z._-]*/proton|/usr/local/lib/enshrouded/(stop|update)-game\.sh) is not executable: No such file or directory$'
unexpected="$(printf '%s\n' "$out" | grep -Ev "$expected" | grep -v '^$' || true)"

echo "--- systemd-analyze verify (raw, rc=$rc) ---"
printf '%s\n' "$out"
echo "--- end ---"

# rc is NOT used: systemd-analyze exits 1 whenever it prints the (expected) missing-binary notices,
# so the filtered output is the only reliable signal.
if [ -n "$unexpected" ]; then
  echo "systemd unit verification FAILED. Unexpected output:" >&2
  printf '%s\n' "$unexpected" >&2
  exit 1
fi
echo "systemd units OK (only the 3 expected missing-binary notices were filtered)"
