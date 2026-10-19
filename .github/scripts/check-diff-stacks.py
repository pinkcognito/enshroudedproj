#!/usr/bin/env python3
"""cdk diff-time foreign-stack guard (ARCHITECTURE 6.2 measure 6; workflow: pr-aws-diff.yml).

WP-19's check-invariants.py guards the SYNTHESISED output with no AWS access. This is the same
invariant at the second point in the pipeline: the text of `cdk diff` computed against REAL account
state. It fails if the diff names any stack that is not `Enshrouded*`, or mentions a stack that
belongs to the live UOPrivateServer project anywhere at all.

The forbidden-name list is read from check-invariants.py (single source of truth) rather than
copied, so the two checks cannot drift.

Usage: check-diff-stacks.py <file-with-cdk-diff-output>
Exit 0 = clean, 1 = violation, 2 = usage / unreadable input.
"""
import ast
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent


def forbidden_stacks() -> tuple:
    """FORBIDDEN_STACKS literal from check-invariants.py (it executes checks on import, so parse it)."""
    tree = ast.parse((HERE / "check-invariants.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "FORBIDDEN_STACKS" for t in node.targets):
            value = ast.literal_eval(node.value)
            if value:
                return tuple(value)
    sys.exit("check-diff-stacks: FORBIDDEN_STACKS not found in check-invariants.py")


def violations(text: str, forbidden: tuple) -> list:
    errors = []
    # `cdk diff` prints one `Stack <name>` header per stack it compares (colour already stripped).
    for lineno, line in enumerate(text.splitlines(), 1):
        m = re.match(r"^Stack (\S+)", line)
        if m and not m.group(1).startswith("Enshrouded"):
            errors.append(f"line {lineno}: diff touches stack '{m.group(1)}', which is not Enshrouded*")
    for name in forbidden:
        for m in re.finditer(r"(?<![A-Za-z0-9])" + re.escape(name) + r"(?![A-Za-z0-9])", text):
            lineno = text.count("\n", 0, m.start()) + 1
            errors.append(f"line {lineno}: diff mentions '{name}' (belongs to UOPrivateServer)")
            break
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    try:
        text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        print(f"cannot read {sys.argv[1]}: {e}")
        return 2
    errors = violations(text, forbidden_stacks())
    if errors:
        print("FOREIGN STACK IN CDK DIFF:")
        for e in errors:
            print(f"  - {e}")
        return 1
    stacks = sorted(set(re.findall(r"^Stack (\S+)", text, re.M)))
    print(f"diff-time stack guard OK (stacks in diff: {', '.join(stacks) or 'none'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
