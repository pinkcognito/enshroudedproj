// WP-23: command authorization (ARCHITECTURE 7.5). commandRoles.start is the SOLE grant for
// /enshrouded start. There is deliberately no admin fallback and no tier implication.
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
jest.mock('../lib/enshrouded/lambda/discord-bot/password-generator', () => ({
  generatePasswords: () => ({ admin: 'a-a-a', friend: 'f-f-f', guest: 'g-g-g', visitor: 'v-v-v' }),
}), { virtual: true });

const guildId = '123456789012345678', userId = '234567890123456789', otherGuild = '999999999999999999';
const tiers = { admin: '567890123456789012', friend: '678901234567890123',
  guest: '789012345678901234', visitor: '890123456789012345' };
const startRole = '901234567890123456';
const stopRole = '912345678901234567';
const P = '/enshroudedproj';
const ACCESS = `${P}/discord/password-access/${guildId}`;
const DENIAL = "You don't have permission to start the server; ask a server admin.";
const NO_TIER = "You don't hold a password role, so there's nothing for me to send you.";
const allTiers = Object.values(tiers);

const parameters = new Map<string, string>();
const oldEnv = process.env;
let handler: (event: object, context?: object) => Promise<{ statusCode: number; body: string }>;
let liveRoles: string[];
const response = (body: object, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const startEvent = (roleIds: string[] | undefined, overrides: object = {}) =>
  ({ _internal: 'finish-start', interactionToken: 'tok', guildId, userId, roleIds, ...overrides });
const ec2Names = () => mockEc2.mock.calls.map(([c]) => (c as object).constructor.name);
const puts = () => mockSsm.mock.calls.filter(([c]) => (c as object).constructor.name === 'PutParameterCommand');
const edits = () => jest.mocked(fetch).mock.calls.filter(([, o]) => o?.method === 'PATCH')
  .map(([, o]) => JSON.parse(o?.body as string).content as string);
const setMapping = (value: unknown) => parameters.set(ACCESS, typeof value === 'string' ? value : JSON.stringify(value));
// Every assertion that matters is on the mocked clients, not on the reply text alone.
const expectNothingHappened = () => {
  expect(mockEc2).not.toHaveBeenCalled();
  expect(puts()).toEqual([]);
  expect(mockInvoke).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.resetModules();
  process.env = { ...oldEnv, INSTANCE_ID: 'i-test', DISCORD_APPLICATION_ID: 'app',
    BOT_TOKEN_PARAM: `${P}/discord/bot-token`, AWS_LAMBDA_FUNCTION_NAME: 'enshrouded-discord-bot' };
  ({ handler } = jest.requireActual('../lib/enshrouded/lambda/discord-bot/index'));
  parameters.clear();
  parameters.set(`${P}/discord/bot-token`, 'bot-secret');
  parameters.set(`${P}/state/rotate-on-start`, 'true'); // rotation armed: a leak would write passwords
  setMapping({ guildId, roles: tiers, commandRoles: { start: startRole } });
  liveRoles = [startRole, ...allTiers];
  mockEc2.mockReset().mockImplementation(async (c: { constructor: { name: string } }) => c.constructor.name === 'StartInstancesCommand'
    ? { StartingInstances: [{ InstanceId: 'i-test', PreviousState: { Name: 'stopped' }, CurrentState: { Name: 'pending' } }] }
    : { Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }] });
  mockInvoke.mockReset().mockResolvedValue({});
  mockSsm.mockReset().mockImplementation(async (c: { input: { Name: string; Value?: string } }) => {
    if ((c as object).constructor.name === 'PutParameterCommand') { parameters.set(c.input.Name, String(c.input.Value)); return {}; }
    if (parameters.has(c.input.Name)) return { Parameter: { Value: parameters.get(c.input.Name) } };
    throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
  });
  jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
    String(url).includes('/members/') ? response({ user: { id: userId }, roles: liveRoles }) : response({}));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); process.env = oldEnv; });

