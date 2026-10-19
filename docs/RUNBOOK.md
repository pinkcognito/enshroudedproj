# RUNBOOK — enshroudedproj

Operational procedures. Started as the **operator prerequisites** needed before the first
deploy; WP-02 extends the isolation-verification section and WP-16 adds the day-2 procedures
(manual stop, clearing a stuck maintenance mode, forcing a game update, rolling back a bad
Keen patch, and the restore drill). Extend this file — don't replace it.

Design rationale for everything here lives in `docs/ARCHITECTURE.md`; section references
below point at it.

---

## 1. Operator prerequisites — run once, by hand

| Step | Status | Who |
| --- | --- | --- |
| 1.1 Bootstrap isolated CDK toolkit | ✅ done 2026-10-18 | Claude (authorised) |
| 1.2 Verify isolation | ✅ done, output recorded below | Claude |
| 1.3 Seed SSM parameters | ✅ done 2026-10-18 (7 params) | You |
| **1.4 Discord endpoint + command registration** | **⬜ TODO** | **You** |
| 1.5 GitHub repo variables | ✅ done 2026-10-18 (all 6 set) | Claude |
| 1.6 Hand-deploy `EnshroudedOidcStack` | ✅ done 2026-10-18 | Claude (authorised) |

**Only §1.4 is blocking.** Everything in it is a secret or a value only you can
choose, which is why it is not automated. Paste the block as a whole — it defines a
prompt helper first, so the passwords are never typed on a command line and never
land in PowerShell history.

These cannot be done by CI. The first two create the credentials CI itself relies on, and the
third seeds secrets that must never pass through CloudFormation.

### 1.1 Bootstrap an isolated CDK toolkit (§6.2.1) — ✅ DONE 2026-10-18

**Why by hand:** CI cannot safely bootstrap the credentials it is currently using.

**Why isolated:** a live, unrelated project (UOPrivateServer) runs in the same AWS account.

This project does **not** share UO's bootstrap roles. The `--qualifier enshrd1` below
provisions its own complete set — `cdk-enshrd1-{deploy,cfn-exec,file-publishing,
image-publishing,lookup}-role-334953720182-us-east-2`, plus its own asset bucket and version
parameter — entirely separate from UO's `cdk-hnb659fds-*`. `cdk.json` pins the qualifier and
a CI job fails on any `hnb659fds` reference in a synthesised template.

Separate roles alone are not sufficient, which is why the guardrail exists: *any* CDK deploy
role carries `cloudformation:DeleteStack` on `Resource: "*"`, so even our own fresh
`cdk-enshrd1-deploy-role` could delete `InfrastructureStack` unless explicitly denied. The
deny-only policy is what removes that capability. See §6.2.4 for the blast radius.

> **Known asymmetry — the protection is one-directional.** This guardrail stops *our* roles
> touching UO. Nothing stops UO's roles touching *us*: `cdk-hnb659fds-deploy-role` has
> `cloudformation:DeleteStack` on `Resource: "*"`, which a policy simulation confirms is
> `allowed` against `EnshroudedServerStack`. Closing it means attaching a mirror guardrail to
> UO's roles, which is a change to the *other* project and cannot be done from this one —
> our own guardrail deliberately denies `iam:*` on `cdk-hnb659fds-*`. Tracked as an open
> question; not a blocker, since both projects are operated by the same person.

```powershell
cd infrastructure\policies

# 1. Create the deny-only guardrail.
aws iam create-policy `
  --policy-name EnshroudedUoGuardrail `
  --description "Deny-only guardrail: Enshrouded CI cannot touch UOPrivateServer resources" `
  --policy-document file://uo-guardrail.json

# 2. Bootstrap a SEPARATE toolkit stack referencing it. This creates a complete
#    separate role set (cdk-enshrd1-*); it does NOT reuse UO's cdk-hnb659fds-*.
#    AdministratorAccess + the guardrail: Deny beats Allow, so AWS maintains the
#    Allow half and all our judgement sits in one small reviewable Deny document.
#    (PowerUserAccess does NOT work here - it excludes iam:*, and our stacks
#    create the EC2 instance role and seven Lambda roles. See section 6.2.1 step 0.)
cdk bootstrap --qualifier enshrd1 --toolkit-stack-name CDKToolkitEnshrouded `
  --cloudformation-execution-policies "arn:aws:iam::aws:policy/AdministratorAccess,arn:aws:iam::334953720182:policy/EnshroudedUoGuardrail" `
  aws://334953720182/us-east-2

