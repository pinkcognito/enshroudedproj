#!/bin/bash
# run-game-deploy.sh - CI-side driver for the game deploy (WP-06). Called by
# .github/workflows/deploy-game-server.yml; kept as a script (not inline YAML) so the
# maintenance-mode guarantee can be exercised by tests.
#
# Per ARCHITECTURE 6.6.2 the deploy WORKFLOW owns /enshroudedproj/state/maintenance-mode (its
# role has PutParameter on that one parameter; the instance role has no SSM write at all).
# Maintenance mode is set before the deploy and cleared by an EXIT trap, so success, failure,
# a failed SSM command, ^C and SIGTERM (workflow cancel) all clear it.
#
# Two SSM commands, in order, inside that one maintenance window:
#   1. provision-host.sh       (idempotent: volume format guard, mount, Proton, units, ...)
#   2. deploy-game-server.sh   (assumes 1 has run; refuses to deploy onto the root volume)
# Provisioning runs on EVERY deploy. It is idempotent by design, so this is self-healing: a
# replaced instance provisions itself on the next deploy with no "did you remember" step.
# They are sent as SEPARATE commands, not concatenated: each is a complete bash program with
# its own set -euo pipefail, helpers and exit calls, and separate invocations keep errors
# attributable. If provisioning fails the game deploy is never attempted.
#
# Nothing secret is handled here: the script only ships the on-box scripts plus the config
# TEMPLATE (placeholders only, deploy phase only) and prints the on-box output.
# Rendering happens on the box.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${AWS_REGION:-us-east-2}"
INSTANCE_ID="${ENSHROUDED_INSTANCE_ID:?ENSHROUDED_INSTANCE_ID is required}"
MAINT_PARAM="/enshroudedproj/state/maintenance-mode"
POLL_SECONDS="${POLL_SECONDS:-10}"
MAX_POLLS="${MAX_POLLS:-180}"            # floor only; the real budget is derived per phase
# Headroom past a phase's executionTimeout, so SSM reports TimedOut before we stop polling.
POLL_GRACE="${POLL_GRACE:-300}"
PROVISION_SCRIPT="${PROVISION_SCRIPT:-${HERE}/provision-host.sh}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-${HERE}/deploy-game-server.sh}"
# Provisioning installs packages, SteamCMD and a ~500 MB GE-Proton tarball on a fresh box
# (minutes, longer if apt is slow), so it gets a generous cap: 1500s. That is deliberately
# under the default poll window (MAX_POLLS x POLL_SECONDS = 1800s) so a hung provision is
# reported by SSM as TimedOut rather than by this driver giving up while it still runs, and
# it bounds how long idle shutdown stays disabled. The deploy keeps its 3000s.
PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-1500}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-3000}"
TEMPLATE="${CONFIG_TEMPLATE:-${HERE}/../config/enshrouded_server.json.tmpl}"
# First-format acknowledgement (ARCHITECTURE 8.2): a PASS-THROUGH only. This driver never sets or
# defaults it; an operator supplies it (workflow input allow_first_format) naming the exact
# volume, e.g. vol-0142d5163b94a5e53, and only the provisioning phase receives it. It is not a
# boolean and not a secret. Anything that is not a volume id is rejected before it is shipped,
# which also keeps the value safe to place inside the shell export line below.
FIRST_FORMAT_ACK="${ENSHROUDED_ALLOW_FIRST_FORMAT:-}"
if [ -n "$FIRST_FORMAT_ACK" ] && ! [[ "$FIRST_FORMAT_ACK" =~ ^vol-[0-9a-f]+$ ]]; then
  echo "[run-game-deploy] FATAL: allow_first_format must be a volume id such as vol-0123456789abcdef0 (or empty); got a value that is not" >&2
  exit 1
fi

log() { echo "[run-game-deploy] $*"; }

set_maintenance() {   # set_maintenance true|false
  aws ssm put-parameter --region "$REGION" --name "$MAINT_PARAM" --type String \
    --value "$1" --overwrite >/dev/null
}

MAINT_SET=0
PARAMS_FILE=""
cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "$PARAMS_FILE" ]; then rm -f "$PARAMS_FILE"; fi
  if [ "$MAINT_SET" -eq 1 ]; then
    local cleared=0
    for _ in 1 2 3; do
      if set_maintenance false; then cleared=1; break; fi
      sleep "$POLL_SECONDS"
    done
    if [ "$cleared" -eq 1 ]; then
      log "maintenance mode cleared"
    else
      echo "[run-game-deploy] FATAL: could not clear maintenance mode; idle shutdown stays DISABLED until ${MAINT_PARAM} is set to false" >&2
      [ "$rc" -ne 0 ] || rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Armed BEFORE the write: if put-parameter half-succeeds and errors, we still clear.
