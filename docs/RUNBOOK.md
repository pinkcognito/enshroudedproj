# RUNBOOK — enshroudedproj

Operational procedures. Started as the **operator prerequisites** needed before the first
deploy; WP-02 extends the isolation-verification section and WP-16 adds the day-2 procedures
(manual stop, clearing a stuck maintenance mode, forcing a game update, rolling back a bad
Keen patch, and the restore drill). Extend this file — don't replace it.

Design rationale for everything here lives in `docs/ARCHITECTURE.md`; section references
below point at it.

---

## 1. Operator prerequisites — run once, by hand

These cannot be done by CI. The first two create the credentials CI itself relies on, and the
third seeds secrets that must never pass through CloudFormation.

### 1.1 Bootstrap an isolated CDK toolkit (§6.2.1)

**Why by hand:** CI cannot safely bootstrap the credentials it is currently using.

**Why isolated:** a live, unrelated project (UOPrivateServer) runs in the same AWS account.
The shared `cdk-hnb659fds-*` bootstrap roles can modify *any* stack, and the CDK **deploy
role** additionally carries `cloudformation:DeleteStack` on `Resource: "*"` — a standing
ability to delete `InfrastructureStack`. A separate qualifier plus a deny-only guardrail is
what prevents that. See §6.2.4 for the blast radius.

```sh
cd infrastructure/policies

# 1. Create the deny-only guardrail.
aws iam create-policy \
  --policy-name EnshroudedUoGuardrail \
  --description "Deny-only guardrail: Enshrouded CI cannot touch UOPrivateServer resources" \
  --policy-document file://uo-guardrail.json

# 2. Bootstrap a SEPARATE toolkit stack referencing it.
#    AdministratorAccess + the guardrail: Deny beats Allow, so AWS maintains the Allow half
#    and all our judgement sits in one small reviewable Deny document.
#    (PowerUserAccess does NOT work here — it excludes iam:*, and our stacks create the EC2
#    instance role and seven Lambda roles. See §6.2.1 step 0.)
cdk bootstrap \
  --qualifier enshrd1 \
  --toolkit-stack-name CDKToolkitEnshrouded \
  --cloudformation-execution-policies "arn:aws:iam::aws:policy/AdministratorAccess,arn:aws:iam::334953720182:policy/EnshroudedUoGuardrail" \
  aws://334953720182/us-east-2

# 3. Close the deploy-role hole. `cdk bootstrap` does NOT do this, and
#    --custom-permissions-boundary cannot reach it (the bootstrap template applies the
#    boundary to the execution role only).
aws iam attach-role-policy \
  --role-name cdk-enshrd1-deploy-role-334953720182-us-east-2 \
  --policy-arn arn:aws:iam::334953720182:policy/EnshroudedUoGuardrail
```

**Re-runnable.** `cdk bootstrap` is idempotent. Policy edits go through
`aws iam create-policy-version --set-as-default`. **Step 3 must be repeated after any
re-bootstrap** — re-bootstrapping can reset the deploy role's attachments.

The existing `CDKToolkit` stack (bootstrap version 32) is left untouched; a second toolkit
stack coexists with it.

`cdk.json` is already pinned to `@aws-cdk/core:bootstrapQualifier: "enshrd1"`.

### 1.2 Verify the isolation actually holds (§6.2.2)

An untested control is an assumption, not a control. All read-only.

```sh
# a. No synth may reference the shared toolkit. Expect ZERO hits.
cd infrastructure && npx cdk synth | grep -c hnb659fds

# b. Negative controls — the CI roles must NOT be able to touch UO resources.
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::334953720182:role/cdk-enshrd1-cfn-exec-role-334953720182-us-east-2 \
  --action-names ec2:TerminateInstances \
  --resource-arns arn:aws:ec2:us-east-2:334953720182:instance/i-0d2f683b403536375 \
  --query 'EvaluationResults[].EvalDecision'      # expect: explicitDeny

aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::334953720182:role/cdk-enshrd1-deploy-role-334953720182-us-east-2 \
  --action-names cloudformation:DeleteStack \
  --resource-arns arn:aws:cloudformation:us-east-2:334953720182:stack/InfrastructureStack/* \
  --query 'EvaluationResults[].EvalDecision'      # expect: explicitDeny

# c. POSITIVE control — the exec role must STILL be able to do its job.
#    This is the check that catches an over-tightened policy before a failed deploy.
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::334953720182:role/cdk-enshrd1-cfn-exec-role-334953720182-us-east-2 \
  --action-names iam:CreateRole iam:AttachRolePolicy iam:PassRole ec2:RunInstances \
  --query 'EvaluationResults[].{a:EvalActionName,d:EvalDecision}'   # expect: allowed
```