# 3. Close the deploy-role hole. `cdk bootstrap` does NOT do this, and
#    --custom-permissions-boundary cannot reach it (the bootstrap template
#    applies the boundary to the execution role only).
aws iam attach-role-policy `
  --role-name cdk-enshrd1-deploy-role-334953720182-us-east-2 `
  --policy-arn arn:aws:iam::334953720182:policy/EnshroudedUoGuardrail
```

**Re-runnable.** `cdk bootstrap` is idempotent. Policy edits go through
`aws iam create-policy-version --set-as-default`. **Step 3 must be repeated after any
re-bootstrap** — re-bootstrapping can reset the deploy role's attachments.

The existing `CDKToolkit` stack (bootstrap version 32) is left untouched; a second toolkit
stack coexists with it.

`cdk.json` is already pinned to `@aws-cdk/core:bootstrapQualifier: "enshrd1"`.

### 1.2 Verify the isolation actually holds (§6.2.2) — ✅ DONE 2026-10-18

An untested control is an assumption, not a control. All read-only.

```powershell
# a. No synth may reference the shared toolkit. Expect 0.
cd infrastructure
(npx cdk synth | Select-String -Pattern 'hnb659fds').Count

# b. Negative controls - the CI roles must NOT reach UO resources.
aws iam simulate-principal-policy `
  --policy-source-arn arn:aws:iam::334953720182:role/cdk-enshrd1-cfn-exec-role-334953720182-us-east-2 `
  --action-names ec2:TerminateInstances `
  --resource-arns arn:aws:ec2:us-east-2:334953720182:instance/i-0d2f683b403536375 `
  --query 'EvaluationResults[].EvalDecision'      # expect: explicitDeny

aws iam simulate-principal-policy `
  --policy-source-arn arn:aws:iam::334953720182:role/cdk-enshrd1-deploy-role-334953720182-us-east-2 `
  --action-names cloudformation:DeleteStack `
  --resource-arns 'arn:aws:cloudformation:us-east-2:334953720182:stack/InfrastructureStack/*' `
  --query 'EvaluationResults[].EvalDecision'      # expect: explicitDeny

# c. POSITIVE control - the exec role must STILL be able to do its job.
#    This is what catches an over-tightened policy before a failed deploy.
aws iam simulate-principal-policy `
  --policy-source-arn arn:aws:iam::334953720182:role/cdk-enshrd1-cfn-exec-role-334953720182-us-east-2 `
  --action-names iam:CreateRole iam:AttachRolePolicy iam:PassRole ec2:RunInstances `
  --query 'EvaluationResults[].{a:EvalActionName,d:EvalDecision}'   # expect: allowed
```

> The CloudFormation **execution** role cannot be assumed by a human — its trust policy is
> `Principal: Service: cloudformation.amazonaws.com`. Use `simulate-principal-policy`, not
> `assume-role`.

Paste the output of these into this file under a dated heading when you run them.

#### Run 2026-10-18 — bootstrap applied and verified

`CDKToolkitEnshrouded` created (12 resources, version 32) alongside the untouched
`CDKToolkit` (also version 32). Separate asset buckets: `cdk-enshrd1-assets-…` vs
`cdk-hnb659fds-assets-…`. Synth reports **0** occurrences of `hnb659fds`. UO's
`cdk-hnb659fds-deploy-role` was **not** modified (still only `AWSCloudFormationReadOnlyAccess`).

```
NEGATIVE  exec role   -> ec2:TerminateInstances  on UO instance   explicitDeny
NEGATIVE  exec role   -> ec2:StopInstances       on UO instance   explicitDeny
NEGATIVE  deploy role -> cloudformation:DeleteStack
            InfrastructureStack   explicitDeny
            AdminUiStack          explicitDeny
            GithubOidcStack       explicitDeny
            CDKToolkit            explicitDeny
POSITIVE  exec role still able to do its job:
            iam:CreateRole        allowed     ec2:RunInstances      allowed
            iam:AttachRolePolicy  allowed     s3:CreateBucket       allowed
            iam:PassRole          allowed     lambda:CreateFunction allowed
```

Guardrail attached to **both** `cdk-enshrd1-deploy-role` and `cdk-enshrd1-cfn-exec-role`.

