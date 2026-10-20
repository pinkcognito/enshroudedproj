import * as crypto from 'crypto';

const mockEc2 = jest.fn();
const mockSsm = jest.fn();
const mockInvoke = jest.fn();
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class { send(command: unknown) { return mockEc2(command); } },
  DescribeInstancesCommand: class { constructor(public input: unknown) {} },
  StartInstancesCommand: class { constructor(public input: unknown) {} },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send(command: unknown, options: unknown) { return mockSsm(command, options); } },
  GetParameterCommand: class { constructor(public input: unknown) {} },
  PutParameterCommand: class { constructor(public input: unknown) {} },
}), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send(command: unknown) { return mockInvoke(command); } },
  InvokeCommand: class { constructor(public input: unknown) {} },
}), { virtual: true });

// Authorization (WP-23) is covered in command-auth.test.ts. These tests are about the announcement
// and count REST/SSM calls exactly, so the live-member gate is stubbed to allow here.
jest.mock('../lib/enshrouded/lambda/discord-bot/password-access', () => ({
  ...jest.requireActual('../lib/enshrouded/lambda/discord-bot/password-access'),
  authorizeCommand: async () => ({ groups: ['visitor'] }),
}));

const guildId = '123456789012345678', userId = '234567890123456789', channelId = '345678901234567890';
const configName = `/enshroudedproj/discord/status-channels/${guildId}`;
const globalName = '/enshroudedproj/state/status-channel/global-rate-limit';
const instanceId = 'i-enshrouded-test';
const transition = { InstanceId: instanceId, PreviousState: { Name: 'stopped' }, CurrentState: { Name: 'pending' } };
const startRole = '901234567890123456';
const event = { _internal: 'finish-start', interactionToken: 'interaction-secret', guildId, userId, roleIds: [startRole] };
const channel = { id: channelId, guild_id: guildId, type: 0 };
const parameters = new Map<string, string>();
const oldEnv = process.env;
let handler: (event: object, context?: object) => Promise<unknown>;
let announceStarter: (event: object, budget: number) => Promise<void>;
const response = (body: object, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const calls = (method: string) => jest.mocked(fetch).mock.calls.filter(([, options]) => options?.method === method);
// The start path now reads/clears the WP-21 rotation parameters; these tests are about the
// announcement, so ignore those two names (and only those) when asserting on SSM use.
const announcementSsm = () => mockSsm.mock.calls.filter(([cmd]) => !cmd.input.WithDecryption &&
  !/^\/enshroudedproj\/(state\/(rotate-on-start|password-desync)|discord\/password-access\/\d+)$/.test(cmd.input.Name));
const stopped = () => ({ Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }] });
const expectBooting = () => {
  expect(calls('PATCH')).toHaveLength(1);
  expect(JSON.parse(calls('PATCH')[0][1]?.body as string).content).toContain('Booting');
};
beforeEach(() => {
  jest.resetModules();
  process.env = { ...oldEnv, INSTANCE_ID: instanceId, DISCORD_APPLICATION_ID: 'app', BOT_TOKEN_PARAM: '/enshroudedproj/discord/bot-token' };
  ({ handler } = jest.requireActual('../lib/enshrouded/lambda/discord-bot/index'));
  ({ announceStarter } = jest.requireActual('../lib/enshrouded/lambda/discord-bot/starter-announcement'));
  parameters.clear();
  parameters.set(configName, JSON.stringify({ guildId, channelId, baseName: 'world' }));
  mockEc2.mockReset().mockResolvedValueOnce(stopped()).mockResolvedValue({ StartingInstances: [transition] });
  mockInvoke.mockReset().mockResolvedValue({});
  mockSsm.mockReset().mockImplementation((command) => {
    const input = command.input;
    if (input.WithDecryption) return Promise.resolve({ Parameter: { Value: 'bot-secret' } });
    if (input.Type) { parameters.set(input.Name, input.Value); return Promise.resolve({}); }
    if (parameters.has(input.Name)) return Promise.resolve({ Parameter: { Value: parameters.get(input.Name) } });
    return Promise.reject(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
  });
  jest.spyOn(global, 'fetch').mockImplementation(async () => response(channel));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); process.env = oldEnv; });

