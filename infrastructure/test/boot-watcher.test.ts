export {};

const mockEc2 = jest.fn();
const mockSsm = jest.fn();
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: mockEc2 })),
  DescribeInstancesCommand: class { constructor(public input: unknown) {} },
}), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => {
  const command = (kind: string) => class { constructor(public input: unknown) {} kind = kind; };
  return {
    SSMClient: jest.fn(() => ({ send: mockSsm })),
    DescribeInstanceInformationCommand: command('online'),
    SendCommandCommand: command('send'),
    GetCommandInvocationCommand: command('invocation'),
  };
}, { virtual: true });
jest.mock('../lib/enshrouded/lambda/shared/discord', () => ({
  ...jest.requireActual('../lib/enshrouded/lambda/shared/discord'),
  editOriginalResponse: jest.fn().mockResolvedValue(true),
  getBotToken: jest.fn().mockResolvedValue('fixture-token'),
}));
jest.mock('../lib/enshrouded/lambda/shared/a2s', () => ({ queryInfo: jest.fn() }));
jest.mock('../lib/enshrouded/lambda/discord-bot/rotation', () => ({
  readParameter: jest.fn(), readPasswords: jest.fn(), desyncActive: jest.fn(),
}));

const { handler } = jest.requireActual('../lib/enshrouded/lambda/boot-watcher');
const { editOriginalResponse, getBotToken } = jest.requireMock('../lib/enshrouded/lambda/shared/discord');
const { queryInfo } = jest.requireMock('../lib/enshrouded/lambda/shared/a2s');
const { readParameter, readPasswords, desyncActive } = jest.requireMock('../lib/enshrouded/lambda/discord-bot/rotation');
const { EC2Client } = jest.requireMock('@aws-sdk/client-ec2');
const { SSMClient } = jest.requireMock('@aws-sdk/client-ssm');
const base = Date.parse('2026-10-19T12:00:00Z');
const instanceId = 'i-0123456789abcdef0';
const guildId = '123456789012345678';
const userId = '234567890123456789';
const dmId = '345678901234567890';
const roles = { admin: '456789012345678901', friend: '567890123456789012',
  guest: '678901234567890123', visitor: '789012345678901234' };
const event = () => ({ guildId, userId, roleIds: [roles.friend], interactionToken: 'fixture-interaction',
  startedAt: base, expectedLaunchTime: new Date(base).toISOString(),
  priorLaunchTime: new Date(base - 86400000).toISOString() });
const instance = (overrides = {}) => ({ InstanceId: instanceId, State: { Name: 'running' },
  LaunchTime: new Date(base), PublicIpAddress: '203.0.113.10', ...overrides });
const ec2Response = (value = instance()) => ({ Reservations: [{ Instances: [value] }] });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const patches = () => editOriginalResponse.mock.calls.map((call: unknown[]) => call[2]).join('\n');
const dmPosts = () => jest.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/messages'));
const run = async (payload = event(), remaining = 510000) => {
  const task = handler(payload, { getRemainingTimeInMillis: () => remaining });
  await jest.runAllTimersAsync();
  await task;
};