### 1.3 Seed the SSM parameters (§6.6) — ⬜ TODO (you must run this)

**Run the script:**

```powershell
cd C:\Users\Dave\github\enshroudedproj
.\scripts\seed-parameters.ps1
```

Copy the Discord bot token to your clipboard first (Developer Portal → your app →
Bot → Reset Token → Copy). The script prompts you to press Enter, reads the token
from the clipboard, generates the four group passwords, writes everything to SSM,
and prints the passwords once so you can share them.

It reads the clipboard rather than prompting for keyboard input because
`Read-Host -AsSecureString` uses a raw key reader that swallows Ctrl+V in the
Windows console — a ~70-character token cannot be pasted into it.

**What it does for you:**
- Refuses to run against the wrong AWS account.
- Warns if the pasted value isn't shaped like a bot token — the common mistake is
  copying the application *public key* or *client secret*, which sit next to it in
  the portal.
- Takes the token *before* writing anything, so an empty clipboard can't leave
  Parameter Store half-populated.
- Clears the clipboard afterwards, and never prints the token.
- Verifies all seven parameters exist before reporting success.

**Useful switches:**

```powershell
.\scripts\seed-parameters.ps1 -DryRun                      # show what it would write
.\scripts\seed-parameters.ps1 -ServerName "The Shroud" -SlotCount 8
.\scripts\seed-parameters.ps1 -KeepPasswords               # rotate only the bot token
```

Re-running regenerates the group passwords unless you pass `-KeepPasswords`, so
anyone holding the old ones will need the new ones.

#### Rotating group passwords

`-RotatePassword` regenerates one or more group passwords and touches nothing
else — no token needed, so you are not re-pasting it to change one password.

```powershell
.\scripts\seed-parameters.ps1 -RotatePassword guest          # one group
.\scripts\seed-parameters.ps1 -RotatePassword admin,friend   # several
.\scripts\seed-parameters.ps1 -RotatePassword all            # all four
```

Only `admin`, `friend`, `guest`, `visitor` and `all` are accepted; anything else
is rejected before a write happens. `-RotatePassword` cannot be combined with
`-Token`, `-ServerName`, `-SlotCount` or `-KeepPasswords` — PowerShell's
parameter sets reject the combination, so a rotation can never silently rewrite
your server name or token.

**A rotation does not reach the running server by itself.** The config is
rendered on the box at deploy time, so redeploy afterwards:

```powershell
gh workflow run deploy-game-server.yml
```

That restarts the game and disconnects anyone currently playing.

| Parameter | Type | Required | Holds |
| --- | --- | --- | --- |
| `/enshroudedproj/server/name` | String | **yes** | Server display name |
| `/enshroudedproj/server/slot-count` | String | **yes** | Integer 1–16 (hard game cap) |
| `/enshroudedproj/server/user-groups/admin-password` | SecureString | **yes** | min 4 chars |
| `/enshroudedproj/server/user-groups/friend-password` | SecureString | **yes** | min 4 chars |
| `/enshroudedproj/server/user-groups/guest-password` | SecureString | **yes** | min 4 chars |
| `/enshroudedproj/server/user-groups/visitor-password` | SecureString | **yes** | min 4 chars |
| `/enshroudedproj/discord/bot-token` | SecureString | **yes** | Discord bot token |
| `/enshroudedproj/server/auto-update-on-boot` | String | no | `true`/`false`; absent ⇒ update |
| `/enshroudedproj/server/backup-bucket` | String | *auto* | Created by the `GameDeploy` CDK construct |
| `/enshroudedproj/state/maintenance-mode` | String | *auto* | `true`/`false` |
| `/enshroudedproj/state/last-active` | String | *auto* | Epoch ms |
| `/enshroudedproj/state/run-state` | String | *auto* | `starting`/`stopping`/empty |

Deliberately not created by CDK, so no secret ever lands in a CloudFormation
template and so CDK never overwrites an operator edit. The deploy **hard-fails**
if these are missing: the reference implementation's own example config ships a
group with `"password": ""` and full `canEditWorld`/`canEditBase`, i.e. a
wide-open, world-editable public server. Any path that renders an empty password
publishes exactly that. **No future change may make an empty password render
successfully** (§7).

### 1.4 Discord application — ⬜ TODO (the first deploy is done; do this now)

Non-secret values (safe to record here; the bot token is not):

