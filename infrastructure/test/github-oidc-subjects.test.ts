import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedOidcStack } from '../lib/enshrouded-oidc-stack';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';
import { GITHUB_REPO_BY_ID, GITHUB_REPO_BY_NAME } from '../lib/enshrouded/constants';

/**
 * Cross-stack guards for the two mistakes that actually reached production.
 *
 * 1. GitHub issues OIDC subjects with immutable numeric ids embedded
 *    (repo:<owner>@<id>/<repo>@<id>:<ctx>), not the documented repo:<owner>/<repo>:<ctx>.
 *    The fix was applied to EnshroudedOidcStack's two roles but NOT to the
 *    game-deploy role in EnshroudedServerStack, because each stack built the
 *    subject string itself. That role then failed to be assumed.
 * 2. The SHA-pin check listed workflow files by name, so deploy-game-server.yml
 *    was never checked and shipped an unpinned action.
 *
 * Both tests below are deliberately written to cover EVERYTHING of their kind
 * rather than a hand-maintained list - a per-file list is what let these through.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENV = { account: '334953720182', region: 'us-east-2' };

function allTemplates(): Record<string, Template> {
  // githubOidcProviderArn is what makes EnshroudedServerStack create the game-deploy
  // role at all. Without it that role is never synthesised - and never checked, which
  // is precisely how it shipped with the wrong subject format.
  const app = new cdk.App({
    context: {
      '@aws-cdk/core:bootstrapQualifier': 'enshrd1',
      githubOidcProviderArn: `arn:aws:iam::${ENV.account}:oidc-provider/token.actions.githubusercontent.com`,
    },
  });
  // Build BOTH stacks before templating either: Template.fromStack synthesises, and
  // CDK refuses a second synth once the construct tree has changed.
  const oidc = new EnshroudedOidcStack(app, 'EnshroudedOidcStack', {
    stackName: 'EnshroudedOidcStack',
    env: ENV,
  });
  const server = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
    stackName: 'EnshroudedServerStack',
    env: ENV,
  });
  return {
    EnshroudedOidcStack: Template.fromStack(oidc),
    EnshroudedServerStack: Template.fromStack(server),
  };
}

interface Cond {
  StringEquals?: Record<string, string | string[]>;
  StringLike?: Record<string, string | string[]>;
}

describe('GitHub OIDC subjects (every stack, every role)', () => {
  const templates = allTemplates();

  test('every GitHub-assumable role accepts the ID-based subject', () => {
    let checked = 0;
    const problems: string[] = [];

    for (const [stackName, template] of Object.entries(templates)) {
      for (const [logicalId, role] of Object.entries(template.findResources('AWS::IAM::Role'))) {
        const doc = (role as { Properties: { AssumeRolePolicyDocument?: { Statement?: unknown[] } } })
          .Properties.AssumeRolePolicyDocument;
        for (const raw of doc?.Statement ?? []) {
          const st = raw as { Principal?: { Federated?: unknown }; Condition?: Cond };
          if (!st.Principal?.Federated) continue; // not a web-identity trust
          const where = `${stackName}/${logicalId}`;

          const subKey = 'token.actions.githubusercontent.com:sub';
          const raw2 = st.Condition?.StringLike?.[subKey] ?? st.Condition?.StringEquals?.[subKey];
          const subs = (Array.isArray(raw2) ? raw2 : [raw2]).filter(Boolean) as string[];

          if (subs.length === 0) {
            problems.push(`${where}: federated principal with no sub condition`);
            continue;
          }

          // The ID form is the one GitHub actually sends. Missing it means the role
          // cannot be assumed at all - the failure this test exists to prevent.
          if (!subs.some((s) => s.startsWith(`repo:${GITHUB_REPO_BY_ID}:`))) {
            problems.push(`${where}: no ID-based subject accepted (has: ${subs.join(', ')})`);
          }

          // And never a foreign repo.
          for (const s of subs) {
            const ours =
              s.startsWith(`repo:${GITHUB_REPO_BY_ID}:`) || s.startsWith(`repo:${GITHUB_REPO_BY_NAME}:`);
            if (!ours) problems.push(`${where}: trusts an unexpected subject: ${s}`);
          }
          checked += 1;
        }
      }
    }

    expect(problems).toEqual([]);
    // Three today: cdk-deploy, cdk-diff, game-deploy. If this drops, a role stopped
    // being checked rather than the project getting simpler.
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});

describe('GitHub Actions supply chain (every workflow)', () => {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  test('there are workflows to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s pins every third-party action to a commit SHA', (file) => {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    const uses = [...body.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    const unpinned = uses.filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}$/.test(u));
    expect(unpinned).toEqual([]);
  });
});
