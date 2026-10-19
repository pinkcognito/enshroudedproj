import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { StatusChannel } from '../lib/enshrouded/status-channel';

type Command = { constructor: { name: string }; input: Record<string, unknown> };
const mockSsm = jest.fn();
const mockEc2 = jest.fn();
const mockQuery = jest.fn();
const mockToken = jest.fn();
const mockCommand = (name: string) => ({ [name]: class { constructor(public input: unknown) {} } })[name];
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send(c: Command) { return mockSsm(c); } },
  GetParameterCommand: mockCommand('GetParameterCommand'),
  PutParameterCommand: mockCommand('PutParameterCommand'),
  GetParametersByPathCommand: mockCommand('GetParametersByPathCommand'),
}), { virtual: true });
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class { send(c: Command) { return mockEc2(c); } },
  DescribeInstancesCommand: mockCommand('DescribeInstancesCommand'),
}), { virtual: true });
jest.mock('../lib/enshrouded/lambda/shared/a2s', () => ({ queryInfo: (...args: unknown[]) => mockQuery(...args) }));
jest.mock('../lib/enshrouded/lambda/shared/discord', () => ({
  DISCORD_API: 'https://discord.com/api/v10', DISCORD_USER_AGENT: 'test',
  getBotToken: () => mockToken(),
}));
// Plain JS handler is shipped without transpilation, like the existing shared helpers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lib/enshrouded/lambda/status-channel/index') as {
  handler: (event?: unknown, context?: { getRemainingTimeInMillis: () => number }) => Promise<void>;
};
const CONFIG = '/enshroudedproj/discord/status-channels';
const DELIVERY = '/enshroudedproj/state/status-channel';
const guild = '111111111111111111';
const channel = '222222222222222222';
const guild2 = '333333333333333333';
const channel2 = '444444444444444444';
const config = (guildId = guild, channelId = channel, baseName = 'enshrouded') => ({ guildId, channelId, baseName });
const params = new Map<string, string>();
const now = Date.parse('2026-10-19T12:00:00Z');
let clock = now;
let instance: { InstanceId: string; State: { Name: string }; LaunchTime: Date; PublicIpAddress?: string };
let pages: { Parameters: { Name: string; Value: string }[]; NextToken?: string }[];
let getOverride: ((name: string) => string | undefined) | undefined;
const mockFetch = jest.fn();
const originalFetch = global.fetch;
const response = (status: number, data: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const channelResponse = (id = channel, guildId = guild, name = 'old', type = 0) => response(200, { id, guild_id: guildId, name, type });
const methods = () => mockFetch.mock.calls.map(c => c[1].method);
const stored = () => JSON.parse(params.get(`${DELIVERY}/${guild}/${channel}`) || '{}');
const posts = () => mockFetch.mock.calls.filter(c => c[1].method === 'POST');
const install = (value = config()) => params.set(`${CONFIG}/${value.guildId}`, JSON.stringify(value));

beforeEach(() => {
  jest.clearAllMocks();
  params.clear(); clock = now; getOverride = undefined;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  process.env.INSTANCE_ID = 'i-enshrouded';
  process.env.QUERY_PORT = '15637';
  install();
  pages = [{ Parameters: [{ Name: `${CONFIG}/${guild}`, Value: params.get(`${CONFIG}/${guild}`)! }] }];
  instance = { InstanceId: 'i-enshrouded', State: { Name: 'running' },
    LaunchTime: new Date(now - 3600000), PublicIpAddress: '203.0.113.10' };
  mockSsm.mockImplementation(async (c: Command) => {
    const name = c.input.Name as string;
    if (c.constructor.name === 'GetParametersByPathCommand') return pages[c.input.NextToken ? 1 : 0];
    if (c.constructor.name === 'PutParameterCommand') { params.set(name, c.input.Value as string); return {}; }
    const value = name.startsWith(CONFIG) && getOverride ? getOverride(name) : params.get(name);
    if (value === undefined) throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
    return { Parameter: { Value: value } };
  });
  mockEc2.mockImplementation(async () => ({ Reservations: [{ Instances: [instance] }] }));
  mockQuery.mockResolvedValue({ ok: true, players: 0 });
  mockToken.mockResolvedValue('test-token');
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) =>
    options.method === 'GET' ? channelResponse() : response(200));
  global.fetch = mockFetch as unknown as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

test('no configuration is a no-op', async () => {
  pages = [{ Parameters: [] }];
  await handler();
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockEc2).not.toHaveBeenCalled();
  expect(mockToken).not.toHaveBeenCalled();
});