beforeEach(() => {
  jest.useFakeTimers({ now: base });
  jest.clearAllMocks();
  process.env.INSTANCE_ID = instanceId;
  process.env.DISCORD_APPLICATION_ID = '111111111111111111';
  mockEc2.mockReset().mockResolvedValue(ec2Response());
  mockSsm.mockReset().mockImplementation(async ({ kind }: { kind: string }) => {
    if (kind === 'online') return { InstanceInformationList: [{ InstanceId: instanceId, PingStatus: 'Online' }] };
    if (kind === 'send') return { Command: { CommandId: 'command-1' } };
    if (kind === 'invocation') return { Status: 'Success', ResponseCode: 0, StandardOutputContent: 'ready\n' };
    throw new Error('unexpected-command');
  });
  editOriginalResponse.mockReset().mockResolvedValue(true);
  getBotToken.mockReset().mockResolvedValue('fixture-token');
  queryInfo.mockReset().mockResolvedValue({ ok: true, players: 0, maxPlayers: 16 });
  readParameter.mockReset().mockResolvedValue(JSON.stringify({ guildId, roles }));
  readPasswords.mockReset().mockResolvedValue({ friend: 'fixture-friend-secret', guest: 'fixture-guest-secret', visitor: 'fixture-visitor-secret' });
  desyncActive.mockReset().mockResolvedValue(false);
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('/members/')) return response({ user: { id: userId }, roles: [roles.friend] });
    if (String(url).endsWith('/users/@me/channels')) return response({ id: dmId, type: 1, recipients: [{ id: userId }] });
    if (String(url).endsWith(`/channels/${dmId}/messages`)) return response({ id: 'message' });
    throw new Error('unexpected-fetch');
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Only fixed metric/outcome records may be logged, never event/response/error objects.
  const logs = JSON.stringify([jest.mocked(console.log).mock.calls, jest.mocked(console.error).mock.calls]);
  expect(logs).not.toMatch(/fixture-|interactionToken|roleIds|203\.0\.113/);
  expect(patches()).not.toMatch(/fixture-|15636|456789012345678901|567890123456789012/);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('cold start gates are ordered; fresh tier reads DM the same user and join via the server list', async () => {
  mockEc2.mockResolvedValueOnce(ec2Response(instance({ State: { Name: 'pending' } })));
  const started = Date.now();
  await run();
  expect(Date.now() - started).toBe(20000);
  expect(mockEc2.mock.calls.every(([command]) => JSON.stringify(command.input) === JSON.stringify({ InstanceIds: [instanceId] }))).toBe(true);
  expect(EC2Client).toHaveBeenCalledWith({ maxAttempts: 1 });
  expect(SSMClient).toHaveBeenCalledWith({ maxAttempts: 1 });
  const commands = mockSsm.mock.calls.map(([command]) => command);
  expect(commands.map((command) => command.kind)).toEqual(['online', 'send', 'online', 'invocation']);
  expect(commands[0].input).toEqual({ Filters: [{ Key: 'InstanceIds', Values: [instanceId] }] });
  expect(commands[1].input).toEqual(expect.objectContaining({ InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript', Parameters: { commands: [expect.stringContaining('systemctl is-active --quiet enshrouded.service && awk')], executionTimeout: ['20'] } }));
  expect(commands[1].input.Parameters.commands[0]).toContain('/:3D15$/');
  expect(commands[1].input.Parameters.commands[0]).toContain('/proc/net/udp');
  expect(commands[1].input.Parameters.commands[0]).not.toMatch(/journalctl|json|cat |password|HostOnline|15636/);
  expect(queryInfo).toHaveBeenCalledWith({ host: '203.0.113.10', port: 15637, timeoutMs: 3000 });
  expect(patches()).toContain('World loading');
  expect(patches()).toContain('public query path');
  expect(patches()).toContain('dedicated server list and select your server');
  expect(readParameter).toHaveBeenCalledWith(`/enshroudedproj/discord/password-access/${guildId}`);
  expect(readPasswords).toHaveBeenCalledWith(['friend', 'guest', 'visitor']);
  expect(readParameter.mock.invocationCallOrder[0]).toBeGreaterThan(queryInfo.mock.invocationCallOrder[0]);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/users/@me/channels'), expect.objectContaining({ body: JSON.stringify({ recipient_id: userId }) }));
  const body = JSON.parse(String(dmPosts()[0][1]?.body));
  expect(body.content).toBe('Enshrouded passwords\nfriend: fixture-friend-secret\nguest: fixture-guest-secret\nvisitor: fixture-visitor-secret');
  expect(body.allowed_mentions).toEqual({ parse: [] });
  expect(console.log).not.toHaveBeenCalled();
});

test.each(['Offline', 'ConnectionLost'])('gate 1 waits for scoped SSM Online (%s)', async (PingStatus) => {
  mockSsm.mockResolvedValue({ InstanceInformationList: [{ InstanceId: instanceId, PingStatus },
    { InstanceId: 'i-foreign', PingStatus: 'Online' }] });
  await run();
  expect(Date.now() - base).toBeLessThanOrEqual(480000);
  expect(patches()).toContain('gate 1');
  expect(queryInfo).not.toHaveBeenCalled();
  expect(readPasswords).not.toHaveBeenCalled();
});

test.each([
  { Status: 'Success', ResponseCode: 0, StandardOutputContent: 'not-ready' },
  { Status: 'Success', ResponseCode: 1, StandardOutputContent: 'ready' },
  { Status: 'Failed', ResponseCode: 1, StandardOutputContent: 'ready' },
])('gate 2 requires successful command and exact ready flag: %j', async (invocation) => {
  mockSsm.mockImplementation(async ({ kind }: { kind: string }) => kind === 'online'
    ? { InstanceInformationList: [{ InstanceId: instanceId, PingStatus: 'Online' }] }
    : kind === 'send' ? { Command: { CommandId: 'command-1' } } : invocation);
  await run();
  expect(patches()).toContain('gate 2');
  expect(queryInfo).not.toHaveBeenCalled();
  expect(readPasswords).not.toHaveBeenCalled();
});

test('polls one in-flight SSM command at 10s intervals, including invocation visibility errors', async () => {
  let polls = 0;
  mockSsm.mockImplementation(async ({ kind }: { kind: string }) => {
    if (kind === 'online') return { InstanceInformationList: [{ InstanceId: instanceId, PingStatus: 'Online' }] };
    if (kind === 'send') return { Command: { CommandId: 'command-1' } };
    polls++;
    if (polls === 1) throw new Error('InvocationDoesNotExist');
    return polls === 2 ? { Status: 'InProgress' } : { Status: 'Success', ResponseCode: 0, StandardOutputContent: 'ready' };
  });
  await run();
  expect(Date.now() - base).toBe(30000);
  expect(mockSsm.mock.calls.filter(([command]) => command.kind === 'send')).toHaveLength(1);
  expect(dmPosts()).toHaveLength(1);
});

test('blocked public query fails gate 3 within 8 minutes, emits dimensionless EMF and never DMs', async () => {
  queryInfo.mockResolvedValue({ ok: false, reason: 'timeout' });
  await run();
  expect(Date.now() - base).toBe(480000);
  expect(patches()).toContain('gate 3: public query did not respond; check firewall or bind');
  expect(readParameter).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
  expect(JSON.parse(jest.mocked(console.log).mock.calls[0][0])).toEqual({
    _aws: { Timestamp: base + 480000, CloudWatchMetrics: [{ Namespace: 'Enshrouded', Dimensions: [[]],
      Metrics: [{ Name: 'BootReadinessFailed', Unit: 'Count' }] }] }, BootReadinessFailed: 1,
  });
});

test.each([
  { LaunchTime: undefined }, { LaunchTime: 'not-a-date' },
  { LaunchTime: new Date(base - 31000) }, { LaunchTime: new Date(base + 61000) },
  { LaunchTime: new Date(base - 86400000) },
])('unknown, old, and implausible sessions cannot advance: %j', async (override) => {
  mockEc2.mockResolvedValue(ec2Response(instance(override)));
  await run();
  expect(patches()).toContain('gate 1');
  expect(mockSsm).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
});

test('prior launch exclusion wins even inside the clock skew window; a fresh launch can follow', async () => {
  const payload = { ...event(), priorLaunchTime: new Date(base - 10000).toISOString() };
  mockEc2.mockResolvedValueOnce(ec2Response(instance({ LaunchTime: new Date(base - 10000) })));
  await run(payload);
  expect(Date.now() - base).toBe(20000);
  expect(dmPosts()).toHaveLength(1);
});

test.each([-5000, 0, 5000])('accepts only the captured launch offset %i within five seconds', async (offset) => {
  if (offset > 0) jest.setSystemTime(base + offset);
  mockEc2.mockResolvedValue(ec2Response(instance({ LaunchTime: new Date(base + offset) })));
  await run({ ...event(), expectedLaunchTime: new Date(base + offset).toISOString() });
  expect(dmPosts()).toHaveLength(1);
});

test.each([undefined, null, base, 'not-an-iso-date', '2026-10-19',
  new Date(base - 5001).toISOString(), new Date(base + 5001).toISOString(),
])('invalid expectedLaunchTime %s fails before any probes or credentials', async (expectedLaunchTime) => {
  await run({ ...event(), expectedLaunchTime } as ReturnType<typeof event>);
  expect(mockEc2).not.toHaveBeenCalled();
  expect(mockSsm).not.toHaveBeenCalled();
  expect(queryInfo).not.toHaveBeenCalled();
  expect(readParameter).not.toHaveBeenCalled();
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
  expect(patches()).toContain('invalid expected boot');
});

test.each([1000, 10000])('queued 20 seconds cannot adopt a replacement launch at +%i ms', async (offset) => {
  jest.setSystemTime(base + 20000);
  mockEc2.mockResolvedValue(ec2Response(instance({ LaunchTime: new Date(base + offset) })));
  await run();
  expect(mockEc2).toHaveBeenCalledTimes(1);
  expect(mockSsm).not.toHaveBeenCalled();
  expect(queryInfo).not.toHaveBeenCalled();
  expect(readParameter).not.toHaveBeenCalled();
  expect(getBotToken).not.toHaveBeenCalled();
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
  expect(patches()).toContain('original boot is no longer confirmed');
});

test('queued 20 seconds can still confirm the exact captured boot', async () => {
  jest.setSystemTime(base + 20000);
  await run();
  expect(dmPosts()).toHaveLength(1);
});

test('expected launch equal to the prior launch fails closed', async () => {
  await run({ ...event(), priorLaunchTime: new Date(base).toISOString() });
  expect(mockEc2).not.toHaveBeenCalled();
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
});

test.each(['stopped', 'stopping', 'shutting-down', 'terminated', 'later-boot'])('no DM after %s during polling', async (state) => {
  mockEc2.mockResolvedValueOnce(ec2Response()).mockResolvedValue(ec2Response(instance(state === 'later-boot'
    ? { LaunchTime: new Date(base + 1000) } : { State: { Name: state } })));
  await run();
  expect(patches()).toContain('original boot is no longer confirmed');
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
});

test('unknown launch after pinning never reuses earlier readiness', async () => {
  mockEc2.mockResolvedValueOnce(ec2Response()).mockResolvedValue(ec2Response(instance({ LaunchTime: undefined })));
  await run();
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
});

test('final fresh describe refuses a changed public address after A2S', async () => {
  mockEc2.mockResolvedValueOnce(ec2Response()).mockResolvedValueOnce(ec2Response())
    .mockResolvedValue(ec2Response(instance({ PublicIpAddress: '203.0.113.11' })));
  await run();
  expect(patches()).not.toContain('Server ready');
  expect(dmPosts()).toHaveLength(0);
});

test.each(['revoked', 'newly-granted', 'no-tier', 'wrong-member', 'member-fetch-failed'])('live authorization blocks %s without secret reads or denial text', async (scenario) => {
  jest.mocked(fetch).mockResolvedValue(response({ user: { id: scenario === 'wrong-member' ? dmId : userId },
    roles: scenario === 'newly-granted' ? [roles.admin] : [] }, scenario === 'member-fetch-failed' ? 403 : 200));
  await run({ ...event(), roleIds: scenario === 'no-tier' ? [] : [roles.friend] });
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
  expect(patches()).toContain('Server ready');
  expect(patches()).not.toMatch(/denied|do not have|role|group/i);
});

test.each(['active', 'unreadable', 'malformed-mapping'])('fails closed for %s', async (scenario) => {
  if (scenario === 'active') desyncActive.mockResolvedValue(true);
  if (scenario === 'unreadable') desyncActive.mockRejectedValue(new Error('fixture-sensitive-error'));
  if (scenario === 'malformed-mapping') readParameter.mockResolvedValue('{');
  await run();
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
});

test.each(['stopped', 'later-boot', 'desync'])('rechecks the session and desync after password reads: %s', async (change) => {
  readPasswords.mockImplementation(async () => {
    if (change === 'desync') desyncActive.mockResolvedValue(true);
    else mockEc2.mockResolvedValue(ec2Response(instance(change === 'stopped'
      ? { State: { Name: 'stopped' } } : { LaunchTime: new Date(base + 1000) })));
    return { friend: 'fixture-friend-secret', guest: 'fixture-guest-secret', visitor: 'fixture-visitor-secret' };
  });
  await run();
  expect(readPasswords).toHaveBeenCalledTimes(1);
  expect(dmPosts()).toHaveLength(0);
});

test('closed DMs preserve readiness and privately suggest pw; no retry', async () => {
  const normal = jest.mocked(fetch).getMockImplementation()!;
  jest.mocked(fetch).mockImplementation(async (url, options) => String(url).endsWith('/messages')
    ? response({}, 403) : normal(url, options));
  await run();
  expect(dmPosts()).toHaveLength(1);
  expect(patches()).toContain('Server ready');
  expect(patches()).toContain('/enshrouded pw');
  expect(console.log).not.toHaveBeenCalled();
});

test('PATCH exceptions cannot suppress the DM or escape after success', async () => {
  editOriginalResponse.mockRejectedValue(new Error('fixture-interaction fixture-friend-secret'));
  await run();
  expect(dmPosts()).toHaveLength(1);
  expect(jest.mocked(console.log).mock.calls).toEqual([
    [JSON.stringify({ event: 'boot-watcher-patch', outcome: 'unconfirmed' })],
    [JSON.stringify({ event: 'boot-watcher-patch', outcome: 'unconfirmed' })],
    [JSON.stringify({ event: 'boot-watcher-patch', outcome: 'unconfirmed' })],
  ]);
});

test('false PATCH results log only a coarse outcome and cannot prevent the DM', async () => {
  editOriginalResponse.mockResolvedValue(false);
  await run();
  expect(dmPosts()).toHaveLength(1);
  expect(jest.mocked(console.log).mock.calls).toEqual([
    [JSON.stringify({ event: 'boot-watcher-patch', outcome: 'rejected' })],
    [JSON.stringify({ event: 'boot-watcher-patch', outcome: 'rejected' })],
    [JSON.stringify({ event: 'boot-watcher-patch', outcome: 'rejected' })],
  ]);
});

test('transient EC2 failures retry at cadence', async () => {
  mockEc2.mockRejectedValueOnce(new Error('fixture-sensitive-error'));
  await run();
  expect(Date.now() - base).toBe(20000);
  expect(dmPosts()).toHaveLength(1);
});

test('context budget shortens the deadline; event age never extends it', async () => {
  mockEc2.mockImplementation(() => new Promise(() => {}));
  await run({ ...event(), startedAt: base - 470000,
    expectedLaunchTime: new Date(base - 470000).toISOString() }, 510000);
  expect(mockEc2).toHaveBeenCalled();
  expect(Date.now() - base).toBeLessThanOrEqual(10000);
  expect(patches()).toContain('gate 1');
  expect(dmPosts()).toHaveLength(0);
});

test('short Lambda budget terminates even a stalled SDK', async () => {
  mockEc2.mockImplementation(() => new Promise(() => {}));
  await run(event(), 20000);
  expect(Date.now() - base).toBeLessThanOrEqual(15000);
  expect(dmPosts()).toHaveLength(0);
});

test('a hung shared secret read is bounded and cannot deliver later', async () => {
  readPasswords.mockImplementation(() => new Promise(() => {}));
  await run();
  expect(Date.now() - base).toBe(13000);
  expect(dmPosts()).toHaveLength(0);
  expect(patches()).toContain('/enshrouded pw');
});

test('reserves five seconds of Lambda budget for a final failure PATCH when polling work stalls', async () => {
  const edits: { at: number; timeout: number; content: string }[] = [];
  mockEc2.mockImplementation(() => new Promise(() => {}));
  editOriginalResponse.mockImplementation(async (_app: string, _token: string, content: string, timeout: number) => {
    edits.push({ at: Date.now(), timeout, content });
    await new Promise((resolve) => setTimeout(resolve, 1900));
    return true;
  });
  await run(event(), 20000);
  expect(edits).toEqual([{ at: base + 14000, timeout: 2000,
    content: expect.stringContaining('Readiness failed at gate 1') }]);
  expect(Date.now() - base).toBe(15900);
  expect(dmPosts()).toHaveLength(0);
});

test('work reaching the operational deadline cannot start a DM but can still PATCH privately', async () => {
  readPasswords.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return { friend: 'fixture-friend-secret', guest: 'fixture-guest-secret', visitor: 'fixture-visitor-secret' };
  });
  // Gate 2 completes at 10 seconds, leaving 1 second of operational budget.
  await run(event(), 17000);
  expect(dmPosts()).toHaveLength(0);
  expect(Date.now() - base).toBeLessThanOrEqual(16000);
  expect(patches()).toContain('Password delivery could not be confirmed; use /enshrouded pw');
});

test('only explicit caller identifiers reach helpers; event password fields are ignored', async () => {
  await run({ ...event(), passwords: { admin: 'payload-secret-must-not-be-used' } } as ReturnType<typeof event>);
  expect(JSON.stringify(dmPosts())).not.toContain('payload-secret-must-not-be-used');
  expect(patches()).not.toContain('payload-secret-must-not-be-used');
  expect(dmPosts()).toHaveLength(1);
});

test('does not guess a name or interpolate untrusted A2S text into the private reply', async () => {
  queryInfo.mockResolvedValue({ ok: true, info: { name: '@everyone **World** <@123>\n' } });
  await run();
  expect(patches()).not.toContain('@everyone');
  expect(patches()).toContain('dedicated server list and select your server');
});

test.each([NaN, base + 1000, base - 480000])('invalid/future/expired startedAt %s cannot probe or DM', async (startedAt) => {
  await run({ ...event(), startedAt });
  expect(mockEc2).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
});

test('481-second-old event gets a fresh two-second terminal PATCH without probes or credentials', async () => {
  jest.setSystemTime(base + 481000);
  const enteredAt = Date.now();
  editOriginalResponse.mockImplementation(async (_app: string, _token: string, _content: string, timeout: number) => {
    expect(timeout).toBe(2000);
    await new Promise((resolve) => setTimeout(resolve, 1900));
    return true;
  });
  await run();
  expect(Date.now() - enteredAt).toBe(1900);
  expect(editOriginalResponse).toHaveBeenCalledTimes(1);
  expect(patches()).toContain('time budget expired');
  expect(mockEc2).not.toHaveBeenCalled();
  expect(mockSsm).not.toHaveBeenCalled();
  expect(queryInfo).not.toHaveBeenCalled();
  expect(readParameter).not.toHaveBeenCalled();
  expect(getBotToken).not.toHaveBeenCalled();
  expect(readPasswords).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([510000, 2000])('expired-event terminal PATCH is bounded by two seconds and Lambda budget (%i ms)', async (lambdaRemaining) => {
  jest.setSystemTime(base + 481000);
  const enteredAt = Date.now();
  editOriginalResponse.mockImplementation(() => new Promise(() => {}));
  await run(event(), lambdaRemaining);
  const budget = Math.min(2000, lambdaRemaining - 1000);
  expect(Date.now() - enteredAt).toBe(budget);
  expect(editOriginalResponse).toHaveBeenCalledWith(process.env.DISCORD_APPLICATION_ID,
    'fixture-interaction', expect.stringContaining('time budget expired'), budget);
  expect(mockEc2).not.toHaveBeenCalled();
  expect(readPasswords).not.toHaveBeenCalled();
  expect(dmPosts()).toHaveLength(0);
  expect(JSON.parse(jest.mocked(console.log).mock.calls.at(-1)![0])).toEqual({
    event: 'boot-watcher-patch', outcome: 'unconfirmed',
  });
});
