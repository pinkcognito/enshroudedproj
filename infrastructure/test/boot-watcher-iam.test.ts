import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

const app = new cdk.App({ context: { discordApplicationId: '123456789012345678' } });
cdk.Tags.of(app).add('project', 'enshroudedproj');
cdk.Tags.of(app).add('repo', 'pinkcognito/enshroudedproj');
const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
  stackName: 'EnshroudedServerStack',
  env: { account: '123456789012', region: 'us-east-2' },
});
// Template synthesis also checks for dependency cycles from the bot's cross-function grant.
const template = Template.fromStack(stack);
const list = <T>(value: T | T[]): T[] => Array.isArray(value) ? value : [value];
const actionsOf = (s: Statement): string[] => list(s.Action);

function statementsFor(roleName: string): Statement[] {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } });
  expect(Object.keys(roles)).toHaveLength(1);
  const roleId = Object.keys(roles)[0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

const watcher = statementsFor('enshrouded-boot-watcher');
const allows = watcher.filter((s) => s.Effect === 'Allow');
const forAction = (action: string) => allows.filter((s) => actionsOf(s).includes(action));
const parameter = (suffix: string) => stack.resolve(
  `arn:${stack.partition}:ssm:us-east-2:123456789012:parameter/enshroudedproj/${suffix}`,
);
const passwords = ['admin', 'friend', 'guest', 'visitor'].map((g) => parameter(`server/user-groups/${g}-password`));
const token = parameter('discord/bot-token');
const instanceArn = stack.resolve(stack.formatArn({
  service: 'ec2', resource: 'instance', resourceName: stack.server.instance.instanceId,
}));

describe('boot-watcher infrastructure and least privilege', () => {
  test('one readiness failure in five minutes alarms without dimensions or notification actions', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { AlarmName: 'enshrouded-boot-readiness-failed' },
    });
    expect(Object.keys(alarms)).toHaveLength(1);
    const properties = Object.values(alarms)[0].Properties;
    expect(properties).toMatchObject({
      Namespace: 'Enshrouded', MetricName: 'BootReadinessFailed',
      Statistic: 'Sum', Period: 300, Threshold: 1, EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
    });
    expect(properties.Dimensions ?? []).toEqual([]);
    for (const action of ['AlarmActions', 'OKActions', 'InsufficientDataActions']) {
      expect(properties[action] ?? []).toEqual([]);
    }
    expect(properties.Tags).toEqual(expect.arrayContaining([
      { Key: 'project', Value: 'enshroudedproj' },
      { Key: 'repo', Value: 'pinkcognito/enshroudedproj' },
    ]));
  });

  test('one bounded Node 22 invocation, async retries disabled, no reserved concurrency', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'enshrouded-boot-watcher' },
    });
    expect(Object.keys(functions)).toHaveLength(1);
    const [id, resource] = Object.entries(functions)[0];
    expect(resource.Properties).toMatchObject({
      Runtime: 'nodejs22.x', MemorySize: 256, Timeout: 510,
      Handler: 'boot-watcher/index.handler',
      Environment: { Variables: {
        INSTANCE_ID: stack.resolve(stack.server.instance.instanceId),
        DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID ?? '123456789012345678',
        BOT_TOKEN_PARAM: '/enshroudedproj/discord/bot-token',
      } },
    });
    expect(resource.Properties).not.toHaveProperty('ReservedConcurrentExecutions');
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: id }, Qualifier: '$LATEST',
      MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 600,
    });
    const bot = Object.values(template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'enshrouded-discord-bot' },
    }))[0];
    expect(resource.Properties.Code).toEqual(bot.Properties.Code);
    expect(resource.Properties.Role).toEqual(stack.resolve(stack.bootWatcher.function.role!.roleArn));
  });

  test('wildcard observations are limited to the three unscopable read-only APIs', () => {
    const observations = allows.filter((s) => list(s.Resource).includes('*') && !actionsOf(s).includes('kms:Decrypt'));
    expect(observations.flatMap(actionsOf).sort()).toEqual([
      'ec2:DescribeInstances', 'ssm:DescribeInstanceInformation', 'ssm:GetCommandInvocation',
    ]);
    for (const s of observations) expect(list(s.Resource)).toEqual(['*']);
  });

  test('RunCommand can target only our instance using AWS-RunShellScript', () => {
    const commands = forAction('ssm:SendCommand');
    expect(commands).toHaveLength(1);
    expect(list(commands[0].Resource)).toEqual([
      instanceArn,
      stack.resolve(stack.formatArn({
        service: 'ssm', account: '', resource: 'document', resourceName: 'AWS-RunShellScript',
      })),
    ]);
  });

  test('GetParameter reads exactly four passwords, token, guild mapping and desync latch', () => {
    const reads = forAction('ssm:GetParameter');
    expect(reads).toHaveLength(1);
    expect(list(reads[0].Resource)).toEqual([
      ...passwords, token, parameter('discord/password-access/*'), parameter('state/password-desync'),
    ]);
  });

  test('Decrypt is pinned to exactly five SecureStrings through regional SSM', () => {
    const kms = allows.filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
    expect(kms).toHaveLength(1);
    expect(actionsOf(kms[0])).toEqual(['kms:Decrypt']);
    expect(list(kms[0].Resource)).toEqual(['*']);
    expect(kms[0].Condition).toEqual({ StringEquals: {
      'kms:ViaService': 'ssm.us-east-2.amazonaws.com',
      'kms:EncryptionContext:PARAMETER_ARN': [token, ...passwords],
    } });
  });

  test('complete worker allowlist excludes SSM writes, EC2 lifecycle and Lambda invocation', () => {
    expect(allows.flatMap(actionsOf).sort()).toEqual([
      'ec2:DescribeInstances', 'kms:Decrypt', 'ssm:DescribeInstanceInformation',
      'ssm:GetCommandInvocation', 'ssm:GetParameter', 'ssm:SendCommand',
    ]);
    const role = Object.values(template.findResources('AWS::IAM::Role', {
      Properties: { RoleName: 'enshrouded-boot-watcher' },
    }))[0];
    expect(role.Properties.ManagedPolicyArns).toEqual([stack.resolve(
      `arn:${stack.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
    )]);
    expect(role.Properties).not.toHaveProperty('Policies');
  });

  test('bot receives the worker name and a scoped invoke grant; worker has no self-invoke', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'enshrouded-discord-bot',
      Environment: { Variables: {
        BOOT_WATCHER_FUNCTION_NAME: stack.resolve(stack.bootWatcher.function.functionName),
      } },
    });
    const invokes = statementsFor('enshrouded-discord-bot')
      .filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('lambda:InvokeFunction'));
    const workerArn = stack.resolve(stack.bootWatcher.function.functionArn);
    const workerGrants = invokes.filter((s) => list(s.Resource).some((r) => JSON.stringify(r) === JSON.stringify(workerArn)));
    expect(workerGrants).toHaveLength(1);
    // CDK grantInvoke includes qualified versions/aliases of this function as well.
    expect(list(workerGrants[0].Resource)).toEqual([
      workerArn, stack.resolve(`${stack.bootWatcher.function.functionArn}:*`),
    ]);
    expect(forAction('lambda:InvokeFunction')).toEqual([]);
  });

  test('worker function and role inherit both project tags', () => {
    for (const type of ['AWS::Lambda::Function', 'AWS::IAM::Role']) {
      const name = type === 'AWS::Lambda::Function' ? 'FunctionName' : 'RoleName';
      const resource = Object.values(template.findResources(type, {
        Properties: { [name]: 'enshrouded-boot-watcher' },
      }))[0];
      expect(resource.Properties.Tags).toEqual(expect.arrayContaining([
        { Key: 'project', Value: 'enshroudedproj' },
        { Key: 'repo', Value: 'pinkcognito/enshroudedproj' },
      ]));
    }
  });
});