test('paginates without decryption, validates configs, describes and probes just once for all guilds', async () => {
  install(config(guild2, channel2));
  pages[0].NextToken = 'next';
  pages.push({ Parameters: [
    { Name: `${CONFIG}/${guild2}`, Value: params.get(`${CONFIG}/${guild2}`)! },
    { Name: `${CONFIG}/bad`, Value: 'invalid' },
  ] });
  mockFetch.mockImplementation(async (url: string, options: { method: string }) => options.method === 'GET'
    ? (url.endsWith(channel2) ? channelResponse(channel2, guild2) : channelResponse()) : response(200));
  await handler({ detail: { 'instance-id': 'i-foreign', state: 'stopped' } });
  const list = mockSsm.mock.calls.map(c => c[0] as Command).filter(c => c.constructor.name === 'GetParametersByPathCommand');
  expect(list.map(c => c.input)).toEqual([
    { Path: CONFIG, Recursive: true, WithDecryption: false },
    { Path: CONFIG, Recursive: true, WithDecryption: false, NextToken: 'next' },
  ]);
  expect(mockEc2).toHaveBeenCalledTimes(1);
  expect(mockEc2.mock.calls[0][0].input).toEqual({ InstanceIds: ['i-enshrouded'] });
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockQuery).toHaveBeenCalledWith({ host: '203.0.113.10', port: 15637, timeoutMs: 2500 });
  expect(posts()).toHaveLength(2);
});

test('zero players is green, messages disable mentions, HTTP calls have timeouts', async () => {
  await handler();
  expect(JSON.parse(posts()[0][1].body)).toEqual({
    content: '🟢 Server online (query responding). Join via the dedicated server list.', allowed_mentions: { parse: [] },
  });
  expect(JSON.parse(mockFetch.mock.calls.find(c => c[1].method === 'PATCH')![1].body)).toEqual({ name: '🟢-enshrouded' });
  for (const call of mockFetch.mock.calls) expect(call[1].signal).toBeInstanceOf(AbortSignal);
});

test.each(['stopped', 'terminated', 'pending', 'stopping'])('%s uses fresh EC2 state and never probes', async state => {
  instance.State.Name = state;
  await handler({ detail: { state: 'running' } });
  expect(mockQuery).not.toHaveBeenCalled();
  const semantic = ['stopped', 'terminated'].includes(state) ? 'offline' : state === 'pending' ? 'starting' : 'stopping';
  expect(JSON.parse(posts()[0][1].body).content).toBe(`🔴 Server ${semantic}.`);
  expect(JSON.parse(mockFetch.mock.calls.find(c => c[1].method === 'PATCH')![1].body).name).toBe('🔴-enshrouded');
});

test.each([0, 899999, 900000, 3600000])('failed A2S at boot age %i has bounded starting grace and never reports offline', async age => {
  instance.LaunchTime = new Date(now - age);
  mockQuery.mockResolvedValue({ ok: false, reason: 'timeout' });
  await handler();
  expect(JSON.parse(posts()[0][1].body).content).toBe(`🔴 Server ${age < 900000 ? 'starting' : 'unknown'}.`);
});

test('missing public IP never falls back to localhost', async () => {
  delete instance.PublicIpAddress;
  await handler();
  expect(mockQuery).not.toHaveBeenCalled();
  expect(JSON.parse(posts()[0][1].body).content).toBe('🔴 Server unknown.');
});

test('unexpected query rejection and missing instance both remain unknown', async () => {
  mockQuery.mockRejectedValue(new Error('query failed'));
  await handler();
  expect(JSON.parse(posts()[0][1].body).content).toBe('🔴 Server unknown.');
  mockFetch.mockClear();
  mockQuery.mockClear();
  mockEc2.mockResolvedValue({ Reservations: [{ Instances: [{ ...instance, InstanceId: 'i-foreign' }] }] });
  await handler();
  expect(mockQuery).not.toHaveBeenCalled();
  expect(JSON.parse(posts()[0][1].body).content).toBe('🔴 Server unknown.');
});

