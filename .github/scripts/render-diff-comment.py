#!/usr/bin/env python3
"""Render the sticky PR comment for pr-aws-diff.yml. Prints Markdown to stdout.

Inputs (environment, set by the workflow):
  MARKER      hidden HTML marker used to find/update the single sticky comment
  DIFF_FILE   path to captured `cdk diff` output (may be absent)
  DIFF_RC     exit code of `cdk diff --fail` ("" if it did not run)
  GUARD_RC    exit code of check-diff-stacks.py ("" if it did not run)
  SKIP_REASON non-empty => the diff did not run; text explains why
  RUN_URL     URL of this workflow run (full log lives there)
  HEAD_SHA    commit the diff was computed for

Never prints credentials; the diff text is whatever `cdk diff` emitted.
"""
import os
import pathlib
import re

# GitHub rejects comments over 65,536 characters. Leave a wide margin for the header/footer.
MAX_DIFF_CHARS = 58000

env = os.environ.get
marker = env("MARKER", "<!-- enshrouded-cdk-diff -->")
run_url = env("RUN_URL", "")
sha = (env("HEAD_SHA", "") or "")[:7]
skip = env("SKIP_REASON", "")
diff_rc = env("DIFF_RC", "")
guard_rc = env("GUARD_RC", "")

diff = ""
p = pathlib.Path(env("DIFF_FILE", ""))
if env("DIFF_FILE") and p.is_file():
    diff = p.read_text(encoding="utf-8", errors="replace").strip()

out = [marker, "## CDK diff"]
log = f"[full run log]({run_url})" if run_url else "the workflow run log"

if skip:
    out += ["", f"**Diff was not computed:** {skip}", "", f"See {log}."]
elif guard_rc not in ("", "0"):
    out += [
        "",
        "**FAILED: the diff touches a stack that is not `Enshrouded*`.** This repo must never "
        "modify the UOPrivateServer stacks that share this AWS account. Do not merge.",
    ]
else:
    has_header = re.search(r"^Stack \S+", diff, re.M) is not None
    looks_failed = re.search(r"^\s*(\S*Error\b|Error:|ERROR\b)", diff, re.M) is not None
    if diff_rc == "0":
        state = "none"
    elif diff_rc == "1" and has_header and not looks_failed:  # rc 2 = cdk itself failed
        state = "changes"
    else:
        state = "error"
    if state == "none":
        out += ["", "**No infrastructure changes.** The deployed stacks already match this branch."]
    elif state == "changes":
        out += ["", "**This PR changes deployed infrastructure** (read-only `cdk diff`, nothing has been applied):"]
    else:
        out += ["", f"**`cdk diff` failed (exit code {diff_rc or 'n/a'}).** Output below; see {log}."]

if diff and not skip:
    body = diff
    truncated = len(body) > MAX_DIFF_CHARS
    if truncated:
        body = body[:MAX_DIFF_CHARS]
        body = body[: body.rfind("\n")] if "\n" in body else body
    out += ["", "`````text", body, "`````"]
    if truncated:
        out += ["", f"> **Diff truncated** ({len(diff):,} characters; GitHub caps comments at 65,536). Complete diff: {log}."]

out += ["", f"<sub>Commit {sha or 'unknown'} · updated on every push to this PR · {log}</sub>"]
print("\n".join(out))
