#!/bin/bash
# enshrouded-debug.sh - switch verbose Proton/Wine logging for enshrouded.service on or off.
#
# Runs ON THE BOX as root (deliver over SSM Run Command, like deploy-game-server.sh). The base
# unit sets WINEDEBUG=-all, which hides even errors: a server that dies at launch leaves nothing
# to read. This writes a systemd DROP-IN, so the base unit (and its shutdown contract) is never
# edited and verbose logging is never permanent:
#
#   enshrouded-debug.sh on      write /etc/systemd/system/enshrouded.service.d/debug.conf, daemon-reload
#   enshrouded-debug.sh off     remove it, daemon-reload
#   enshrouded-debug.sh status  show whether it is present
#
# It NEVER starts, stops or restarts the game: the drop-in applies on the next start. Restart
# deliberately (and only when no one is playing). Proton writes steam-<appid>.log into
# PROTON_LOG_DIR; with WINEDEBUG=+err,+loaddll,+seh the log is large - turn this off afterwards.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"

DROPIN_DIR="/etc/systemd/system/enshrouded.service.d"
DROPIN="${DROPIN_DIR}/debug.conf"
LOG_DIR="/srv/enshrouded/logs"

die() { echo "[enshrouded-debug] FATAL: $*" >&2; exit 1; }
log() { echo "[enshrouded-debug] $*"; }

[ "$(id -u)" -eq 0 ] || die "must run as root"

case "${1:-}" in
  on)
    install -d -m 0755 "$DROPIN_DIR"
    tmp="$(mktemp)"
    cat > "$tmp" <<'DEBUG_EOF'
# Written by enshrouded-debug.sh. TEMPORARY: remove with `enshrouded-debug.sh off`.
[Service]
Environment=PROTON_LOG=1
Environment=PROTON_LOG_DIR=/srv/enshrouded/logs
# Later assignment of the same variable wins over the base unit's WINEDEBUG=-all.
Environment=WINEDEBUG=+err,+loaddll,+seh
DEBUG_EOF
    install -m 0644 "$tmp" "$DROPIN"
    rm -f "$tmp"
    systemctl daemon-reload
    log "debug logging ON via ${DROPIN}; applies on the NEXT start of enshrouded.service (nothing was restarted)"
    log "Proton log lands in ${LOG_DIR}; remember to run: $0 off"
    ;;
  off)
    rm -f "$DROPIN"
    rmdir "$DROPIN_DIR" 2>/dev/null || true
    systemctl daemon-reload
    log "debug logging OFF (drop-in removed); applies on the NEXT start of enshrouded.service"
    ;;
  status)
    if [ -f "$DROPIN" ]; then
      log "debug drop-in PRESENT:"
      cat "$DROPIN"
    else
      log "debug drop-in absent (WINEDEBUG=-all from the base unit applies)"
    fi
    ;;
  *)
    die "usage: $0 on|off|status"
    ;;
esac