test('lookup failure is unknown, never offline; logs exclude exception details', async () => {
  mockEc2.mockRejectedValue(new Error('test-token https://secret.invalid'));
  await handler();
  expect(JSON.parse(posts()[0][1].body).content).toBe('🔴 Server unknown.');
  expect(JSON.stringify((console.log as jest.Mock).mock.calls)).not.toMatch(/test-token|https:/);
});

test('initial snapshot then semantic or boot change only; actual matching names skip PATCH', async () => {
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) =>
    options.method === 'GET' ? channelResponse(channel, guild, '🟢-enshrouded') : response(200));
  await handler(); await handler();
  expect(posts()).toHaveLength(1);
  expect(methods()).not.toContain('PATCH');
  instance.LaunchTime = new Date(now - 1000);
  await handler();
  expect(posts()).toHaveLength(2);
  instance.State.Name = 'stopping';
  await handler();
  expect(posts()).toHaveLength(3);
});

test('rename 429 preserves successful message and retries only rename when due', async () => {
  let renamed = false;
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) => {
    if (options.method === 'GET') return channelResponse();
    if (options.method === 'PATCH' && !renamed) return response(429, { retry_after: 120 });
    return response(200);
  });
  await handler();
  expect(stored().messageKey).toMatch(/^online:/);
  expect(stored().rename).toBeUndefined();
  expect(stored().renameRetryAt).toBe(now + 120000);
  await handler();
  expect(methods().filter(m => m === 'PATCH')).toHaveLength(1);
  clock += 120001; renamed = true;
  await handler();
  expect(methods().filter(m => m === 'PATCH')).toHaveLength(2);
  expect(posts()).toHaveLength(1);
  expect(stored().rename).toBe('🟢-enshrouded');
});

test('message 429 preserves rename success and retries message without PATCH', async () => {
  let renamed = false;
  let limited = true;
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) => {
    if (options.method === 'GET') return channelResponse(channel, guild, renamed ? '🟢-enshrouded' : 'old');
    if (options.method === 'PATCH') renamed = true;
    if (options.method === 'POST' && limited) return response(429, { retry_after: 90 });
    return response(200);
  });
  await handler(); await handler();
  expect(stored().messageKey).toBeUndefined();
  expect(stored().rename).toBe('🟢-enshrouded');
  expect(posts()).toHaveLength(1);
  clock += 90001; limited = false;
  await handler();
  expect(posts()).toHaveLength(2);
  expect(methods().filter(m => m === 'PATCH')).toHaveLength(1);
});

test('global 429 is durable and suppresses every route until due', async () => {
  mockFetch.mockResolvedValue(response(429, { retry_after: 120, global: true }));
  await handler();
  expect(JSON.parse(params.get(`${DELIVERY}/global-rate-limit`)!)).toEqual({ retryAt: now + 120000 });
  await handler();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  clock += 120001;
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) =>
    options.method === 'GET' ? channelResponse() : response(200));
  await handler();
  expect(posts()).toHaveLength(1);
});

test('429 on PATCH prevents subsequent POST globally and resumes both after cooldown', async () => {
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) =>
    options.method === 'GET' ? channelResponse() : response(429, { retry_after: 60, global: true }));
  await handler();
  expect(methods()).toEqual(['GET', 'PATCH']);
  expect(stored().messageKey).toBeUndefined();
  expect(stored().rename).toBeUndefined();
  clock += 60001;
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) =>
    options.method === 'GET' ? channelResponse() : response(200));
  await handler();
  expect(stored().rename).toBe('🟢-enshrouded');
  expect(stored().messageKey).toMatch(/^online:/);
});

test('zero retry_after has a minimum cooldown and prevents tight retries', async () => {
  mockFetch.mockResolvedValue(response(429, { retry_after: 0 }));
  await handler();
  expect(stored().lookupRetryAt).toBe(now + 1000);
  await handler();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test.each([403, 500, 'timeout'])('failed message %s never advances success', async failure => {
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) => {
    if (options.method === 'GET') return channelResponse();
    if (options.method === 'POST') {
      if (failure === 'timeout') throw new Error('test-token https://secret.invalid');
      return response(failure as number);
    }
    return response(200);
  });
  await handler();
  expect(stored().messageKey).toBeUndefined();
  expect(stored().rename).toBe('🟢-enshrouded');
  expect(JSON.stringify((console.log as jest.Mock).mock.calls)).not.toMatch(/test-token|https:/);
});

test('configuration replaced since listing causes no delivery', async () => {
  install(config(guild, channel2));
  await handler();
  expect(mockFetch).not.toHaveBeenCalled();
});

