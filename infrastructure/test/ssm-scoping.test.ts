import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';

type Statement = { Effect: string; Action: string | string[]; Resource: unknown };

const app = new cdk.App();
// Explicit env so Vpc.fromLookup returns its dummy VPC instead of throwing.
const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
  stackName: 'EnshroudedServerStack',
  env: { account: '123456789012', region: 'us-east-2' },
});
const template = Template.fromStack(stack);

/** Statements of every IAM policy attached to the role with the given RoleName. */
function statementsFor(roleName: string): Statement[] {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } });
  const logicalIds = Object.keys(roles);
  expect(logicalIds).toHaveLength(1);
  const out: Statement[] = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const attached = (policy.Properties.Roles as { Ref: string }[]).map((r) => r.Ref);
    if (attached.includes(logicalIds[0])) out.push(...(policy.Properties.PolicyDocument.Statement as Statement[]));
  }
  return out;
}

const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement): string[] =>
  (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map((r) => JSON.stringify(r));
const ssmStatements = (stmts: Statement[]) => stmts.filter((s) => actionsOf(s).some((a) => a.startsWith('ssm:')));

describe('SSM namespace scoping (ARCHITECTURE §6.6.4)', () => {
  const instance = statementsFor('enshrouded-server-instance');
  const bot = statementsFor('enshrouded-discord-bot');
  const statusChannel = statementsFor('enshrouded-status-channel');

  test('instance role: SSM Allow is server/ only; no discord ARN and no bare enshroudedproj/*', () => {
    const allows = ssmStatements(instance).filter((s) => s.Effect === 'Allow');
    expect(allows.length).toBeGreaterThan(0);
    for (const r of allows.flatMap(resourcesOf)) {
      expect(r).not.toMatch(/parameter\/enshroudedproj\/discord/);
      expect(r).not.toMatch(/parameter\/enshroudedproj\/\*/);
      expect(r).toMatch(/parameter\/enshroudedproj\/server/);
      // ARN trap (§6.6.3): the path's leading slash is the separator.
      expect(r).not.toContain('parameter//');
    }
  });

  test('instance role: explicit Deny on ssm:GetParameter* for the discord/ prefix', () => {
    const denies = ssmStatements(instance).filter((s) => s.Effect === 'Deny');
    expect(denies).toHaveLength(1);
    expect(actionsOf(denies[0])).toContain('ssm:GetParameter*');
    const resources = resourcesOf(denies[0]);
    expect(resources.some((r) => r.includes('parameter/enshroudedproj/discord/*'))).toBe(true);
    for (const r of resources) expect(r).not.toContain('parameter//');
  });

  test('instance role: no ssm:PutParameter (or any ssm write) anywhere', () => {
    for (const s of instance) {
      for (const a of actionsOf(s)) {
        expect(a).not.toMatch(/^ssm:(Put|Delete|\*$)/i);
      }
    }
  });

  test('discord-bot role: no server/ prefix grant, only the single admin-password ARN', () => {
    const resources = ssmStatements(bot)
      .filter((s) => s.Effect === 'Allow')
      .flatMap(resourcesOf);
    const serverResources = resources.filter((r) => r.includes('parameter/enshroudedproj/server'));
    expect(serverResources).toHaveLength(1);
    expect(serverResources[0]).toContain('parameter/enshroudedproj/server/user-groups/admin-password');
    for (const r of resources) {
      expect(r).not.toMatch(/server\/\*/);
      expect(r).not.toMatch(/parameter\/enshroudedproj\/\*/);
      expect(r).not.toContain('parameter//');
    }
  });

  test('discord-bot role: the password ARN is read-only', () => {
    const stmts = ssmStatements(bot).filter((s) => resourcesOf(s).some((r) => r.includes('server/user-groups')));
    expect(stmts).toHaveLength(1);
    expect(actionsOf(stmts[0])).toEqual(['ssm:GetParameter']);
  });

  test('channel selection can write configuration but cannot replace bot credentials', () => {
    const writes = bot.filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('ssm:PutParameter'));
    const discordWrites = writes.flatMap(resourcesOf).filter((r) => r.includes('parameter/enshroudedproj/discord'));
    expect(discordWrites.length).toBeGreaterThan(0);
    for (const r of discordWrites) {
      expect(r).toContain('parameter/enshroudedproj/discord/status-channels/*');
      expect(r).not.toContain('bot-token');
    }
  });

  test('status delivery reads only its config, token and delivery-state parameters', () => {
    const scoped = ssmStatements(statusChannel).filter((s) => s.Effect === 'Allow');
    expect(scoped.length).toBeGreaterThan(0);
    for (const s of scoped) {
      for (const r of resourcesOf(s)) {
        expect(r).toMatch(/parameter\/enshroudedproj\/(discord\/(bot-token|status-channels)|state\/status-channel)/);
        expect(r).not.toContain('parameter//');
        if (actionsOf(s).includes('ssm:PutParameter')) {
          expect(r).toContain('parameter/enshroudedproj/state/status-channel/');
        }
      }
    }
    for (const s of statusChannel) {
      expect(actionsOf(s)).not.toEqual(expect.arrayContaining(['ec2:StartInstances']));
      expect(actionsOf(s)).not.toEqual(expect.arrayContaining(['ec2:StopInstances']));
      expect(actionsOf(s)).not.toContain('ec2:*');
    }
  });
});
