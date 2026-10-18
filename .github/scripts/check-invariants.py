#!/usr/bin/env python3
"""Project invariants gate (CI job: project-invariants).

A live, unrelated project (UOPrivateServer) shares AWS account 334953720182.
These checks are the guardrails that keep this repo from touching it, plus
two supply-chain pins that must not be silently dropped.

Run from the repo root AFTER `npx cdk synth` (reads infrastructure/cdk.out).
Exit 1 with one line per violation; exit 0 if everything holds.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
INFRA = ROOT / "infrastructure"
CDK_OUT = INFRA / "cdk.out"

FORBIDDEN_STACKS = ("InfrastructureStack", "AdminUiStack", "GithubOidcStack")
FORBIDDEN_QUALIFIER = "hnb659fds"  # default CDK bootstrap qualifier == UOPrivateServer's CDKToolkit
ROLE_PREFIX = "enshrouded-"

errors: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def first_literal(value) -> str:
    """Leading literal text of a RoleName (plain string, or Fn::Join whose first part is a string)."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and "Fn::Join" in value:
        parts = value["Fn::Join"][1]
        if parts and isinstance(parts[0], str):
            return parts[0]
    return ""


# ---- synthesised output --------------------------------------------------------------------
if not CDK_OUT.is_dir():
    sys.exit("cdk.out not found - run `npx cdk synth` in infrastructure/ first")

templates = sorted(CDK_OUT.glob("*.template.json"))
if not templates:
    fail("no *.template.json in cdk.out - synth produced nothing")

# 1. default bootstrap qualifier must not appear anywhere in the synthesised output
for f in sorted(p for p in CDK_OUT.rglob("*") if p.is_file()):
    try:
        text = f.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    if FORBIDDEN_QUALIFIER in text:
        fail(f"{f.relative_to(ROOT)}: contains '{FORBIDDEN_QUALIFIER}' (UOPrivateServer's bootstrap qualifier)")

# 2. stack names: every template/stack must start with Enshrouded and never be a UO stack
stack_names = {t.name[: -len(".template.json")] for t in templates}
manifest = CDK_OUT / "manifest.json"
if manifest.is_file():
    for art_id, art in json.loads(manifest.read_text(encoding="utf-8")).get("artifacts", {}).items():
        if art.get("type") == "aws:cloudformation:stack":
            stack_names.add(art_id)
            stack_names.add(art.get("properties", {}).get("stackName", art_id))
for name in sorted(stack_names):
    if name in FORBIDDEN_STACKS:
        fail(f"stack named '{name}' belongs to UOPrivateServer")
    if not name.startswith("Enshrouded"):
        fail(f"stack '{name}' does not start with 'Enshrouded'")

# 3. IAM role names must be prefixed enshrouded-
for t in templates:
    resources = json.loads(t.read_text(encoding="utf-8")).get("Resources", {})
    for logical_id, res in resources.items():
        if res.get("Type") != "AWS::IAM::Role":
            continue
        role_name = res.get("Properties", {}).get("RoleName")
        if role_name is None:
            continue  # CFN-generated name: prefixed with the stack name, cannot collide
        if not first_literal(role_name).startswith(ROLE_PREFIX):
            fail(f"{t.name}: IAM role {logical_id} has RoleName {role_name!r}, must start with '{ROLE_PREFIX}'")

# ---- source pins ---------------------------------------------------------------------------
def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


provision = read("infrastructure/scripts/provision-host.sh")
if not re.search(r'^GE_PROTON_SHA256="[0-9a-f]{64}"$', provision, re.M):
    fail("provision-host.sh: GE_PROTON_SHA256 pin (64 hex chars) is missing")
if 'sha256sum "$f"' not in provision or '"$got" = "$GE_PROTON_SHA256"' not in provision:
    fail("provision-host.sh: GE-Proton tarball SHA256 verification is missing")

for rel in ("infrastructure/scripts/deploy-game-server.sh", "infrastructure/scripts/provision-host.sh"):
    if "+@sSteamCmdForcePlatformType windows" not in read(rel):
        fail(f"{rel}: '+@sSteamCmdForcePlatformType windows' is missing (app 2278520 has no Linux depot)")

# World-save integrity: shutdown semantics of the game unit
unit = read("infrastructure/systemd/enshrouded.service")
for pat, what in (
    (r"^KillSignal=SIGINT$", "KillSignal=SIGINT"),
    (r"^KillMode=control-group$", "KillMode=control-group"),
):
    if not re.search(pat, unit, re.M):
        fail(f"enshrouded.service: {what} is missing (world-save integrity)")
m = re.search(r"^TimeoutStopSec=(\d+)", unit, re.M)
if not m or int(m.group(1)) < 120:
    fail("enshrouded.service: TimeoutStopSec must be >= 120 (world-save integrity)")

if errors:
    print("PROJECT INVARIANT VIOLATIONS:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
print(f"project invariants OK ({len(templates)} template(s), stacks: {', '.join(sorted(stack_names))})")