> The CloudFormation **execution** role cannot be assumed by a human — its trust policy is
> `Principal: Service: cloudformation.amazonaws.com`. Use `simulate-principal-policy`, not
> `assume-role`.

Paste the output of these into this file under a dated heading when you run them.

### 1.3 Seed the SSM parameters (§6.6)

The deploy **hard-fails** unless the required ones exist. That is deliberate, not defensive
padding: the reference implementation's own example config ships a group with
`"password": ""` and full `canEditWorld`/`canEditBase`, i.e. a wide-open, world-editable
public server. Any path that renders an empty password publishes exactly that. **No future
change may make an empty password render successfully** (§7).

Deliberately **not** created by CDK, so no secret ever lands in a CloudFormation template
and so CDK never overwrites an operator edit.

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

```sh
REGION=us-east-2

aws ssm put-parameter --region $REGION --name /enshroudedproj/server/name \
  --type String --value "Your Server Name" --overwrite
aws ssm put-parameter --region $REGION --name /enshroudedproj/server/slot-count \
  --type String --value "16" --overwrite

for g in admin friend guest visitor; do
  aws ssm put-parameter --region $REGION \
    --name /enshroudedproj/server/user-groups/$g-password \
    --type SecureString --value "CHANGE-ME-$g" --overwrite
done

# Discord bot token — from the Developer Portal, Bot tab. NEVER commit this.
aws ssm put-parameter --region $REGION --name /enshroudedproj/discord/bot-token \
  --type SecureString --value "PASTE-BOT-TOKEN" --overwrite
```

> Shell history: these commands put secrets on the command line. Prefer
> `--value "$(read -rs x; echo "$x")"`, or clear your history afterwards.

The four group passwords map to `userGroups[].password` in the rendered config. The
permission matrix for each group is fixed in `config/enshrouded_server.json.tmpl` per §7.1
— **every permission key is set explicitly on every group; none is ever inherited from a
default.**

### 1.4 Discord application

Non-secret values (safe to record here; the bot token is not):

| Field | Value |
| --- | --- |
| Application ID | `1561358999863955538` |
| Public key | `2223e306f481c8079b23ac6d07ef72ce2ebdc638464d4ec97d043d5af444605d` |

The public key only *verifies* inbound request signatures — it cannot sign, so it is not a
credential. The **bot token** is the secret and lives only in SSM (§1.3).

After the stack deploys, set the interactions endpoint in the Discord Developer Portal to the
`DiscordBotInteractionsUrl` stack output, then register the commands:

```sh
cd infrastructure
DISCORD_APPLICATION_ID=1561358999863955538 node scripts/register-discord-commands.js
# add DISCORD_GUILD_ID=<guild id> for near-instant guild-scoped testing
```

Registration is a **manual step, not part of deploy**, and is a **bulk overwrite** —
`commands.js` must list every command the handler dispatches on, or re-registering silently
deletes the omitted ones. Global and guild command sets *stack* rather than merge, so a guild
with both registered shows duplicates.

### 1.5 GitHub repository variables

```sh
gh variable set AWS_REGION                 --body us-east-2
gh variable set DISCORD_APPLICATION_ID     --body 1561358999863955538
gh variable set DISCORD_PUBLIC_KEY         --body 2223e306f481c8079b23ac6d07ef72ce2ebdc638464d4ec97d043d5af444605d
gh variable set GITHUB_OIDC_PROVIDER_ARN   --body arn:aws:iam::334953720182:oidc-provider/token.actions.githubusercontent.com
# After the first deploy, from EnshroudedServerStack outputs:
gh variable set ENSHROUDED_DEPLOY_ROLE_ARN --body <output>
gh variable set ENSHROUDED_INSTANCE_ID     --body <output>
```

The OIDC provider already exists in the account (created by the UO project). Our stack
**imports** it by ARN — creating a second one fails with `EntityAlreadyExists`. The
game-deploy role is only created when `GITHUB_OIDC_PROVIDER_ARN` is supplied.

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