test('signed identity reaches worker without making start ephemeral; tampering is rejected', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  process.env.DISCORD_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const body = JSON.stringify({ id: 'interaction', token: 'interaction-secret', type: 2, guild_id: guildId,
    member: { user: { id: userId }, roles: [startRole] }, user: { id: channelId },
    data: { name: 'enshrouded', options: [{ type: 1, name: 'start' }] } });
  const timestamp = '1700000000';
  const headers = { 'x-signature-timestamp': timestamp,
    'x-signature-ed25519': crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString('hex') };
  expect(await handler({ body, headers })).toEqual({ statusCode: 202, body: '' });
  expect(JSON.parse(jest.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({ type: 5 });
  expect(JSON.parse(mockInvoke.mock.calls[0][0].input.Payload)).toEqual(event);
  mockInvoke.mockClear();
  expect(await handler({ body: body.replace(userId, channelId), headers })).toEqual(expect.objectContaining({ statusCode: 401 }));
  expect(mockInvoke).not.toHaveBeenCalled();
});

test('successful transition replies first then posts to verified same-guild channel with no pings', async () => {
  await handler(event);
  expectBooting();
  expect(jest.mocked(fetch).mock.calls[0][1]?.method).toBe('PATCH');
  expect(jest.mocked(fetch).mock.calls[1][0]).toBe(`https://discord.com/api/v10/channels/${channelId}`);
  expect(calls('POST')).toHaveLength(1);
  expect(calls('POST')[0][0]).toBe(`https://discord.com/api/v10/channels/${channelId}/messages`);
  expect(JSON.parse(calls('POST')[0][1]?.body as string)).toEqual({
    content: `\u{1f680} Server start requested by <@${userId}>.`, allowed_mentions: { parse: [] },
  });
  const signals = announcementSsm().filter(([cmd]) => !cmd.input.WithDecryption).map(([, options]) => options.abortSignal);
  expect(signals.every((signal) => signal === jest.mocked(fetch).mock.calls[1][1]?.signal)).toBe(true);
  expect(calls('POST')[0][1]?.signal).toBe(signals[0]);
});

test.each(['running', 'pending', 'stopping'])('already %s never starts or announces', async (state) => {
  mockEc2.mockReset().mockResolvedValue({ Reservations: [{ Instances: [{ State: { Name: state } }] }] });
  await handler(event);
  expect(mockEc2).toHaveBeenCalledTimes(1);
  expect(announcementSsm()).toHaveLength(0);
  expect(calls('POST')).toHaveLength(0);
});

test('start failure never announces', async () => {
  mockEc2.mockReset().mockResolvedValueOnce(stopped()).mockRejectedValueOnce(new Error('start rejected'));
  await handler(event);
  expect(announcementSsm()).toHaveLength(0);
  expect(calls('POST')).toHaveLength(0);
  expect(JSON.parse(calls('PATCH')[0][1]?.body as string).content).toContain('Failed to start');
});

test('a confirmed new start queues readiness with identity but no passwords', async () => {
  process.env.BOOT_WATCHER_FUNCTION_NAME = 'enshrouded-boot-watcher';
  mockEc2.mockReset().mockResolvedValueOnce(stopped()).mockResolvedValueOnce({ StartingInstances: [transition] })
    .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: instanceId,
      State: { Name: 'pending' }, LaunchTime: new Date() }] }] });
  const before = Date.now();
  await handler(event);
  expect(mockInvoke).toHaveBeenCalledTimes(1);
  const input = mockInvoke.mock.calls[0][0].input;
  expect(input.FunctionName).toBe('enshrouded-boot-watcher');
  expect(input.InvocationType).toBe('Event');
  const payload = JSON.parse(input.Payload);
  expect(payload).toMatchObject({ guildId, userId, roleIds: [startRole], interactionToken: 'interaction-secret' });
  expect(payload.startedAt).toBeGreaterThanOrEqual(before);
  expect(Object.keys(payload).sort()).toEqual(['expectedLaunchTime', 'guildId', 'interactionToken', 'roleIds', 'startedAt', 'userId']);
  expectBooting();
});