test('configuration replaced during channel lookup blocks mutations', async () => {
  mockFetch.mockImplementation(async () => { install(config(guild, channel2)); return channelResponse(); });
  await handler();
  expect(methods()).toEqual(['GET']);
});

test.each([{ guildId: guild2, type: 0 }, { guildId: guild, type: 2 }, { guildId: guild, type: 5 }])('rejects mismatched guild or unsupported channel type %j', async ({ guildId, type }) => {
  mockFetch.mockResolvedValue(channelResponse(channel, guildId, 'old', type));
  await handler();
  expect(methods()).toEqual(['GET']);
  expect(params.has(`${DELIVERY}/${guild}/${channel}`)).toBe(false);
});

test('one guild failure does not prevent another guild delivery', async () => {
  install(config(guild2, channel2, 'my-server'));
  pages[0].Parameters.push({ Name: `${CONFIG}/${guild2}`, Value: params.get(`${CONFIG}/${guild2}`)! });
  getOverride = name => { if (name === `${CONFIG}/${guild}`) throw new Error('failed'); return params.get(name); };
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) =>
    options.method === 'GET' ? channelResponse(channel2, guild2) : response(200));
  await handler();
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(mockFetch.mock.calls.find(c => c[1].method === 'PATCH')![1].body).name).toBe('🟢-my-server');
});

test('round robin reaches the final guild across repeated slow, time-limited invocations', async () => {
  const guild3 = '555555555555555555';
  const channel3 = '666666666666666666';
  const configs = [config(), config(guild2, channel2), config(guild3, channel3)];
  configs.forEach(c => install(c));
  // Deliberately unsorted: fairness must not depend on the list API's ordering.
  pages[0].Parameters = [...configs].reverse().map(c => ({
    Name: `${CONFIG}/${c.guildId}`, Value: JSON.stringify(c),
  }));
  let remaining = 45000;
  const visited: string[] = [];
  mockFetch.mockImplementation(async (url: string, options: { method: string }) => {
    if (options.method !== 'GET') return response(200);
    const index = configs.findIndex(c => url.endsWith(c.channelId));
    visited.push(configs[index].guildId);
    // The next candidate is durable before the first route call for this guild.
    expect(JSON.parse(params.get(`${DELIVERY}/cursor`)!)).toEqual({
      nextGuildId: configs[(index + 1) % configs.length].guildId,
    });
    remaining = 10000;
    return channelResponse(configs[index].channelId, configs[index].guildId);
  });
  for (let tick = 0; tick < 3; tick++) {
    remaining = 45000;
    await handler({}, { getRemainingTimeInMillis: () => remaining });
  }
  expect(visited).toEqual([guild, guild2, guild3]);
  expect(posts()).toHaveLength(3);
  expect(JSON.parse(params.get(`${DELIVERY}/cursor`)!)).toEqual({ nextGuildId: guild });
});

test('time guard leaves the next candidate unchanged until a tick can process it', async () => {
  install(config(guild2, channel2));
  pages[0].Parameters.push({ Name: `${CONFIG}/${guild2}`, Value: params.get(`${CONFIG}/${guild2}`)! });
  params.set(`${DELIVERY}/cursor`, JSON.stringify({ nextGuildId: guild2 }));
  for (let tick = 0; tick < 3; tick++) {
    await handler({}, { getRemainingTimeInMillis: () => 14999 });
  }
  expect(mockFetch).not.toHaveBeenCalled();
  expect(JSON.parse(params.get(`${DELIVERY}/cursor`)!)).toEqual({ nextGuildId: guild2 });
  expect(mockSsm.mock.calls.some(([c]: [Command]) => c.constructor.name === 'PutParameterCommand')).toBe(false);
  let remaining = 45000;
  mockFetch.mockImplementation(async (_url: string, options: { method: string }) => {
    remaining = 10000;
    return options.method === 'GET' ? channelResponse(channel2, guild2) : response(200);
  });
  await handler({}, { getRemainingTimeInMillis: () => remaining });
  expect(mockFetch.mock.calls[0][0]).toMatch(new RegExp(`/channels/${channel2}$`));
  expect(JSON.parse(params.get(`${DELIVERY}/cursor`)!)).toEqual({ nextGuildId: guild });
});

