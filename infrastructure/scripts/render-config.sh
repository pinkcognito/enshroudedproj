#!/bin/bash
# render-config.sh - the ONE renderer for enshrouded_server.json (WP-22, ARCHITECTURE 7.3, invariant 1.12).
#
#   render-config.sh <output-path>
#
# Installed at /usr/local/lib/enshrouded/render-config.sh by provision-host.sh and called from BOTH:
#   * enshrouded-config.service (every activation of the game unit, ExecStart, as root), and
#   * deploy-game-server.sh (stages the config before it touches the running game).
# There must never be a second copy of this logic: two copies of "no empty password may render" is
# how one of them quietly stops being true (7.3.3).
#
# Rules this script keeps:
#   * SSM is the only source of truth; the rendered file is a cache (1.12). Reads exactly SIX
#     parameters by NAME with `ssm get-parameters --names` (a hardcoded list, never dynamic, never a
#     path walk): a missing parameter comes back in InvalidParameters as an explicit fact instead of
#     as a silently absent key (7.3.4).
#   * FAILS CLOSED (7.3.2). Missing, empty, too short or unreadable => non-zero exit, no output file
#     touched. enshrouded.service Requires= the unit that runs this, so the game then does not start:
#     a loud failure with a named cause beats a healthy-looking server nobody can join.
#   * Bounded retry lives HERE, not in systemd Restart= (which does nothing for a oneshot pulled in by
#     Requires=: the dependent's start job has already failed). Only the SSM call is retried; a
#     validation failure is a fact about the data and retrying cannot change it.
#   * No secret value is ever echoed, logged, put in argv or traced (never `set -x`). Secrets travel
#     SSM -> shell variable -> pipe -> python3 -> a 0600 file, and nothing else. Errors name the
#     parameter, never the value. Nothing about a value is recorded (no hash, length or version: 1.14).
#   * The output is created 0600 from its first byte (O_EXCL on a sibling temp file), owned by the
#     game user, then renamed into place, so a failed render never leaves a partial config.
set -euo pipefail
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:${PATH:-}"

TEMPLATE="${ENSHROUDED_TEMPLATE:-/usr/local/lib/enshrouded/enshrouded_server.json.tmpl}"
AWS_BIN="${ENSHROUDED_AWS_BIN:-aws}"
ATTEMPTS="${ENSHROUDED_RENDER_ATTEMPTS:-5}"
BACKOFF_BASE="${ENSHROUDED_RENDER_BACKOFF:-2}"   # sleeps 2,4,8,16 s between 5 attempts
CALL_TIMEOUT="${ENSHROUDED_RENDER_CALL_TIMEOUT:-12}"
# Worst case: 5 x 12 s + 30 s of backoff = 90 s, inside the unit's TimeoutStartSec=120.

# The hardcoded parameter list. This is the only place these names live in shell; the python mapping
# below uses the same six (test/render-config.test.ts asserts the two agree).
PARAM_NAMES=(
  /enshroudedproj/server/name
  /enshroudedproj/server/slot-count
  /enshroudedproj/server/user-groups/admin-password
  /enshroudedproj/server/user-groups/friend-password
  /enshroudedproj/server/user-groups/guest-password
  /enshroudedproj/server/user-groups/visitor-password
)

log() { echo "[render-config] $*"; }
die() { echo "[render-config] FATAL: $*" >&2; exit 1; }

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

def main():
    try:
        resp = json.load(sys.stdin)
    except ValueError:
        sys.exit("SSM response was not valid JSON (content not shown)")
    invalid = resp.get("InvalidParameters") or []
    if invalid:
        sys.exit("SSM reports missing/unreadable parameter(s): %s" % ", ".join(sorted(invalid)))
    have = {p["Name"]: p["Value"] for p in resp.get("Parameters", [])}
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

    # 0600 from the first byte, exclusive-create next to the destination, chown, then rename.
    tmp = "%s.tmp.%d" % (out_path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
            f.write("\n")
        owner = os.environ.get("ENSHROUDED_RENDER_OWNER", "enshrouded:enshrouded" if getattr(os, "geteuid", lambda: 1)() == 0 else "")
        if owner:
            import shutil
            user, _, group = owner.partition(":")
            shutil.chown(tmp, user, group or None)
        os.chmod(tmp, 0o600)
        os.replace(tmp, out_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

try:
    main()
except SystemExit:
    raise
except Exception as e:  # never let a traceback near the secrets: name the class only
    sys.exit("render failed: %s" % type(e).__name__)
'

# Not named main(): test/host-scripts.test.ts locates provision-host.sh's own main() with a regex over
# the whole file, and this script is embedded in it verbatim.
render_main() {
  [ "$#" -eq 1 ] || die "usage: render-config.sh <output-path>"
  local out="$1" region resp attempt=1 delay
  [ -r "$TEMPLATE" ] || die "config template $TEMPLATE is missing or unreadable (run provision-host.sh / the game deploy)"
  [ -d "$(dirname "$out")" ] || die "output directory $(dirname "$out") does not exist (is the data volume mounted?)"
  region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"

  # Bounded retry around the SSM read only. stderr (aws error text) carries no parameter values.
  until resp="$(timeout "$CALL_TIMEOUT" "$AWS_BIN" ssm get-parameters --region "$region" \
                  --names "${PARAM_NAMES[@]}" --with-decryption --output json)"; do
    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      die "could not read the server parameters from SSM after ${ATTEMPTS} attempts; refusing to render (the game will not start)"
    fi
    delay=$(( BACKOFF_BASE * (1 << (attempt - 1)) ))
    echo "[render-config] SSM read failed (attempt ${attempt}/${ATTEMPTS}); retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$(( attempt + 1 ))
  done

  # printf is a builtin, so the decrypted values never reach any argv.
  printf '%s' "$resp" | python3 -c "$RENDER_PY" "$TEMPLATE" "$out" \
    || die "config rendering failed (parameter name given above; values are never printed)"
  resp=""
  log "rendered $out from SSM (mode 600)"
}

# Sourceable for tests: only run when executed.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  render_main "$@"
fi
