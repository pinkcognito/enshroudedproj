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
# Nothing secret is handled here: the script only ships the on-box script plus the config
# TEMPLATE (placeholders only) and prints the on-box output. Rendering happens on the box.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${AWS_REGION:-us-east-2}"
INSTANCE_ID="${ENSHROUDED_INSTANCE_ID:?ENSHROUDED_INSTANCE_ID is required}"
MAINT_PARAM="/enshroudedproj/state/maintenance-mode"
POLL_SECONDS="${POLL_SECONDS:-10}"
MAX_POLLS="${MAX_POLLS:-180}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-${HERE}/deploy-game-server.sh}"
TEMPLATE="${CONFIG_TEMPLATE:-${HERE}/../config/enshrouded_server.json.tmpl}"

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

# Bundle: env + the deploy script. The template is base64 (placeholders only, no secrets).
PARAMS_FILE="$(mktemp)"
{
  echo '#!/bin/bash'   # SSM would otherwise run the document with sh
  echo "export ENSHROUDED_CONFIG_TEMPLATE_B64='$(base64 < "$TEMPLATE" | tr -d '\n')'"
  cat "$DEPLOY_SCRIPT"
} | python3 -c '
import json, sys
print(json.dumps({"commands": [sys.stdin.read()], "executionTimeout": ["3000"]}))
' > "$PARAMS_FILE"

log "sending deploy to the game instance via SSM Run Command"
CMD_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --comment "enshrouded game deploy" \
  --parameters "file://${PARAMS_FILE}" --query Command.CommandId --output text)"

STATUS="Pending"
for _ in $(seq 1 "$MAX_POLLS"); do
  STATUS="$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" \
    --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in
    Success|Failed|TimedOut|Cancelled|Cancelling) break ;;
  esac
  sleep "$POLL_SECONDS"
done

# The on-box script never prints a secret, so its output is safe to show in the CI log.
echo "----- on-box stdout -----"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent --output text || true
echo "----- on-box stderr -----"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query StandardErrorContent --output text || true

if [ "$STATUS" != "Success" ]; then
  echo "[run-game-deploy] FATAL: SSM command finished with status ${STATUS}" >&2
  exit 1
fi
log "deploy succeeded"
