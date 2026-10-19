#!/bin/bash
# deploy-game-server.sh - install/update the Enshrouded server and render its config (WP-06).
#
# Runs ON THE BOX as root, delivered over SSM Run Command by scripts/run-game-deploy.sh (the
# deploy workflow). Architecture refs: section 7 (install, config, update), 6.6 (SSM namespace),
# 8 (pre-update backup).
#
# Rules this script keeps:
#   * It reads SSM under /enshroudedproj/server ONLY. The instance role cannot read anything else
#     and has no SSM write, so maintenance mode is NOT touched here - the workflow owns it.
#   * No secret value is ever echoed, logged, put in argv or traced (never `set -x`). Secrets
#     travel SSM -> pipe -> python3 -> a 0600 file, and nothing else.
#   * The config is validated and staged BEFORE the running game is stopped, so a bad parameter
#     fails the deploy with zero downtime.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"

GAME_USER="enshrouded"
INSTALL_DIR="/srv/enshrouded"
STEAMCMD="/opt/steamcmd/steamcmd.sh"
CONFIG_NAME="enshrouded_server.json"
SSM_PREFIX="/enshroudedproj/server"
UPDATE_HELPER="/usr/local/lib/enshrouded/update-game.sh"
QUERY_PORT=15637
READY_TIMEOUT="${ENSHROUDED_READY_TIMEOUT:-300}"
# The config template is delivered by the workflow (base64) or, for local use, as a file path.
TEMPLATE_B64="${ENSHROUDED_CONFIG_TEMPLATE_B64:-}"
TEMPLATE_FILE="${ENSHROUDED_CONFIG_TEMPLATE:-}"

log()  { echo "[deploy-game-server] $*"; }
warn() { echo "[deploy-game-server] WARNING: $*" >&2; }
die()  { echo "[deploy-game-server] FATAL: $*" >&2; exit 1; }

# Validates the parameters, substitutes them into the template and writes the result with mode
# 0600 from the first byte (python opens it O_EXCL with 0600). The SSM response arrives on stdin
# and is never printed; errors name the parameter, never its value. Whole-string "${TOKEN}"
# values only, so a password containing quotes or backslashes is JSON-escaped correctly.
# shellcheck disable=SC2016  # deliberate: this is Python source, not shell; nothing here should expand
RENDER_PY='
import json, os, re, sys

template_path, out_path = sys.argv[1], sys.argv[2]
prefix = "/enshroudedproj/server/"
MAX_SLOTS = 16  # hard game cap
want = {  # template token -> SSM parameter (under server/ only)
    "SERVER_NAME": "name",
    "SLOT_COUNT": "slot-count",
    "ADMIN_PASSWORD": "user-groups/admin-password",
    "FRIEND_PASSWORD": "user-groups/friend-password",
    "GUEST_PASSWORD": "user-groups/guest-password",
    "VISITOR_PASSWORD": "user-groups/visitor-password",
}
have = {p["Name"]: p["Value"] for p in json.load(sys.stdin).get("Parameters", [])}
vals = {}
for token, suffix in want.items():
    v = have.get(prefix + suffix, "")
    if v == "":
        sys.exit("parameter %s%s is missing or empty" % (prefix, suffix))
    vals[token] = v
if not re.fullmatch(r"[0-9]{1,3}", vals["SLOT_COUNT"]) or not 1 <= int(vals["SLOT_COUNT"]) <= MAX_SLOTS:
    sys.exit("slot-count must be an integer from 1 to %d" % MAX_SLOTS)
vals["SLOT_COUNT"] = int(vals["SLOT_COUNT"])
for token in ("ADMIN_PASSWORD", "FRIEND_PASSWORD", "GUEST_PASSWORD", "VISITOR_PASSWORD"):
    if len(vals[token]) < 4:
        sys.exit("parameter for %s is too short" % token)

token_re = re.compile(r"^\$\{([A-Z_]+)\}$")
def fill(node):
    if isinstance(node, dict):
        return {k: fill(v) for k, v in node.items()}
    if isinstance(node, list):
        return [fill(v) for v in node]
    if isinstance(node, str):
        m = token_re.match(node)
        if m:
            if m.group(1) not in vals:
                sys.exit("template uses unknown placeholder %s" % m.group(1))
            return vals[m.group(1)]
        if "${" in node:
            sys.exit("template has a partial placeholder; use whole-string tokens only")
    return node

with open(template_path, encoding="utf-8") as f:
    out = fill(json.load(f))
fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
'

# fetch_and_render <template> <out>   (out must not exist)
fetch_and_render() {
  local template="$1" out="$2" region
  region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
  # server/ namespace only (section 6.6). The pipe keeps the decrypted values off disk and argv.
  aws ssm get-parameters-by-path --region "$region" --path "$SSM_PREFIX" --recursive \
      --with-decryption --output json \
    | python3 -c "$RENDER_PY" "$template" "$out"
}