test('failed slow guild does not monopolize subsequent invocations', async () => {
  install(config(guild2, channel2));
  pages[0].Parameters.push({ Name: `${CONFIG}/${guild2}`, Value: params.get(`${CONFIG}/${guild2}`)! });
  let remaining = 45000;
  mockFetch.mockImplementation(async (url: string, options: { method: string }) => {
    remaining = 10000;
    if (url.endsWith(channel)) throw new Error('timeout');
    return options.method === 'GET' ? channelResponse(channel2, guild2) : response(200);
  });
  await handler({}, { getRemainingTimeInMillis: () => remaining });
  expect(JSON.parse(params.get(`${DELIVERY}/cursor`)!)).toEqual({ nextGuildId: guild2 });
  remaining = 45000;
  await handler({}, { getRemainingTimeInMillis: () => remaining });
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0]).toContain(`/channels/${channel2}/messages`);
});

test('delivery reads and writes stay within owned prefix; config reads are nondecrypting', async () => {
  await handler();
  for (const [c] of mockSsm.mock.calls as [Command][]) {
    if (c.constructor.name === 'PutParameterCommand') expect(c.input.Name).toMatch(new RegExp(`^${DELIVERY}/`));
    if (c.constructor.name === 'GetParameterCommand') {
      expect(c.input.WithDecryption).toBe(false);
      expect(String(c.input.Name)).toMatch(new RegExp(`^(${CONFIG}|${DELIVERY})/`));
    }
  }
});

test('construct synthesizes runtime, scoped IAM, tags, assets and minute/event wakeups', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'EnshroudedStatusChannelTest', {
    stackName: 'EnshroudedStatusChannelTest', env: { account: '123456789012', region: 'us-east-2' },
  });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 1, natGateways: 0 });
  const image = new cdk.CfnParameter(stack, 'TestImage', { type: 'AWS::EC2::Image::Id' });
  const host = new ec2.Instance(stack, 'Host', { vpc,
    instanceType: new ec2.InstanceType('r6i.large'), machineImage: ec2.MachineImage.genericLinux({ 'us-east-2': image.valueAsString }),
  });
  const status = new StatusChannel(stack, 'Status', { instance: host });
  expect(status.function).toBeDefined();
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'enshrouded-status-channel', Runtime: 'nodejs22.x', MemorySize: 256,
    Timeout: 45, ReservedConcurrentExecutions: 1, Handler: 'status-channel/index.handler',
    Environment: { Variables: { INSTANCE_ID: stack.resolve(host.instanceId),
      BOT_TOKEN_PARAM: '/enshroudedproj/discord/bot-token', QUERY_PORT: '15637' } },
    Tags: [{ Key: 'project', Value: 'enshroudedproj' }, { Key: 'repo', Value: 'pinkcognito/enshroudedproj' }],
  });
  template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'enshrouded-status-channel' });
  template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 minute)' });
  template.hasResourceProperties('AWS::Events::Rule', { EventPattern: {
    source: ['aws.ec2'], 'detail-type': ['EC2 Instance State-change Notification'],
    detail: { 'instance-id': [stack.resolve(host.instanceId)], state: ['pending', 'running', 'stopping', 'stopped', 'terminated'] },
  } });
  const policy = Object.values(template.findResources('AWS::IAM::Policy')).find(p =>
    JSON.stringify(p).includes('discord/status-channels'))!;
  const statements = policy.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: string | string[]; Condition?: unknown }[];
  const arn = (p: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' },
    `:ssm:us-east-2:123456789012:parameter/enshroudedproj/${p}`]] });
  expect(statements).toEqual(expect.arrayContaining([
    expect.objectContaining({ Action: 'ssm:GetParametersByPath', Resource: [arn('discord/status-channels'), arn('discord/status-channels/*')] }),
    expect.objectContaining({ Action: 'ssm:GetParameter', Resource: [arn('discord/bot-token'), arn('discord/status-channels/*')] }),
    expect.objectContaining({ Action: ['ssm:GetParameter', 'ssm:PutParameter'], Resource: arn('state/status-channel/*') }),
    expect.objectContaining({ Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': 'ssm.us-east-2.amazonaws.com' } } }),
    expect.objectContaining({ Action: 'ec2:DescribeInstances', Resource: '*' }),
  ]));
  expect(statements).toHaveLength(5);
  expect(JSON.stringify(policy)).not.toMatch(/StartInstances|StopInstances|SendCommand|server\//);
});