MAINT_SET=1
log "setting maintenance mode"
set_maintenance true

# run_phase LABEL SCRIPT TIMEOUT_SECONDS BUNDLE_TEMPLATE(0|1) [BUNDLE_FIRST_FORMAT_ACK(0|1)]
# Ships one on-box script via SSM Run Command, polls it, echoes its stdout/stderr.
# Returns non-zero on any failure. Every step uses an explicit `|| return 1`: callers invoke
# this in an `||` context where `set -e` is suspended inside the function.
run_phase() {
  local label="$1" script="$2" timeout="$3" bundle_template="$4" bundle_ack="${5:-0}"
  local cmd_id status
  log "=== phase: ${label} ==="
  if [ -n "$PARAMS_FILE" ]; then rm -f "$PARAMS_FILE"; fi   # previous phase's payload
  PARAMS_FILE="$(mktemp)" || return 1
  {
    echo '#!/bin/bash'   # SSM would otherwise run the document with sh
    if [ "$bundle_template" = "1" ]; then
      # The template is base64 (placeholders only, no secrets).
      echo "export ENSHROUDED_CONFIG_TEMPLATE_B64='$(base64 < "$TEMPLATE" | tr -d '\n')'"
    fi
    if [ "$bundle_ack" = "1" ] && [ -n "$FIRST_FORMAT_ACK" ]; then
      # Validated above as ^vol-[0-9a-f]+$, so single-quoting is safe.
      echo "export ENSHROUDED_ALLOW_FIRST_FORMAT='${FIRST_FORMAT_ACK}'"
    fi
    cat "$script"
  } | python3 -c '
import json, sys
print(json.dumps({"commands": [sys.stdin.read()], "executionTimeout": [sys.argv[1]]}))
' "$timeout" > "$PARAMS_FILE" || return 1

  log "sending ${label} to the game instance via SSM Run Command"
  cmd_id="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --comment "enshrouded game ${label}" \
    --parameters "file://${PARAMS_FILE}" --query Command.CommandId --output text)" || return 1

  # Derive the poll budget FROM this phase's timeout instead of a fixed MAX_POLLS.
  # A fixed window silently went stale: DEPLOY_TIMEOUT=3000s against a 1800s window
  # meant a slow deploy (the Enshrouded depot is ~13 GiB) would be declared failed
  # while SSM was still running it - and worse, the EXIT trap would clear maintenance
  # mode mid-install, so idle shutdown could stop the box partway through. Deriving it
  # means the window always exceeds the timeout, whatever anyone sets the timeout to.
  # Guard the divisor: tests (and anyone tuning for speed) set POLL_SECONDS=0, which
  # would otherwise be a division-by-zero at runtime.
  _interval="$POLL_SECONDS"; [ "$_interval" -gt 0 ] 2>/dev/null || _interval=1
  polls=$(( (timeout + POLL_GRACE) / _interval ))
  [ "$polls" -lt "$MAX_POLLS" ] && polls="$MAX_POLLS"

  status="Pending"
  for _ in $(seq 1 "$polls"); do
    status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" \
      --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in
      Success|Failed|TimedOut|Cancelled|Cancelling) break ;;
    esac
    sleep "$POLL_SECONDS"
  done

  # The on-box scripts never print a secret, so their output is safe to show in the CI log.
  echo "----- on-box stdout (${label}) -----"
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
    --query StandardOutputContent --output text || true
  echo "----- on-box stderr (${label}) -----"
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
    --query StandardErrorContent --output text || true

  if [ "$status" != "Success" ]; then
    echo "[run-game-deploy] ${label} SSM command finished with status ${status}" >&2
    return 1
  fi
  log "${label} succeeded"
}

if ! run_phase provisioning "$PROVISION_SCRIPT" "$PROVISION_TIMEOUT" 0 1; then
  echo "[run-game-deploy] FATAL: provisioning phase FAILED; the game deploy phase was NOT attempted" >&2
  exit 1
fi
if ! run_phase "game deploy" "$DEPLOY_SCRIPT" "$DEPLOY_TIMEOUT" 1; then
  echo "[run-game-deploy] FATAL: game deploy phase FAILED (provisioning had succeeded)" >&2
  exit 1
fi
log "provisioning and game deploy both succeeded"