STAGED=""
TEMPLATE_TMP=""
WE_STOPPED_GAME=0
cleanup() {
  local rc=$?
  trap - EXIT
  [ -z "$STAGED" ] || rm -f "$STAGED"
  [ -z "$TEMPLATE_TMP" ] || rm -f "$TEMPLATE_TMP"
  # If we stopped the game and are failing, put the previous build back up rather than leave
  # the server down. Best effort; the deploy still exits non-zero.
  if [ "$rc" -ne 0 ] && [ "$WE_STOPPED_GAME" -eq 1 ]; then
    warn "deploy failed after stopping the game; attempting to start it again"
    systemctl start enshrouded.service || warn "could not restart enshrouded.service"
  fi
  exit "$rc"
}

as_game_user() { runuser -u "$GAME_USER" -- env "HOME=/home/${GAME_USER}" "$@"; }

run_steamcmd() {
  # +@sSteamCmdForcePlatformType windows is MANDATORY: app 2278520 has no Linux depot (we fetch
  # the Windows depot and run it under GE-Proton). Omitting it does NOT fail loudly - steamcmd
  # reports nothing to download and leaves an empty install dir.
  as_game_user "$STEAMCMD" \
    +@sSteamCmdForcePlatformType windows \
    +force_install_dir "$INSTALL_DIR" \
    +login anonymous \
    +app_update 2278520 validate \
    +quit
}

wait_ready() {
  for _ in $(seq 1 "$READY_TIMEOUT"); do
    # Restart=no, so a failed unit stays failed: waiting out the full timeout cannot help.
    if systemctl is-failed --quiet enshrouded.service; then
      warn "enshrouded.service has FAILED; aborting the readiness wait early. Last journal lines:"
      journalctl -u enshrouded -n 30 --no-pager >&2 || true
      return 1
    fi
    if systemctl is-active --quiet enshrouded.service \
       && pgrep -f '[e]nshrouded_server\.exe' >/dev/null 2>&1 \
       && ss -H -uln "sport = :${QUERY_PORT}" 2>/dev/null | grep -q .; then
      log "game is up (unit active, process running, UDP ${QUERY_PORT} bound)"
      return 0
    fi
    sleep 1
  done
  return 1
}

main() {
  [ "$(id -u)" -eq 0 ] || die "must run as root"
  mountpoint -q "$INSTALL_DIR" || die "$INSTALL_DIR is not mounted; refusing to deploy onto the root volume"
  [ -x "$STEAMCMD" ] || die "steamcmd not installed (run provision-host.sh first)"
  [ -x "$UPDATE_HELPER" ] || die "$UPDATE_HELPER missing (run provision-host.sh first)"
  trap cleanup EXIT

  if [ -z "$TEMPLATE_FILE" ]; then
    [ -n "$TEMPLATE_B64" ] || die "no config template supplied"
    TEMPLATE_TMP="$(mktemp)"
    printf '%s' "$TEMPLATE_B64" | base64 -d > "$TEMPLATE_TMP"
    TEMPLATE_FILE="$TEMPLATE_TMP"
  fi

  log "validating parameters and staging the config (game untouched)"
  STAGED="$(mktemp -u "${INSTALL_DIR}/.${CONFIG_NAME}.XXXXXX")"
  fetch_and_render "$TEMPLATE_FILE" "$STAGED" \
    || die "config rendering failed (parameter name given above; values are never printed)"
  chown "${GAME_USER}:${GAME_USER}" "$STAGED"
  chmod 600 "$STAGED"

  log "pre-update savegame backup"
  "$UPDATE_HELPER" --backup-only

  if systemctl is-active --quiet enshrouded.service; then
    log "stopping enshrouded.service (graceful: SIGINT + wait via ExecStop)"
    WE_STOPPED_GAME=1
    systemctl stop enshrouded.service
  fi

  log "installing/updating app 2278520 via steamcmd (Windows depot)"
  run_steamcmd || { warn "steamcmd failed; retrying once"; run_steamcmd; } || die "steamcmd failed"
  [ -f "${INSTALL_DIR}/enshrouded_server.exe" ] \
    || die "enshrouded_server.exe is missing after install (was the platform flag dropped?)"

  mv -f "$STAGED" "${INSTALL_DIR}/${CONFIG_NAME}"
  STAGED=""
  chown "${GAME_USER}:${GAME_USER}" "${INSTALL_DIR}/${CONFIG_NAME}"
  chmod 600 "${INSTALL_DIR}/${CONFIG_NAME}"
  log "config installed (mode 600, owner ${GAME_USER})"

  log "starting enshrouded.service"
  systemctl start enshrouded.service
  WE_STOPPED_GAME=0
  wait_ready || die "game did not become ready (unit failed, or not up within ${READY_TIMEOUT}s; see journal above / journalctl -u enshrouded.service)"
  log "deploy complete"
}

# Sourceable for tests: only run when executed.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
