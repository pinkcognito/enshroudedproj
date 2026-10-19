# infrastructure/ — AWS CDK (TypeScript)

CDK app for the Enshrouded server. **Deploys only via the GitHub workflow on merge to `main`** (GitHub OIDC) — **never `cdk deploy` locally, no exceptions.** Every feature-branch PR must post its `cdk diff` as a PR comment. `cdk bootstrap` is permitted when needed (CI cannot bootstrap its own credentials); already done — qualifier `enshrd1`, stack `CDKToolkitEnshrouded`.

## Key files
- `bin/enshrouded.ts` — app entry; applies the `project`/`repo` tags at App level.
- `lib/enshrouded-server-stack.ts` — `EnshroudedServerStack` (currently empty; later work packages add constructs).
- `test/stack-naming.test.ts` — synthesises the app and fails on a forbidden or non-`Enshrouded*` stack name.

## Conventions / guardrails
- **A live UO project shares this AWS account.** Forbidden stack names: `InfrastructureStack`, `AdminUiStack`, `GithubOidcStack`. Every stack passes an explicit `stackName` starting `Enshrouded`; a default (construct-id) name could adopt or destroy the running game server.
- **Bootstrap qualifier is pinned to `enshrd1`** via `@aws-cdk/core:bootstrapQualifier` in `cdk.json`, so no synth ever defaults to the shared `hnb659fds` toolkit. Do not remove or change it.
- **Never `cdk deploy` locally.** Validate with `npm run build` then `npx cdk synth` / `npx cdk diff` — both read-only. Never use `--all`. `cdk bootstrap` is the one permitted exception (see above).
- **Tag every resource** `project=enshroudedproj`, `repo=pinkcognito/enshroudedproj` (App-level `Tags.of(app)`).
- Never commit to `main`; branch per task and open a PR.
- **IAM least-privilege**; prefix every IAM role name `enshrouded-`.

## Build / check
`cd infrastructure && npm run build && npm run lint && npm test && npx cdk synth` — must be clean before opening a PR.

## Discord slash-command registration (manual, bulk overwrite)
- `lib/enshrouded/lambda/discord-bot/commands.js` is the **source of truth** for the `/enshrouded` command (subcommands are `type: 1` options). Registration is **not part of deploy**: an operator runs `DISCORD_APPLICATION_ID=<id> node scripts/register-discord-commands.js` (optionally `DISCORD_GUILD_ID=<id>` for instant guild-scoped testing). The bot token is read from SSM `/enshroudedproj/discord/bot-token` (or `DISCORD_BOT_TOKEN`).
- It is a **bulk overwrite (PUT)**: Discord's command set becomes exactly `commands.js`. Every command/subcommand the handler dispatches on **must** be listed there, or re-registering silently deletes it. Global and guild sets stack, so clear one before switching scope.
- `test/discord-commands.test.ts` is the anti-drift guard (handler reads/dispatches vs `commands.js`). Adding a subcommand = edit `commands.js` + add a `subcommand === '...'` branch in `index.js`, then re-run the registration script.
- Deploy-time config (no real values in the repo): `DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID` as env vars or CDK context (`-c discordPublicKey=...`); absent, the public key is an all-zero placeholder that rejects every request.