describe('/enshrouded start authorization', () => {
  test('holder of enshroudedstart and a tier starts the server; no no-tier note', async () => {
    await handler(startEvent([startRole, tiers.visitor]));
    expect(ec2Names()).toContain('StartInstancesCommand');
    expect(edits().at(-1)).toContain('Booting');
    expect(edits().at(-1)).not.toContain(NO_TIER);
  });

  test('holder of enshroudedstart and NO tier starts, and is told there is nothing to send (supported configuration)', async () => {
    liveRoles = [startRole];
    await handler(startEvent([startRole]));
    expect(ec2Names()).toContain('StartInstancesCommand');
    expect(edits().at(-1)).toContain('Booting');
    expect(edits().at(-1)).toContain(NO_TIER);
    expect(edits().at(-1)).not.toMatch(/problem|misconfigur|wrong|error|fix/i);
  });

  test('an enshroudedadmin-only holder (every tier role, no commandRoles.start) is DENIED start - no admin fallback', async () => {
    setMapping({ guildId, roles: tiers, commandRoles: { stop: stopRole } });
    liveRoles = allTiers;
    await handler(startEvent(allTiers));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test('holding every tier role but not enshroudedstart is denied even when the start key exists', async () => {
    liveRoles = allTiers;
    await handler(startEvent(allTiers));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test('a mapping with commandRoles absent entirely denies start to everyone, including the admin', async () => {
    setMapping({ guildId, roles: tiers });
    for (const roleIds of [allTiers, [tiers.admin], [startRole], [startRole, ...allTiers]]) {
      liveRoles = roleIds;
      await handler(startEvent(roleIds));
    }
    expect(edits()).toEqual([DENIAL, DENIAL, DENIAL, DENIAL]);
    expectNothingHappened();
  });

  test('a member with none of the roles is denied; no EC2 call and no rotation occurs', async () => {
    liveRoles = [];
    await handler(startEvent([]));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
    expect([...parameters.keys()].filter((k) => k.includes('/server/user-groups/'))).toEqual([]);
  });

  test('the mapping may deliberately aim commandRoles.start at a tier role id (explicit, not implicit)', async () => {
    setMapping({ guildId, roles: tiers, commandRoles: { start: tiers.admin, stop: tiers.admin } });
    liveRoles = [tiers.admin];
    await handler(startEvent([tiers.admin]));
    expect(ec2Names()).toContain('StartInstancesCommand');
  });

  test.each([
    ['absent mapping', undefined],
    ['corrupt mapping', '{not json'],
    ['partial mapping: no roles', { guildId, commandRoles: { start: startRole } }],
    ['partial mapping: roles null', { guildId, roles: null, commandRoles: { start: startRole } }],
    ['unknown commandRoles key', { guildId, roles: tiers, commandRoles: { start: startRole, reboot: startRole } }],
    ['unknown top-level key', { guildId, roles: tiers, commandRoles: { start: startRole }, extra: 1 }],
    ['non-snowflake start id', { guildId, roles: tiers, commandRoles: { start: 'start' } }],
    ['commandRoles is an array', { guildId, roles: tiers, commandRoles: [startRole] }],
    ['mapping for another guild', { guildId: otherGuild, roles: tiers, commandRoles: { start: startRole } }],
  ])('%s denies, with nothing started', async (_name, value) => {
    if (value === undefined) parameters.delete(ACCESS); else setMapping(value);
    await handler(startEvent([startRole, ...allTiers]));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test('unreadable mapping (SSM error) fails closed', async () => {
    mockSsm.mockImplementation(async (c: { input: { Name: string } }) => {
      if (c.input.Name === ACCESS) throw Object.assign(new Error('boom'), { name: 'InternalServerError' });
      return { Parameter: { Value: 'bot-secret' } };
    });
    await handler(startEvent([startRole]));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test.each([
    ['no guild id', { guildId: undefined }],
    ['guild id not a snowflake', { guildId: 'dm' }],
    ['no signed roles (DM / user-install context)', { roleIds: undefined }],
  ])('a non-guild interaction denies in the worker: %s', async (_name, overrides) => {
    await handler(startEvent([startRole], overrides));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test('a role removed between the signed payload and the live fetch denies', async () => {
    liveRoles = allTiers; // enshroudedstart was revoked after the interaction was signed
    await handler(startEvent([startRole, ...allTiers]));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test('a role granted after signing does not widen the request', async () => {
    liveRoles = [startRole];
    await handler(startEvent([]));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test.each([403, 404, 429, 500])('live member lookup %s denies', async (status) => {
    jest.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/members/') ? response({}, status) : response({}));
    await handler(startEvent([startRole]));
    expect(edits()).toEqual([DENIAL]);
    expectNothingHappened();
  });

  test('the denial text names no role, no id, and no configuration', async () => {
    liveRoles = [];
    await handler(startEvent([]));
    const text = edits()[0];
    expect(text).toBe(DENIAL);
    for (const id of [startRole, stopRole, ...allTiers, guildId, userId]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/enshrouded(admin|friend|guest|visitor|start|stop)|role|commandRoles/i);
  });
});

describe('synchronous half is free payload inspection only', () => {
  const TS = '1700000000';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const sign = (payload: object) => {
    process.env.DISCORD_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const body = JSON.stringify(payload);
    return { body, headers: { 'x-signature-timestamp': TS,
      'x-signature-ed25519': crypto.sign(null, Buffer.from(TS + body), privateKey).toString('hex') } };
  };
  const interaction = (sub: string, extra: object) => ({ id: 'iid', token: 'tok', type: 2,
    data: { name: 'enshrouded', options: [{ type: 1, name: sub }] }, ...extra });

  test.each([
    ['no guild_id', { member: { user: { id: userId }, roles: [startRole] } }],
    ['no member (DM)', { guild_id: guildId, user: { id: userId } }],
  ])('start with %s is rejected at once: no defer, no self-invoke, no AWS client, no SSM', async (_n, extra) => {
    const res = await handler(sign(interaction('start', extra)));
    expect(JSON.parse(res.body)).toEqual({ type: 4, data: { content: DENIAL, flags: 64 } });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSsm).not.toHaveBeenCalled();
    expectNothingHappened();
  });

  test('a guild start carries the signed roles to the worker and does no SSM/EC2 work before the ack', async () => {
    const res = await handler(sign(interaction('start', { guild_id: guildId, member: { user: { id: userId }, roles: [startRole] } })));
    expect(res).toEqual({ statusCode: 202, body: '' });
    expect(mockSsm).not.toHaveBeenCalled();
    expect(mockEc2).not.toHaveBeenCalled();
    expect(JSON.parse(mockInvoke.mock.calls[0][0].input.Payload)).toEqual(
      { _internal: 'finish-start', interactionToken: 'tok', guildId, userId, roleIds: [startRole] });
  });

  test('status stays ungated: a member with no roles at all still gets it, with no mapping read', async () => {
    const res = await handler(sign(interaction('status', { guild_id: guildId, member: { user: { id: userId }, roles: [] } })));
    expect(res).toEqual({ statusCode: 202, body: '' });
    expect(JSON.parse(mockInvoke.mock.calls[0][0].input.Payload)._internal).toBe('finish-status');
    parameters.delete(ACCESS);
    await handler({ _internal: 'finish-status', interactionToken: 'tok' });
    expect(edits().at(-1)).toContain('The server is down');
    expect(mockSsm.mock.calls.some(([c]) => String((c as { input: { Name: string } }).input.Name).includes('password-access'))).toBe(false);
  });
});