test('readiness dispatch failure cannot turn a successful start into a failure', async () => {
  process.env.BOOT_WATCHER_FUNCTION_NAME = 'enshrouded-boot-watcher';
  mockEc2.mockReset().mockResolvedValueOnce(stopped()).mockResolvedValueOnce({ StartingInstances: [transition] })
    .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: instanceId,
      State: { Name: 'pending' }, LaunchTime: new Date() }] }] });
  mockInvoke.mockRejectedValueOnce(new Error('secret-containing-request'));
  await handler(event);
  expectBooting();
  expect(console.error).toHaveBeenCalledWith('Boot readiness dispatch failed: invocation-failed');
  expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('secret-containing-request');
  expect(JSON.parse(calls('PATCH')[0][1]?.body as string).content).toContain('submission could not be confirmed');
});

test('an ambiguous post-start launch declines tracking and gives a private fallback', async () => {
  process.env.BOOT_WATCHER_FUNCTION_NAME = 'enshrouded-boot-watcher';
  mockEc2.mockReset().mockResolvedValueOnce(stopped()).mockResolvedValueOnce({ StartingInstances: [transition] })
    .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: instanceId,
      State: { Name: 'pending' }, LaunchTime: new Date(Date.now() - 60000) }] }] });
  await handler(event);
  expect(mockInvoke).not.toHaveBeenCalled();
  expect(JSON.parse(calls('PATCH')[0][1]?.body as string).content).toContain('Readiness tracking is unavailable');
});

test('already running never queues automatic password delivery', async () => {
  process.env.BOOT_WATCHER_FUNCTION_NAME = 'enshrouded-boot-watcher';
  mockEc2.mockReset().mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] });
  await handler(event);
  expect(mockInvoke).not.toHaveBeenCalled();
});

test.each([{}, { StartingInstances: [] },
  { StartingInstances: [{ ...transition, InstanceId: 'i-other' }] },
  { StartingInstances: [{ ...transition, PreviousState: { Name: 'pending' } }] },
  { StartingInstances: [{ ...transition, CurrentState: { Name: 'running' } }] },
])('unconfirmed, concurrent or retried transition skips attribution: %j', async (result) => {
  mockEc2.mockReset().mockResolvedValueOnce(stopped()).mockResolvedValueOnce(result);
  await handler(event);
  expect(announcementSsm()).toHaveLength(0);
  expect(calls('POST')).toHaveLength(0);
  expectBooting();
});

test.each([{ guildId: undefined }, { guildId: 'bad' }, { userId: undefined }, { userId: '<@everyone>' }])('invalid identity skips: %j', async (overrides) => {
  await handler({ ...event, ...overrides });
  expect(announcementSsm()).toHaveLength(0);
  expectBooting();
});

test.each([undefined, '{', JSON.stringify({ guildId: userId, channelId, baseName: 'world' }), JSON.stringify({ guildId, channelId: 'bad', baseName: 'world' })])('invalid or missing config skips: %j', async (value) => {
  if (value === undefined) parameters.delete(configName); else parameters.set(configName, value);
  await handler(event);
  expect(fetch).toHaveBeenCalledTimes(1);
  expectBooting();
});

test.each([{ guild_id: userId }, { id: guildId }, { type: 5 }, { type: 11 }])('lookup validates guild, ID, and type: %j', async (overrides) => {
  jest.mocked(fetch).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({ ...channel, ...overrides }));
  await handler(event);
  expect(calls('POST')).toHaveLength(0);
});