| Field | Value |
| --- | --- |
| Application ID | `1561358999863955538` |
| Public key | `2223e306f481c8079b23ac6d07ef72ce2ebdc638464d4ec97d043d5af444605d` |

The public key only *verifies* inbound request signatures — it cannot sign, so it is not a
credential. The **bot token** is the secret and lives only in SSM (§1.3).

After the stack deploys, set the interactions endpoint in the Discord Developer Portal to the
`DiscordBotInteractionsUrl` stack output, then register the commands:

```powershell
# The first deploy is DONE. Your interactions endpoint URL is:
#   https://n68k1uprzl.execute-api.us-east-2.amazonaws.com/interactions
# (re-read it any time with the command below)
aws cloudformation describe-stacks --region us-east-2 `
  --stack-name EnshroudedServerStack `
  --query "Stacks[0].Outputs[?OutputKey=='DiscordBotInteractionsUrl'].OutputValue" `
  --output text

# Paste that URL into the Developer Portal as the Interactions Endpoint URL,
# then register the slash commands:
cd infrastructure
$env:DISCORD_APPLICATION_ID = '1561358999863955538'
# Optional, for near-instant guild-scoped testing instead of ~1h global propagation:
# $env:DISCORD_GUILD_ID = '<your test guild id>'
node scripts/register-discord-commands.js
```

Registration is a **manual step, not part of deploy**, and is a **bulk overwrite** —
`commands.js` must list every command the handler dispatches on, or re-registering silently
deletes the omitted ones. Global and guild command sets *stack* rather than merge, so a guild
with both registered shows duplicates.

### 1.5 GitHub repository variables — ✅ DONE 2026-10-18

```powershell
gh variable set AWS_REGION                 --body us-east-2
gh variable set DISCORD_APPLICATION_ID     --body 1561358999863955538
gh variable set DISCORD_PUBLIC_KEY         --body 2223e306f481c8079b23ac6d07ef72ce2ebdc638464d4ec97d043d5af444605d
gh variable set ENSHROUDED_OIDC_PROVIDER_ARN --body arn:aws:iam::334953720182:oidc-provider/token.actions.githubusercontent.com
# After the first deploy, from EnshroudedServerStack outputs:
gh variable set ENSHROUDED_DEPLOY_ROLE_ARN --body <output>
gh variable set ENSHROUDED_INSTANCE_ID     --body <output>
```

The OIDC provider already exists in the account (created by the UO project). Our stack
**imports** it by ARN — creating a second one fails with `EntityAlreadyExists`. The
game-deploy role is only created when `ENSHROUDED_OIDC_PROVIDER_ARN` is supplied.

**Naming note.** GitHub rejects repository variables whose names start with `GITHUB_`, so the
variable is `ENSHROUDED_OIDC_PROVIDER_ARN`; `deploy.yml` / `pr-aws-diff.yml` map it onto the
`GITHUB_OIDC_PROVIDER_ARN` environment variable the CDK code reads.

#### CDK CI variables (WP-02: `deploy.yml` and `pr-aws-diff.yml`)

Set these once `EnshroudedOidcStack` exists (its `CdkDeployRoleArn` / `CdkDiffRoleArn` outputs):

```powershell
gh variable set CDK_DEPLOY_ROLE_ARN --body arn:aws:iam::334953720182:role/enshrouded-github-actions-cdk-deploy
gh variable set CDK_DIFF_ROLE_ARN   --body arn:aws:iam::334953720182:role/enshrouded-github-actions-cdk-diff
```

| Variable | Used by | Notes |
| --- | --- | --- |
| `AWS_REGION` | both | `us-east-2` |
| `CDK_DEPLOY_ROLE_ARN` | `deploy.yml` | Trust: `repo:pinkcognito/enshroudedproj:ref:refs/heads/main` only. Assumes the `cdk-enshrd1-*` roles. |
| `CDK_DIFF_ROLE_ARN` | `pr-aws-diff.yml` | Trust: any ref of this repo. Assumes only `cdk-enshrd1-lookup-role-*`. |
| `ENSHROUDED_OIDC_PROVIDER_ARN` | both | See above. |
| `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` | both | Without them synth falls back to placeholders and `cdk diff` would show a spurious change. |

These are identifiers, not secrets. If `CDK_DIFF_ROLE_ARN` or `AWS_REGION` is unset, the PR diff
workflow posts a comment saying the diff was skipped rather than failing.

**First-deploy ordering (open item).** `deploy.yml` authenticates as a role that
`EnshroudedOidcStack` itself creates, so the first deploy of that stack cannot come from CI.
How to seed it is an operator decision; it is not covered by this runbook yet.

### 1.6 EnshroudedOidcStack is hand-deployed — the one `cdk deploy` exception — ✅ DONE 2026-10-18

`deploy.yml` authenticates as `enshrouded-github-actions-cdk-deploy`, a role that
`EnshroudedOidcStack` itself creates. CI cannot assume a role that does not exist, so the
**first** deploy of that stack can never come from CI. This is a genuine cycle, not a gap.

It is therefore deployed by hand, and **excluded from `deploy.yml` permanently** — not just
for the first run. Letting CI redeploy the credentials it is actively authenticating with
means a bad change there locks CI out of fixing itself, and recovery needs manual admin
credentials. `UOPrivateServer` excludes its equivalent `GithubOidcStack` for the same reason.

Everything else — `EnshroudedServerStack` and all future stacks — deploys only through the
workflow on merge to `main`. This is the sole exception.

**Applied 2026-10-18.** Diff reviewed first; it created two IAM roles and nothing else.

```powershell
cd infrastructure
npx cdk diff EnshroudedOidcStack --exclusively        # review first, always
npx cdk deploy EnshroudedOidcStack --exclusively --require-approval never
```

Outputs, now set as repo variables (see §1.5):
```
CdkDeployRoleArn = arn:aws:iam::334953720182:role/enshrouded-github-actions-cdk-deploy
CdkDiffRoleArn   = arn:aws:iam::334953720182:role/enshrouded-github-actions-cdk-diff
```

Re-run this by hand only when the OIDC stack itself changes — a rare, deliberate act. Review
the diff every time: a mistake here is what locks you out.

---

## 2. Reference — Enshrouded server configuration

Our template is `infrastructure/config/enshrouded_server.json.tmpl`. It renders on the box
from the SSM values above; it is never committed with real values.

- **Keen (official) — Dedicated Server Configuration:**
  <https://enshrouded.zendesk.com/hc/en-us/articles/16055441447709-Dedicated-Server-Configuration>
- **Keen (official) — Server Gameplay Settings** (the `gameSettings` block):
  <https://enshrouded.zendesk.com/hc/en-us/articles/20453241249821-Server-Gameplay-Settings>
  Note: labelled as the default file for 0.9.0.0, so treat specific values as possibly stale.
- **Community reference covering all `gameSettings` keys** (unofficial, unverified against Keen):
  <https://supercraft.host/wiki/enshrouded/configuration_guide/>
- **Working real-world example** we validated our key names against:
  `jsknnr/enshrouded-server` → `container/enshrouded_server_example.json`

### What we deliberately do and don't set (§7.2)

| Key | Ours | Why |
| --- | --- | --- |
| `name`, `slotCount`, `ip`, `queryPort`, `saveDirectory`, `logDirectory` | set | core, verified |
| `userGroups[]` + all six permission keys | set explicitly | §7.1 invariant — never inherit a permission default |
| `enableTextChat` | pinned `true` | default unknown; chat is how players coordinate |
| `gameSettingsPreset` | `"Default"` | |
| `gameSettings` | **omitted — do not add** | Should be ignored under the `Default` preset. A *guessed* block that is actually read would permanently alter damage, XP, durability and day/night length for the whole world. To customise, set the preset to `Custom` and author the block from the server's own generated file — never from memory. |
| `tags`, `enableVoiceChat`, `voiceChatMode` | inherited | cosmetic / unused (voice is Discord's job) |
| `gamePort` | never written | the game manages it outside the JSON |

---

## 3. Deploy model

- **Never `cdk deploy` or `cdk bootstrap` locally** (except §1.1, which is the one hand-run
  exception and does not deploy app stacks).
- Infra reaches AWS only via merge to `main` through a **pull request**. Pushes go to a
  feature branch; PRs run a read-only `cdk diff`.
- The game-server deploy (`deploy-game-server.yml`) is **`workflow_dispatch` only** — it
  restarts the game and disconnects any players.
- A deploy sets maintenance mode before and clears it after **including on failure**, so an
  aborted deploy cannot leave idle-shutdown permanently disabled.
