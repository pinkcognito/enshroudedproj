# infrastructure/ — AWS CDK (TypeScript)

See [`CLAUDE.md`](CLAUDE.md) in this directory. It is the single source of truth for this
subtree and applies identically to every agent, whichever file name that agent looks for.

This file exists because the repository-root `AGENTS.md` points here, and a pointer that
resolves to nothing is worse than no pointer at all. It is deliberately **not** a copy:
two files holding the same guardrails drift, and the copy that goes stale is the one
somebody acts on.