test.each(['read', 'lookup', 'post'])('notification %s failure preserves boot reply and sanitized logs', async (stage) => {
  if (stage === 'read') {
    // Fail only the announcement's reads; the start authorization's own reads still succeed.
    const send = mockSsm.getMockImplementation();
    mockSsm.mockImplementation((command, options) => command.input.WithDecryption || /password-access/.test(command.input.Name)
      ? send?.(command, options) : Promise.reject(new Error('bot-secret https://discord.com/interaction-secret')));
  }
  else {
    jest.mocked(fetch).mockResolvedValueOnce(response({}));
    if (stage === 'post') jest.mocked(fetch).mockResolvedValueOnce(response(channel));
    jest.mocked(fetch).mockRejectedValueOnce(new Error('bot-secret https://discord.com/interaction-secret'));
  }
  await handler(event);
  expectBooting();
  const logs = JSON.stringify(jest.mocked(console.error).mock.calls);
  expect(logs).not.toMatch(/bot-secret|interaction-secret|https:/);
});

test('reply failure still announces without reporting start failed', async () => {
  jest.mocked(fetch).mockRejectedValueOnce(new Error('interaction-secret'));
  await handler(event);
  expect(calls('PATCH')).toHaveLength(1);
  expect(calls('POST')).toHaveLength(1);
  expect(console.error).toHaveBeenCalledWith('Server start reply failed: network-or-timeout');
});

test('global cooldown prevents token lookup and all bot REST calls', async () => {
  parameters.set(globalName, JSON.stringify({ retryAt: Date.now() + 60000 }));
  await handler(event);
  expect(fetch).toHaveBeenCalledTimes(1);
  // Exactly one token read: the start authorization's. The announcement made none.
  expect(mockSsm.mock.calls.filter(([cmd]) => cmd.input.WithDecryption)).toHaveLength(1);
});

test.each(['lookup', 'post'])('global 429 on %s persists cooldown without retries', async (stage) => {
  jest.mocked(fetch).mockResolvedValueOnce(response({}));
  if (stage === 'post') jest.mocked(fetch).mockResolvedValueOnce(response(channel));
  const now = Date.now();
  jest.mocked(fetch).mockResolvedValueOnce(response({ global: true, retry_after: 12.25 }, 429));
  await handler(event);
  expect(JSON.parse(parameters.get(globalName) as string).retryAt).toBeGreaterThanOrEqual(now + 12250);
  expect(fetch).toHaveBeenCalledTimes(stage === 'post' ? 3 : 2);
  expect(mockSsm.mock.calls.filter(([cmd]) => cmd.input.Type)).toHaveLength(1);
});

test('route 429 never writes global cooldown or retries', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({ global: false, retry_after: 1 }, 429));
  await handler(event);
  expect(calls('POST')).toHaveLength(0);
  expect(parameters.has(globalName)).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(['token', 'channel'])('shared total budget bounds stalled %s and prevents late POST', async (stage) => {
  jest.useFakeTimers();
  let complete!: (value: unknown) => void;
  const stalled = new Promise((resolve) => { complete = resolve; });
  if (stage === 'token') {
    const send = mockSsm.getMockImplementation();
    mockSsm.mockImplementation((command, options) => command.input.WithDecryption ? stalled : send?.(command, options));
  } else jest.mocked(fetch).mockReturnValueOnce(stalled as Promise<Response>);
  const notification = announceStarter(event, 1000);
  await jest.advanceTimersByTimeAsync(1000);
  await notification;
  complete(stage === 'token' ? { Parameter: { Value: 'bot-secret' } } : response(channel));
  await jest.advanceTimersByTimeAsync(10000);
  expect(calls('POST')).toHaveLength(0);
});

test('exhausted remaining Lambda time skips notification after reply', async () => {
  await handler(event, { getRemainingTimeInMillis: () => 400 });
  expect(announcementSsm()).toHaveLength(0);
  expectBooting();
});
