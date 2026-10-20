// WP-21: rotation in the start path (7.4.3) and /enshrouded pw (7.4.4).
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
// The generator is owned by a parallel change; pin only the interface this WP depends on.
const GENERATED = { admin: 'gen-admin-aaa-bbb-ccc', friend: 'gen-friend-ddd', guest: 'gen-guest-eee', visitor: 'gen-visitor-fff' };
jest.mock('../lib/enshrouded/lambda/discord-bot/password-generator', () => ({
  generatePasswords: () => ({ ...GENERATED }),
}), { virtual: true });

const guildId = '123456789012345678', userId = '234567890123456789', channelId = '345678901234567890';
const dmId = '456789012345678901';
const roles = { admin: '567890123456789012', friend: '678901234567890123',
  guest: '789012345678901234', visitor: '890123456789012345' };
const instanceId = 'i-enshrouded-test';
const P = '/enshroudedproj';
const PW = (g: string) => `${P}/server/user-groups/${g}-password`;
const SWITCH = `${P}/state/rotate-on-start`;
const DESYNC = `${P}/state/password-desync`;
const LIVE = { admin: 'live-admin-1', friend: 'live-friend-2', guest: 'live-guest-3', visitor: 'live-visitor-4' };

const parameters = new Map<string, string>();
const unreadable = new Set<string>();
const ssmLog: { kind: 'get' | 'put'; input: Record<string, unknown> }[] = [];
const order: string[] = [];
const oldEnv = process.env;
let handler: (event: object, context?: object) => Promise<{ statusCode: number; body: string }>;

const response = (body: object, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const stateOf = (name?: string) => ({ Reservations: [{ Instances: [{ State: name ? { Name: name } : undefined }] }] });
const transition = (previous: string, current = 'pending') =>
  ({ StartingInstances: [{ InstanceId: instanceId, PreviousState: { Name: previous }, CurrentState: { Name: current } }] });
const puts = () => ssmLog.filter((l) => l.kind === 'put').map((l) => l.input);
const passwordPuts = () => puts().filter((i) => String(i.Name).includes('/server/user-groups/'));
const fetchCalls = (method: string) => jest.mocked(fetch).mock.calls.filter(([, o]) => o?.method === method);
const edits = () => fetchCalls('PATCH').map(([, o]) => JSON.parse(o?.body as string).content as string);
const dms = () => fetchCalls('POST').filter(([u]) => String(u).includes(`/channels/${dmId}/messages`))
  .map(([, o]) => JSON.parse(o?.body as string).content as string);
const startRole = '901234567890123456';
const startEvent = { _internal: 'finish-start', interactionToken: 'interaction-secret', guildId, userId,
  roleIds: [startRole, ...Object.values(roles)] };
const pwEvent = (roleIds: string[] = Object.values(roles)) =>
  ({ _internal: 'finish-pw', interactionToken: 'interaction-secret', guildId, userId, roleIds });

beforeEach(() => {
  jest.resetModules();
  process.env = { ...oldEnv, INSTANCE_ID: instanceId, DISCORD_APPLICATION_ID: 'app',
    BOT_TOKEN_PARAM: `${P}/discord/bot-token`, AWS_LAMBDA_FUNCTION_NAME: 'enshrouded-discord-bot' };
  ({ handler } = jest.requireActual('../lib/enshrouded/lambda/discord-bot/index'));
  parameters.clear(); unreadable.clear(); ssmLog.length = 0; order.length = 0;
  parameters.set(`${P}/discord/bot-token`, 'bot-secret');
  parameters.set(`${P}/discord/password-access/${guildId}`, JSON.stringify({ guildId, roles, commandRoles: { start: startRole } }));
  for (const g of Object.keys(LIVE)) parameters.set(PW(g), LIVE[g as keyof typeof LIVE]);
  mockEc2.mockReset().mockImplementation(async (command: { constructor: { name: string } }) => {
    order.push(command.constructor.name);
    return command.constructor.name === 'StartInstancesCommand' ? transition('stopped') : stateOf('stopped');
  });
  mockInvoke.mockReset().mockResolvedValue({});
  mockSsm.mockReset().mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const input = command.input;
    const isPut = command.constructor.name === 'PutParameterCommand';
    ssmLog.push({ kind: isPut ? 'put' : 'get', input });
    if (isPut) {
      order.push(`put:${input.Name}`);
      if (input.Name === failPutOn) throw Object.assign(new Error(`denied ${input.Value}`), { name: 'AccessDeniedException' });
      parameters.set(String(input.Name), String(input.Value));
      return {};
    }
    if (unreadable.has(String(input.Name))) throw Object.assign(new Error('boom'), { name: 'InternalServerError' });
    if (parameters.has(String(input.Name))) return { Parameter: { Value: parameters.get(String(input.Name)) } };
    throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
  });
  failPutOn = undefined;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('/guilds/') && u.includes('/members/')) return response({ user: { id: userId }, roles: [startRole, ...Object.values(roles)] });
    if (u.endsWith('/users/@me/channels')) return response({ id: dmId, type: 1, recipients: [{ id: userId }] });
    if (u.includes('/messages') && init?.method === 'POST') return response({});
    if (u.includes(`/channels/${channelId}`)) return response({ id: channelId, guild_id: guildId, type: 0 });
    return response({});
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
let failPutOn: string | undefined;
afterEach(() => { jest.restoreAllMocks(); process.env = oldEnv; });

