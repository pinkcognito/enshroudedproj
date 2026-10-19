const { ACCESS_PREFIX, parseAccessMapping, authorizePasswordAccess, sendPasswordDm } =
  jest.requireActual('../lib/enshrouded/lambda/discord-bot/password-access');

const guildId = '123456789012345678';
const userId = '234567890123456789';
const otherId = '345678901234567890';
const dmId = '456789012345678901';
const roles = { admin: '567890123456789012', friend: '678901234567890123',
  guest: '789012345678901234', visitor: '890123456789012345' };
const mapping = { guildId, roles };
const parameter = `${ACCESS_PREFIX}/${guildId}`;
const botToken = 'test-only-bot-token';
const passwords = { admin: 'test-only-admin-secret', friend: 'test-only-friend-secret',
  guest: 'test-only-guest-secret', visitor: 'test-only-visitor-secret' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const caller = (roleIds: string[] = Object.values(roles)) => ({ guildId, userId, roleIds });
const access = (groups = ['visitor']) => ({ guildId, userId, groups });
const privateContent = (result: { body: string }) => {
  const body = JSON.parse(result.body);
  expect(body).toMatchObject({ type: 4, data: { flags: 64 } });
  expect(body.data.content).not.toMatch(/test-only-|https:\/\//);
  return body.data.content as string;
};

beforeEach(() => {
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected real-network attempt'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(global.fetch).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe('operator mapping validation', () => {
  test('accepts exact guild path and optional tiers without creating implied roles', () => {
    expect(ACCESS_PREFIX).toBe('/enshroudedproj/discord/password-access');
    expect(parseAccessMapping(parameter, JSON.stringify(mapping))).toEqual(mapping);
    expect(parseAccessMapping(parameter, JSON.stringify({ guildId, roles: { guest: roles.guest } })))
      .toEqual({ guildId, roles: { guest: roles.guest } });
    expect(parseAccessMapping(parameter, JSON.stringify({ guildId, roles: {} }))).toEqual({ guildId, roles: {} });
  });

  test.each([null, {}, { guildId, roles: null }, { guildId, roles: [] }, { guildId, roles: 'admin' },
    { guildId: otherId, roles }, { guildId: 'invalid', roles },
    { guildId, roles: { admin: 'admin' } }, { guildId, roles: { admin: 123 } },
    { guildId, roles: { admin: roles.admin, friend: roles.admin } },
    { guildId, roles: { owner: roles.admin } }, { guildId, roles: { guest: roles.guest, visitor: '' } },
    { guildId, roles: { admin: roles.admin + '\n' } }, { ...mapping, extra: true },
  ])('rejects the entire invalid mapping: %j', (value) => {
    expect(parseAccessMapping(parameter, JSON.stringify(value))).toBeNull();
  });

  test('rejects malformed JSON, wrong namespace, and additional path components', () => {
    expect(parseAccessMapping(parameter, '{')).toBeNull();
    expect(parseAccessMapping(parameter + '/extra', JSON.stringify(mapping))).toBeNull();
    expect(parseAccessMapping('/enshroudedproj/server/' + guildId, JSON.stringify(mapping))).toBeNull();
  });
});

describe('signed caller plus fresh live member authorization', () => {
  test.each([
    { roleIds: [roles.admin], groups: ['admin', 'friend', 'guest', 'visitor'] },
    { roleIds: [roles.friend], groups: ['friend', 'guest', 'visitor'] },
    { roleIds: [roles.guest], groups: ['guest', 'visitor'] },
    { roleIds: [roles.visitor], groups: ['visitor'] },
    { roleIds: [roles.visitor, roles.admin, roles.guest], groups: ['admin', 'friend', 'guest', 'visitor'] },
    { roleIds: [roles.visitor, roles.friend], groups: ['friend', 'guest', 'visitor'] },
  ])('highest matching role grants its tier and lower tiers: %j', async ({ roleIds, groups }) => {
    const fetch = jest.fn().mockResolvedValue(response({ user: { id: userId }, roles: roleIds }));
    expect(await authorizePasswordAccess(caller(roleIds), mapping, { botToken, fetch }))
      .toEqual({ guildId, userId, groups });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: `Bot ${botToken}` }),
        signal: expect.any(AbortSignal), redirect: 'error' }));
  });

  test.each([
    { request: caller([]), config: mapping },
    { request: { ...caller([]), permissions: '8' }, config: mapping },
    { request: { ...caller([]), permissions: '32' }, config: mapping },
    { request: caller(['admin']), config: mapping },
    { request: caller([otherId]), config: mapping },
    { request: { ...caller(), guildId: otherId }, config: mapping },
    { request: { ...caller(), userId: 'invalid' }, config: mapping },
    { request: { ...caller(), guildId: undefined }, config: mapping },
    { request: { ...caller(), roleIds: null }, config: mapping },
    { request: caller(), config: { guildId, roles: { admin: roles.admin, guest: roles.admin } } },
  ])('rejects invalid/unmapped signed caller before REST: %j', async ({ request, config }) => {
    const fetch = jest.fn();
    expect(await authorizePasswordAccess(request, config, { botToken, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    { user: { id: otherId }, roles: [roles.admin] },
    { user: { id: userId }, roles: ['admin'], permissions: '8' },
    { user: { id: userId }, roles: [] },
    { user: { id: userId }, roles: null },
    { user: { id: userId }, roles: [123] },
    { user: { id: userId }, roles: [roles.admin], guild_id: otherId },
    { roles: [roles.admin] }, null,
  ])('live lookup cannot authorize wrong user/guild or missing/malformed roles: %j', async (member) => {
    const fetch = jest.fn().mockResolvedValue(response(member));
    expect(await authorizePasswordAccess(caller(), mapping, { botToken, fetch })).toBeNull();
  });

  test('live role removal downgrades access even when signed request still contains admin', async () => {
    const fetch = jest.fn().mockResolvedValue(response({ user: { id: userId }, roles: [roles.visitor] }));
    expect(await authorizePasswordAccess(caller(), mapping, { botToken, fetch })).toEqual(access());
  });

  test('a newly acquired role requires a new signed request rather than widening this request', async () => {
    const fetch = jest.fn().mockResolvedValue(response({ user: { id: userId }, roles: [roles.admin, roles.visitor] }));
    expect(await authorizePasswordAccess(caller([roles.visitor]), mapping, { botToken, fetch })).toEqual(access());
  });

  test('omitted mapping tiers still grant lower password groups from the highest configured match', async () => {
    const fetch = jest.fn().mockResolvedValue(response({ user: { id: userId }, roles: [roles.friend] }));
    expect(await authorizePasswordAccess(caller([roles.friend]), { guildId, roles: { friend: roles.friend } }, { botToken, fetch }))
      .toEqual(access(['friend', 'guest', 'visitor']));
  });

  test.each([403, 404, 429, 500])('member lookup %s denies without fallback or response-body logging', async (status) => {
    const fetch = jest.fn().mockResolvedValue(response({ secret: passwords.admin }, status));
    expect(await authorizePasswordAccess(caller(), mapping, { botToken, fetch })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('member lookup network failure is contained without logging token-bearing error', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error(`https://discord.com/${botToken}/${passwords.admin}`));
    expect(await authorizePasswordAccess(caller(), mapping, { botToken, fetch })).toBeNull();
  });
});

describe('password delivery only to the signed caller DM', () => {
  test.each([
    ['admin', 'friend', 'guest', 'visitor'], ['friend', 'guest', 'visitor'], ['guest', 'visitor'], ['visitor'],
  ])('sends exactly authorized groups %j without a public or interaction-token secret reply', async (...groups) => {
    const fetch = jest.fn().mockResolvedValueOnce(response({ id: dmId, type: 1, recipients: [{ id: userId }] }))
      .mockResolvedValueOnce(response({}));
    const supplied = Object.fromEntries(Object.entries(passwords).map(([group, password]) => [group, password]));
    for (const group of Object.keys(passwords).filter((group) => !groups.includes(group))) {
      Object.defineProperty(supplied, group, { get: () => { throw new Error('Unauthorized password read'); } });
    }
    const result = await sendPasswordDm(caller(), access(groups), supplied, { botToken, fetch });
    expect(privateContent(result)).toContain('Sent');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]).toEqual(['https://discord.com/api/v10/users/@me/channels', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ recipient_id: userId }), signal: expect.any(AbortSignal), redirect: 'error',
    })]);
    expect(fetch.mock.calls[1][0]).toBe(`https://discord.com/api/v10/channels/${dmId}/messages`);
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    for (const group of Object.keys(passwords) as (keyof typeof passwords)[]) {
      expect(body.content.includes(passwords[group])).toBe(groups.includes(group));
    }
  });

  test.each([null, { ...access(), userId: otherId }, { ...access(), guildId: otherId },
    access([]), access(['owner']), access(['visitor', 'admin']), access(['admin', 'visitor']),
  ])('rejects unbound or invalid authorization before creating a DM: %j', async (authorization) => {
    const fetch = jest.fn();
    expect(privateContent(await sendPasswordDm(caller(), authorization, passwords, { botToken, fetch }))).toContain('Unable');
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    { id: dmId, type: 0, recipients: [{ id: userId }] },
    { id: dmId, type: 3, recipients: [{ id: userId }] },
    { id: dmId, type: 1, recipients: [{ id: otherId }] },
    { id: dmId, type: 1, recipients: [{ id: userId }, { id: otherId }] },
    { id: dmId, type: 1, recipients: [{ id: userId }], guild_id: guildId },
    { id: '../guild-channel', type: 1, recipients: [{ id: userId }] },
    { id: dmId, type: 1 }, null,
  ])('never posts secrets into an unverified DM response: %j', async (dm) => {
    const fetch = jest.fn().mockResolvedValue(response(dm));
    expect(privateContent(await sendPasswordDm(caller(), access(), passwords, { botToken, fetch }))).toContain('Unable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each(['create-closed', 'send-closed', 'create-network', 'send-network', 'create-invalid-json'])('%s DM failure stays private and never falls back', async (failure) => {
    const fetch = jest.fn();
    const error = new Error(`https://discord.com/${botToken}/${passwords.visitor}`);
    if (failure === 'create-closed') fetch.mockResolvedValueOnce(response({ secret: passwords.visitor }, 403));
    else if (failure === 'create-network') fetch.mockRejectedValueOnce(error);
    else if (failure === 'create-invalid-json') fetch.mockResolvedValueOnce({ ok: true, json: async () => { throw error; } });
    else {
      fetch.mockResolvedValueOnce(response({ id: dmId, type: 1, recipients: [{ id: userId }] }));
      if (failure === 'send-closed') fetch.mockResolvedValueOnce(response({ secret: passwords.visitor }, 403));
      else fetch.mockRejectedValueOnce(error);
    }
    expect(privateContent(await sendPasswordDm(caller(), access(), passwords, { botToken, fetch }))).toContain('Unable');
    expect(fetch).toHaveBeenCalledTimes(failure.startsWith('create') ? 1 : 2);
    for (const [url] of fetch.mock.calls) expect(url).not.toMatch(/webhooks|interactions/);
  });

  test.each([{}, { visitor: '' }, { visitor: 123 }, { visitor: 'x'.repeat(2001) }])('missing or oversized authorized secrets fail before DM creation', async (values) => {
    const fetch = jest.fn();
    expect(privateContent(await sendPasswordDm(caller(), access(), values, { botToken, fetch }))).toContain('Unable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
