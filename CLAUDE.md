# CLAUDE.md — enshroudedproj

Enshrouded dedicated server on AWS (Ubuntu 24.04 + GE-Proton, `r6i.large`, us-east-2), started on demand and auto-stopped when idle. Design lives in `docs/ARCHITECTURE.md` — read the relevant section before changing a subsystem. Infra is AWS CDK (TypeScript) in `infrastructure/`; see `infrastructure/CLAUDE.md`.

## WARNING — a live, unrelated project shares this AWS account
Account `334953720182` (us-east-2) also hosts the running UOPrivateServer game server. Its stacks are **`InfrastructureStack`, `AdminUiStack`, `GithubOidcStack`** (plus `CDKToolkit`, and IAM roles `github-actions-*`). **Never create, name, import, or touch any of these.** Every stack here is named `Enshrouded*` with an explicit `stackName`; never rely on the construct-id default; never `cdk deploy --all`. `infrastructure/test/stack-naming.test.ts` enforces this — never weaken it.

## Guardrails (these override "just ship it")
- **Never `cdk deploy` locally — no exceptions.** Infra reaches AWS *only* through the GitHub workflow on merge to `main` (GitHub OIDC). This is what keeps every change to a shared account reviewed and auditable.
- **Every feature-branch PR must post its `cdk diff` as a PR comment**, so what is about to change is visible before the merge that applies it. A PR with infra changes and no diff comment is not reviewable.
- **`cdk bootstrap` is permitted when needed.** CI structurally cannot bootstrap the credentials it runs with, so this is a human/assistant step. Already done: qualifier `enshrd1`, stack `CDKToolkitEnshrouded` (see `docs/RUNBOOK.md` §1.1).
- Validate locally with `npm run build`, `npx cdk synth` and `npx cdk diff` — all read-only.
- **Never commit to `main`; branch fresh per task and open a PR.**
- **Tag every AWS resource** `project=enshroudedproj`, `repo=pinkcognito/enshroudedproj` (applied at App level in `bin/enshrouded.ts`; do not remove).
- Stop and ask before anything that could affect a non-`Enshrouded*` resource.

## Build / check
`cd infrastructure && npm run build && npm run lint && npm test && npx cdk synth` — must be clean before opening a PR.
