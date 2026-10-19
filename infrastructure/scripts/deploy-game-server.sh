#!/bin/bash
# deploy-game-server.sh - install/update the Enshrouded server and render its config (WP-06).
#
# Runs ON THE BOX as root, delivered over SSM Run Command by scripts/run-game-deploy.sh (the
# deploy workflow). Architecture refs: section 7 (install, config, update), 6.6 (SSM namespace),
# 8 (pre-update backup).
#
# Rules this script keeps:
#   * SSM is read only by render-config.sh (/enshroudedproj/server ONLY). The instance role cannot
#     read anything else and has no SSM write, so maintenance mode is NOT touched here - the
#     workflow owns it.
#   * No secret value is ever echoed, logged, put in argv or traced (never `set -x`). Secrets
#     travel SSM -> pipe -> python3 -> a 0600 file inside render-config.sh, and nothing else.
#   * The config is validated and staged BEFORE the running game is stopped, so a bad parameter
#     fails the deploy with zero downtime.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"

GAME_USER="enshrouded"
INSTALL_DIR="/srv/enshrouded"
STEAMCMD="/opt/steamcmd/steamcmd.sh"
CONFIG_NAME="enshrouded_server.json"
RENDER_SH="${ENSHROUDED_RENDER_SCRIPT:-/usr/local/lib/enshrouded/render-config.sh}"
TEMPLATE_DEST="${ENSHROUDED_TEMPLATE_DEST:-/usr/local/lib/enshrouded/enshrouded_server.json.tmpl}"
UPDATE_HELPER="/usr/local/lib/enshrouded/update-game.sh"
QUERY_PORT=15637
READY_TIMEOUT="${ENSHROUDED_READY_TIMEOUT:-300}"
# The config template is delivered by the workflow (base64) or, for local use, as a file path.
TEMPLATE_B64="${ENSHROUDED_CONFIG_TEMPLATE_B64:-}"
TEMPLATE_FILE="${ENSHROUDED_CONFIG_TEMPLATE:-}"

log()  { echo "[deploy-game-server] $*"; }
warn() { echo "[deploy-game-server] WARNING: $*" >&2; }
die()  { echo "[deploy-game-server] FATAL: $*" >&2; exit 1; }

# Rendering is NOT done here. There is exactly one renderer, /usr/local/lib/enshrouded/render-config.sh
# (ARCHITECTURE 7.3.3), shared with enshrouded-config.service, which re-renders from SSM on every
# activation of the game unit. A second copy of the render logic here would let "no empty password may
# render" quietly stop being true in one of the two places.
#
# The renderer reads its template from ONE on-box path. This deploy receives its template from the
# workflow, so it installs that template at the canonical path BEFORE rendering. Otherwise the boot
# render (which has no workflow to hand it a template) would overwrite a just-deployed config using an
# older on-box template. Both paths then read the same template and the same SSM values, which makes
# re-rendering idempotent - what makes RemainAfterExit=no on enshrouded-config.service safe here.

# install_template <src>: validate it is JSON, then atomically replace the canonical on-box template.
# The template holds only ${TOKEN} placeholders, never a secret (mode 0644).
install_template() {
  local src="$1" tmp
  python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$src" \
    || { warn "config template is not valid JSON"; return 1; }
  mkdir -p "$(dirname "$TEMPLATE_DEST")"
  tmp="$(mktemp "${TEMPLATE_DEST}.XXXXXX")"
  # Explicit if, not A && B || C: shellcheck SC2015 correctly flags that form as ambiguous even
  # where the intent ("on any failure, clean up and fail") happens to be right.
  if ! { cat "$src" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$TEMPLATE_DEST"; }; then
    rm -f "$tmp"
    return 1
  fi
}

# fetch_and_render <out>   (the template is whatever install_template put at TEMPLATE_DEST)
fetch_and_render() {
  ENSHROUDED_TEMPLATE="$TEMPLATE_DEST" "$RENDER_SH" "$1"
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
  [ -x "$RENDER_SH" ] || die "$RENDER_SH missing (run provision-host.sh first)"
  trap cleanup EXIT

  if [ -z "$TEMPLATE_FILE" ]; then
    [ -n "$TEMPLATE_B64" ] || die "no config template supplied"
    TEMPLATE_TMP="$(mktemp)"
    printf '%s' "$TEMPLATE_B64" | base64 -d > "$TEMPLATE_TMP"
    TEMPLATE_FILE="$TEMPLATE_TMP"
  fi

  log "installing the config template at ${TEMPLATE_DEST} (before rendering, so no boot render can use a stale one)"
  install_template "$TEMPLATE_FILE" || die "could not install the config template"

  log "validating parameters and staging the config (game untouched)"
  STAGED="$(mktemp -u "${INSTALL_DIR}/.${CONFIG_NAME}.XXXXXX")"
  fetch_and_render "$STAGED" \
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