describe('rotation in the start path (7.4.3)', () => {
  test('switch true + stopped: four SecureString writes, all BEFORE StartInstances, no KeyId/Tier/labels', async () => {
    parameters.set(SWITCH, 'true');
    await handler(startEvent);
    expect(passwordPuts().map((i) => i.Name).sort()).toEqual(['admin', 'friend', 'guest', 'visitor'].map(PW).sort());
    for (const i of passwordPuts()) {
      expect(i).toEqual({ Name: i.Name, Type: 'SecureString', Overwrite: true, Value: expect.any(String) });
    }
    const firstStart = order.indexOf('StartInstancesCommand');
    expect(firstStart).toBeGreaterThan(-1);
    expect(order.filter((o) => o.startsWith('put:/enshroudedproj/server')).length).toBe(4);
    for (const [i, o] of order.entries()) if (o.startsWith('put:/enshroudedproj/server')) expect(i).toBeLessThan(firstStart);
    expect(edits().at(-1)).toContain('Booting');
  });

  test.each(['running', 'pending'])('no rotation and no start when the instance is %s', async (state) => {
    parameters.set(SWITCH, 'true');
    mockEc2.mockReset().mockResolvedValue(stateOf(state));
    await handler(startEvent);
    expect(puts()).toEqual([]);
    expect(mockEc2).toHaveBeenCalledTimes(1);
  });

  test('state observation older than 5 s writes nothing, starts UNROTATED with the warning, emits its own metric, leaves password-desync untouched', async () => {
    parameters.set(SWITCH, 'true');
    parameters.set(DESYNC, 'none');
    let t = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => (t += 6000)); // observation, then the pre-write check 6 s later
    await handler(startEvent);
    expect(passwordPuts()).toEqual([]);
    expect(order.filter((o) => o === 'StartInstancesCommand')).toHaveLength(1);
    expect(order.filter((o) => o === 'DescribeInstancesCommand')).toHaveLength(1); // no re-Describe retry
    expect(puts().find((i) => i.Name === DESYNC)).toBeUndefined();
    const reply = edits().at(-1) as string;
    expect(reply).toContain('Booting');
    expect(reply).toContain('NOT rotated');
    const logged = jest.mocked(console.log).mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('"PasswordRotationStale":1');
    expect(logged).not.toContain('PasswordRotationWriteFailed');
    expect(logged).not.toContain('PasswordDesync');
  });

  test('a fresh observation (well under 5 s) rotates', async () => {
    parameters.set(SWITCH, 'true');
    await handler(startEvent);
    expect(passwordPuts()).toHaveLength(4);
  });

  test('PreviousState != stopped: writes password-desync, emits the metric, sends no announcement', async () => {
    parameters.set(SWITCH, 'true');
    mockEc2.mockReset().mockImplementation(async (c: { constructor: { name: string } }) =>
      c.constructor.name === 'StartInstancesCommand' ? transition('pending', 'pending') : stateOf('stopped'));
    parameters.set(`${P}/discord/status-channels/${guildId}`, JSON.stringify({ guildId, channelId, baseName: 'w' }));
    await handler(startEvent);
    const desync = puts().find((i) => i.Name === DESYNC);
    expect(desync).toBeDefined();
    expect(JSON.parse(String(desync?.Value))).toMatchObject({ previousState: 'pending' });
    const logged = jest.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('"PasswordDesync":1') && l.includes('CloudWatchMetrics'))).toBe(true);
    expect(fetchCalls('POST')).toHaveLength(0);
    expect(edits().at(-1)).toContain('already starting');
  });

  test.each([
    ['absent', undefined], ['false', 'false'], ['malformed', 'maybe'], ['wrong case', 'TRUE'], ['empty', ''],
  ])('rotate-on-start %s means no rotation, and the server still starts', async (_n, value) => {
    if (value !== undefined) parameters.set(SWITCH, value);
    await handler(startEvent);
    expect(passwordPuts()).toEqual([]);
    expect(order).toContain('StartInstancesCommand');
  });

  test('rotate-on-start unreadable means no rotation, and the server still starts', async () => {
    parameters.set(SWITCH, 'true');
    unreadable.add(SWITCH);
    await handler(startEvent);
    expect(passwordPuts()).toEqual([]);
    expect(order).toContain('StartInstancesCommand');
  });

  test('a rotation write failure still starts the server, names the unrotated state, emits its own metric, and leaves password-desync untouched', async () => {
    parameters.set(SWITCH, 'true');
    parameters.set(DESYNC, 'none');
    failPutOn = PW('guest');
    await handler(startEvent);
    expect(order).toContain('StartInstancesCommand');
    // No compensating writes; earlier writes stay (partial rotation is safe).
    expect(puts().filter((i) => i.Name === PW('admin') || i.Name === PW('friend'))).toHaveLength(2);
    expect(puts().every((i) => Object.values(GENERATED).includes(String(i.Value)))).toBe(true);
    expect(puts().find((i) => i.Name === DESYNC)).toBeUndefined();
    expect(parameters.get(DESYNC)).toBe('none');
    const reply = edits().at(-1) as string;
    expect(reply).toContain('Booting');
    expect(reply).toContain('NOT rotated');
    const logged = jest.mocked(console.log).mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('"PasswordRotationWriteFailed":1');
    expect(logged).not.toContain('PasswordRotationStale');
    expect(logged).not.toContain('PasswordDesync');
  });

  test('a successful start with the switch off gives the plain reply (no unrotated warning)', async () => {
    await handler(startEvent);
    expect(edits().at(-1)).not.toContain('NOT rotated');
  });

  test('desync clearing reads before writing: no write when the parameter is absent or already none', async () => {
    parameters.set(DESYNC, 'none');
    await handler(startEvent);
    expect(puts().find((i) => i.Name === DESYNC)).toBeUndefined();
  });

  test('a start from stopped clears a previously set desync; an absent one is left alone', async () => {
    parameters.set(DESYNC, '{"detectedAt":"x","previousState":"running"}');
    await handler(startEvent);
    expect(puts().find((i) => i.Name === DESYNC)?.Value).toBe('none');
    ssmLog.length = 0; parameters.delete(DESYNC);
    await handler(startEvent);
    expect(puts().find((i) => i.Name === DESYNC)).toBeUndefined();
  });

  test('no password reaches any log line, metric, edit, fetch body or non-password parameter', async () => {
    parameters.set(SWITCH, 'true');
    failPutOn = PW('visitor'); // error text embeds the value; it must still not be logged
    await handler(startEvent);
    failPutOn = undefined;
    mockEc2.mockReset().mockImplementation(async (c: { constructor: { name: string } }) =>
      c.constructor.name === 'StartInstancesCommand' ? transition('running', 'running') : stateOf('stopped'));
    await handler(startEvent);
    const secrets = Object.values(GENERATED);
    const haystack = JSON.stringify([
      jest.mocked(console.log).mock.calls, jest.mocked(console.error).mock.calls,
      jest.mocked(fetch).mock.calls.map(([u, o]) => [u, o?.body]),
      puts().filter((i) => !String(i.Name).includes('/server/user-groups/')),
    ]);
    for (const secret of secrets) expect(haystack).not.toContain(secret);
    // And nothing resembling a digest of a password is written anywhere.
    for (const i of puts().filter((x) => !String(x.Name).includes('/server/user-groups/'))) {
      expect(String(i.Value)).not.toMatch(/[0-9a-f]{32,}/i);
    }
  });
});

