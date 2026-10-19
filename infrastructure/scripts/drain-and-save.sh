#!/bin/bash
# drain-and-save.sh - on-box half of graceful-stop (WP-09, ARCHITECTURE 3.2 steps 11-13). Data-loss critical.
#
#   drain-and-save.sh stop   snapshot savegame/, stop the game unit via systemctl, print FACTS.
#   drain-and-save.sh sync   `aws s3 sync` savegame/ to the backup bucket (no --delete).
#
# This script MEASURES; it does not decide. The PASS/FAIL verdict (ARCHITECTURE 3.2 step 12b table)
# lives in the graceful-stop Lambda, which holds the other two inputs (the last-active SSM parameter
# and the instance LaunchTime). `stop` therefore exits 0 whenever it produced facts, even if the unit
# ended in a non-success state: a clean SIGINT exit can legitimately be Result=exit-code or
# Result=signal, and exiting non-zero for that would wedge every normal shutdown.
#
# The stop itself is `systemctl stop`: the unit's ExecStop (stop-game.sh) does the SIGINT-to-one-PID
# and the wait. Nothing here signals the game or waits for it.
#
# WALL-CLOCK RULE: the only times used are `date` and file mtimes. Game-log timestamps are
# uptime-relative and are never read, parsed or compared.
set -uo pipefail

UNIT=enshrouded.service
SAVE_DIR=/srv/enshrouded/savegame
GAME_COMM=enshrouded_serv

# "<count> <newest mtime, fractional epoch seconds, or 0>" over regular files in savegame/.
snapshot() {
  find "$SAVE_DIR" -type f -printf '%T@\n' 2>/dev/null | sort -n | awk '
    { n++; newest = $1 }
    END { printf "%d %s\n", n, (n ? newest : 0) }'
}

mode="${1:-}"
case "$mode" in
  stop)
    mountpoint -q /srv/enshrouded || { echo "drain: /srv/enshrouded is not mounted; refusing" >&2; exit 1; }
    [ -d "$SAVE_DIR" ] || { echo "drain: $SAVE_DIR does not exist; refusing" >&2; exit 1; }
    t0="$(date +%s.%N)"
    read -r pre_count pre_newest < <(snapshot)
    systemctl stop "$UNIT"
    stop_rc=$?
    read -r post_count post_newest < <(snapshot)
    active_state="$(systemctl show "$UNIT" -p ActiveState --value 2>/dev/null)"
    result="$(systemctl show "$UNIT" -p Result --value 2>/dev/null)"
    exec_code="$(systemctl show "$UNIT" -p ExecMainCode --value 2>/dev/null)"
    exec_status="$(systemctl show "$UNIT" -p ExecMainStatus --value 2>/dev/null)"
    game_pids="$(pgrep -x "$GAME_COMM" 2>/dev/null | wc -l | tr -d ' ')"
    echo "DRAIN_T0=$t0"
    echo "DRAIN_PRE_COUNT=$pre_count"
    echo "DRAIN_PRE_NEWEST=$pre_newest"
    echo "DRAIN_POST_COUNT=$post_count"
    echo "DRAIN_POST_NEWEST=$post_newest"
    echo "DRAIN_STOP_RC=$stop_rc"
    echo "DRAIN_ACTIVE_STATE=$active_state"
    echo "DRAIN_RESULT=$result"
    echo "DRAIN_EXEC_MAIN_CODE=$exec_code"
    echo "DRAIN_EXEC_MAIN_STATUS=$exec_status"
    echo "DRAIN_GAME_PIDS=$game_pids"
    echo "DRAIN_DONE=1"
    exit 0
    ;;
  sync)
    mountpoint -q /srv/enshrouded || { echo "drain: /srv/enshrouded is not mounted; refusing" >&2; exit 1; }
    # Never copy a save the game might still be writing.
    if [ "$(pgrep -x "$GAME_COMM" 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
      echo "drain: game process still running; refusing to sync" >&2
      exit 1
    fi
    TOKEN="$(curl -fsS -m 5 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
    REGION="$(curl -fsS -m 5 -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/placement/region || true)"
    REGION="${REGION:-us-east-2}"
    if [ -z "$(ls -A "$SAVE_DIR" 2>/dev/null)" ]; then
      echo "DRAIN_SYNC=empty-nothing-to-copy"
      exit 0
    fi
    bucket="$(aws ssm get-parameter --region "$REGION" --name /enshroudedproj/server/backup-bucket --query Parameter.Value --output text)" \
      || { echo "drain: cannot read backup-bucket parameter" >&2; exit 1; }
    # Whole savegame/ tree (every numbered copy plus the -index pointer; section 8). No --delete.
    aws s3 sync --region "$REGION" --only-show-errors "$SAVE_DIR/" "s3://${bucket}/savegame/" \
      || { echo "drain: s3 sync failed" >&2; exit 1; }
    echo "DRAIN_SYNC=ok"
    exit 0
    ;;
  *)
    echo "usage: drain-and-save.sh stop|sync" >&2
    exit 2
    ;;
esac
