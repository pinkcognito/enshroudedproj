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

  // DELIBERATE WIDENING (ARCHITECTURE 6.6.2a / 6.6.4 assertion 3). This test used to assert the
  // bot held exactly ONE server/ ARN (admin-password). A four-tier cascade plus rotation needs
  // all four, so the expected set is now four - and it is still an EXACT set: no fifth
  // server/ parameter, no prefix, no wildcard inside the path.
  const PASSWORD_ARNS = ['admin', 'friend', 'guest', 'visitor'].map(
    (g) => `arn:aws:ssm:us-east-2:123456789012:parameter/enshroudedproj/server/user-groups/${g}-password`,
  );
  // ARNs synthesise as Fn::Join over AWS::Partition; flatten to the plain 'aws' form.
  const flat = (v: unknown): string => {
    const j = (v as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
    if (j) return j[1].map((p) => (typeof p === 'string' ? p : 'aws')).join(j[0]);
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  const flatList = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map(flat).sort();
  const serverArnsOf = (stmts: Statement[], action: string) =>
    stmts
      .filter((s) => s.Effect === 'Allow' && actionsOf(s).includes(action))
      .flatMap(resourcesOf)
      .filter((r) => r.includes('parameter/enshroudedproj/server'))
      .map((r) => flat(JSON.parse(r)))
      .sort();
  const kmsStatements = (stmts: Statement[]) =>
    stmts.filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
  const paramArnCondition = (s: Statement) =>
    ((s as unknown as { Condition?: Record<string, Record<string, unknown>> }).Condition ?? {})
      .StringEquals?.['kms:EncryptionContext:PARAMETER_ARN'];

  test('discord-bot role: WIDENED from one to exactly four server/ ARNs (6.6.2a); no prefix, no wildcard', () => {
    const resources = ssmStatements(bot).filter((s) => s.Effect === 'Allow').flatMap(resourcesOf);
    const serverResources = resources.filter((r) => r.includes('parameter/enshroudedproj/server'));
    expect(serverArnsOf(bot, 'ssm:GetParameter')).toEqual([...PASSWORD_ARNS].sort());
    expect(serverArnsOf(bot, 'ssm:PutParameter')).toEqual([...PASSWORD_ARNS].sort());
    for (const r of serverResources) {
      expect(r).not.toMatch(/server\/\*|\*/);
      expect(r).toMatch(/server\/user-groups\/(admin|friend|guest|visitor)-password"/);
    }
    for (const r of resources) {
      expect(r).not.toMatch(/parameter\/enshroudedproj\/\*/);
      expect(r).not.toContain('parameter//');
    }
  });

  test('discord-bot role: PutParameter has no server/ ARN beyond the four and no discord/ ARN beyond status-channels/*', () => {
    const writes = bot.filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('ssm:PutParameter')).flatMap(resourcesOf);
    for (const r of writes.filter((x) => x.includes('/discord'))) {
      expect(r).toContain('parameter/enshroudedproj/discord/status-channels/*');
    }
    for (const r of writes.filter((x) => x.includes('/server'))) {
      expect(PASSWORD_ARNS).toContain(flat(JSON.parse(r)));
    }
  });

  const BOT_TOKEN_ARN = 'arn:aws:ssm:us-east-2:123456789012:parameter/enshroudedproj/discord/bot-token';
  // Item 6, part 1: the bot is NEVER exemptible. Positive, exact lists.
  test('discord-bot KMS: Encrypt = exactly the four password ARNs, Decrypt = those four + bot-token, no sixth, none unconditioned (6.6.4 item 6)', () => {
    const stmts = kmsStatements(bot).filter((s) => s.Effect === 'Allow');
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      const pinned = paramArnCondition(s);
      expect(pinned).toBeDefined();
      const expected = actionsOf(s).includes('kms:Decrypt') ? [...PASSWORD_ARNS, BOT_TOKEN_ARN] : PASSWORD_ARNS;
      expect(flatList(pinned)).toEqual([...expected].sort());
    }
    expect(stmts.filter((s) => actionsOf(s).includes('kms:Encrypt'))).toHaveLength(1);
    expect(stmts.filter((s) => actionsOf(s).includes('kms:Decrypt'))).toHaveLength(1);
  });

  // Item 6, part 2: EVERY role in the stack, not a remembered list, so a fourth principal
  // cannot arrive unpinned. WP-26 is done: there is no exemption list. Do not add one.
  // (The old graceful-stop.ts comment claimed the AWS-managed key's lack of a stable ARN
  // prevented pinning. That conflated the KEY arn with the PARAMETER arn; PARAMETER_ARN pins
  // the parameter, verified from CloudTrail 2026-10-19T22:54:46Z.)
  test('every role in the stack pins every kms:Encrypt/Decrypt grant with PARAMETER_ARN, no exemptions (6.6.4 item 6)', () => {
    const roleNames = new Map<string, string>();
    for (const [id, r] of Object.entries(template.findResources('AWS::IAM::Role'))) {
      roleNames.set(id, (r.Properties.RoleName as string) ?? id);
    }
    const unpinned = new Set<string>();
    let kmsGrants = 0;
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      const attached = (policy.Properties.Roles as { Ref: string }[]).map((r) => roleNames.get(r.Ref) ?? r.Ref);
      for (const s of policy.Properties.PolicyDocument.Statement as Statement[]) {
        if (s.Effect !== 'Allow') continue;
        const kms = actionsOf(s).some((a) => a === 'kms:Encrypt' || a === 'kms:Decrypt' || a === 'kms:*' || a === '*');
        if (!kms) continue;
        kmsGrants++;
        if (paramArnCondition(s) === undefined) attached.forEach((n) => unpinned.add(n));
      }
    }
    expect(kmsGrants).toBeGreaterThanOrEqual(5);
    expect([...unpinned]).toEqual([]);
  });

  // WP-26: exact pinned sets, each justified from the role's actual SecureString reads.
  const SECURE_READS: Record<string, string[]> = {
    // getBotToken only; discord/status-channels/* and state/* are String reads.
    'enshrouded-status-channel': [BOT_TOKEN_ARN],
    // getBotToken only; state/last-player-seen is a String.
    'enshrouded-graceful-stop': [BOT_TOKEN_ARN],
    // render-config.sh: the four tier passwords; server/name and server/slot-count are Strings.
    'enshrouded-server-instance': PASSWORD_ARNS,
  };
  test.each(Object.keys(SECURE_READS))('%s: kms:Decrypt pinned to exactly its SecureString reads, ViaService kept, no kms:Encrypt (WP-26)', (roleName) => {
    const stmts = kmsStatements(statementsFor(roleName)).filter((s) => s.Effect === 'Allow');
    expect(stmts).toHaveLength(1);
    expect(actionsOf(stmts[0])).toEqual(['kms:Decrypt']);
    expect(flatList(paramArnCondition(stmts[0]))).toEqual([...SECURE_READS[roleName]].sort());
    const cond = (stmts[0] as unknown as { Condition: { StringEquals: Record<string, unknown> } }).Condition.StringEquals;
    expect(cond['kms:ViaService']).toBe('ssm.us-east-2.amazonaws.com');
    for (const s of statementsFor(roleName)) {
      expect(actionsOf(s)).not.toContain('kms:Encrypt');
      expect(actionsOf(s)).not.toContain('kms:*');
    }
  });

  test('exactly one principal writes the password parameters: no role other than discord-bot holds ssm:PutParameter on them (6.6.4 item 9)', () => {
    const botId = Object.keys(template.findResources('AWS::IAM::Role', { Properties: { RoleName: 'enshrouded-discord-bot' } }))[0];
    let botWrites = 0;
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      const attached = (policy.Properties.Roles as { Ref: string }[]).map((r) => r.Ref);
      for (const s of policy.Properties.PolicyDocument.Statement as Statement[]) {
        if (s.Effect !== 'Allow' || !actionsOf(s).some((a) => a === 'ssm:PutParameter' || a === 'ssm:*' || a === '*')) continue;
        const touchesPasswords = resourcesOf(s).some((r) => r.includes('server/user-groups') || r.includes('server/*') || r === '"*"');
        if (!touchesPasswords) continue;
        expect(attached).toEqual([botId]);
        botWrites++;
      }
    }
    expect(botWrites).toBeGreaterThan(0);
  });

  test('boot-watcher role (when it exists): same four server/ read ARNs and no PutParameter on any server/ ARN', () => {
    const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: 'enshrouded-boot-watcher' } });
    if (Object.keys(roles).length === 0) return; // WP-12/WP-24 not built yet; this arms itself when it lands.
    const watcher = statementsFor('enshrouded-boot-watcher');
    expect(serverArnsOf(watcher, 'ssm:GetParameter')).toEqual([...PASSWORD_ARNS].sort());
    expect(serverArnsOf(watcher, 'ssm:PutParameter')).toEqual([]);
    for (const s of kmsStatements(watcher)) {
      expect(actionsOf(s)).not.toContain('kms:Encrypt');
    }
  });

  test('status-channel role has no server/ SSM resource at all', () => {
    for (const r of ssmStatements(statusChannel).flatMap(resourcesOf)) {
      expect(r).not.toContain('parameter/enshroudedproj/server');
    }
  });

  test('instance role still has no ssm:PutParameter and no kms:Encrypt', () => {
    for (const s of instance) {
      expect(actionsOf(s)).not.toContain('ssm:PutParameter');
      expect(actionsOf(s)).not.toContain('kms:Encrypt');
      expect(actionsOf(s)).not.toContain('kms:*');
    }
  });

  test('discord-bot role: rotation state parameters are reachable via state/* and no label/policy actions are granted', () => {
    for (const s of bot) {
      for (const a of actionsOf(s)) {
        expect(a).not.toMatch(/^ssm:(LabelParameterVersion|UnlabelParameterVersion|PutResourcePolicy)$/);
      }
    }
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