describe('/enshrouded pw (7.4.4)', () => {
  const run = (roleIds?: string[]) => handler(pwEvent(roleIds));
  const decryptingReads = () => ssmLog.filter((l) => l.kind === 'get' && String(l.input.Name).includes('/server/'));

  test('running, no desync: DMs the caller tier cascade from LIVE ssm values', async () => {
    mockEc2.mockReset().mockResolvedValue(stateOf('running'));
    parameters.set(DESYNC, 'none');
    await run([roles.friend]);
    expect(dms()).toHaveLength(1);
    expect(dms()[0]).toContain(LIVE.friend);
    expect(dms()[0]).toContain(LIVE.guest);
    expect(dms()[0]).toContain(LIVE.visitor);
    expect(dms()[0]).not.toContain(LIVE.admin);
    expect(edits().at(-1)).toContain('Sent');
  });

  test('absent password-desync parameter counts as clear', async () => {
    mockEc2.mockReset().mockResolvedValue(stateOf('running'));
    await run();
    expect(dms()).toHaveLength(1);
  });

  test.each(['stopped', 'stopping', 'shutting-down', 'terminated', undefined])('refuses when %s and points at /enshrouded start', async (state) => {
    mockEc2.mockReset().mockResolvedValue(stateOf(state));
    await run();
    expect(dms()).toEqual([]);
    expect(decryptingReads()).toEqual([]);
    expect(edits().at(-1)).toContain('/enshrouded start');
  });

  test.each([
    ['set', '{"detectedAt":"x","previousState":"pending"}'], ['malformed', 'garbage'],
  ])('refuses on a running server when password-desync is %s', async (_n, value) => {
    mockEc2.mockReset().mockResolvedValue(stateOf('running'));
    parameters.set(DESYNC, value);
    await run();
    expect(dms()).toEqual([]);
    expect(decryptingReads()).toEqual([]);
    expect(edits().at(-1)).toContain("can't confirm");
  });

  test('refuses on a running server when password-desync is unreadable (fail closed)', async () => {
    mockEc2.mockReset().mockResolvedValue(stateOf('running'));
    unreadable.add(DESYNC);
    await run();
    expect(dms()).toEqual([]);
  });

  test('pending: reports, and says the server is still starting', async () => {
    mockEc2.mockReset().mockResolvedValue(stateOf('pending'));
    await run([roles.visitor]);
    expect(dms()).toHaveLength(1);
    expect(dms()[0]).toContain(LIVE.visitor);
    expect(edits().at(-1)).toContain('still starting');
  });

  test('authorizes BEFORE checking instance state: an unauthorized caller reaches no EC2 call', async () => {
    await run([]);
    expect(mockEc2).not.toHaveBeenCalled();
    expect(decryptingReads()).toEqual([]);
    expect(dms()).toEqual([]);
    expect(edits().at(-1)).toContain('do not have access');
    // Same flat denial whatever the state: nothing about the server leaks.
    mockEc2.mockReset().mockResolvedValue(stateOf('running'));
    await run([]);
    expect(mockEc2).not.toHaveBeenCalled();
  });

  test('a lookup failure denies rather than falling through to state or passwords', async () => {
    parameters.delete(`${P}/discord/password-access/${guildId}`);
    await run();
    expect(mockEc2).not.toHaveBeenCalled();
    expect(dms()).toEqual([]);
  });

  test('signed /enshrouded pw acks ephemerally and self-invokes with no secret in the payload', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    process.env.DISCORD_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    ({ handler } = jest.requireActual('../lib/enshrouded/lambda/discord-bot/index'));
    const body = JSON.stringify({ id: 'iid', token: 'tok', type: 2, guild_id: guildId,
      member: { user: { id: userId }, roles: [roles.friend] },
      data: { name: 'enshrouded', options: [{ type: 1, name: 'pw' }] } });
    const ts = '1700000000';
    const headers = { 'x-signature-timestamp': ts,
      'x-signature-ed25519': crypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex') };
    expect(await handler({ body, headers })).toEqual({ statusCode: 202, body: '' });
    expect(JSON.parse(jest.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({ type: 5, data: { flags: 64 } });
    const payload = JSON.parse(mockInvoke.mock.calls[0][0].input.Payload);
    expect(payload).toEqual({ _internal: 'finish-pw', interactionToken: 'tok', guildId, userId, roleIds: [roles.friend] });
    expect(ssmLog).toEqual([]); // nothing but the ack happened synchronously
  });

  test('no password reaches a log line or the edited reply', async () => {
    mockEc2.mockReset().mockResolvedValue(stateOf('running'));
    await run();
    const haystack = JSON.stringify([jest.mocked(console.log).mock.calls, jest.mocked(console.error).mock.calls, edits()]);
    for (const secret of Object.values(LIVE)) expect(haystack).not.toContain(secret);
  });
});
