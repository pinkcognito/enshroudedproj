const mockSend = jest.fn();
const mockLoaded = jest.fn();
const mockClientOptions = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  mockLoaded();
  return {
    SSMClient: class {
      constructor(options: unknown) { mockClientOptions(options); }
      send(command: unknown, options: unknown) { return mockSend(command, options); }
    },
    GetParameterCommand: class { constructor(public input: unknown) {} },
    PutParameterCommand: class { constructor(public input: unknown) {} },
  };
}, { virtual: true });

const { CONFIG_PREFIX, DELIVERY_PREFIX, parseConfig, isSnowflake } = jest.requireActual('../lib/enshrouded/lambda/shared/status-channel-config');
const request = { guildId: '123456789012345678', channelId: '234567890123456789',
  channelType: 0, memberPermissions: '32', appPermissions: '3088', interactionToken: 'interaction-secret' };
const name = `/enshroudedproj/discord/status-channels/${request.guildId}`;

describe('status channel config contract', () => {
  const config = { guildId: request.guildId, channelId: request.channelId, baseName: 'world' };
  test('exports exact worker paths and validates codepoint length', () => {
    expect(CONFIG_PREFIX).toBe('/enshroudedproj/discord/status-channels');
    expect(DELIVERY_PREFIX).toBe('/enshroudedproj/state/status-channel');
    expect(parseConfig(name, JSON.stringify(config))).toEqual(config);
    expect(parseConfig(name, JSON.stringify({ ...config, baseName: '🌍'.repeat(98) }))).not.toBeNull();
    expect(parseConfig(name, JSON.stringify({ ...config, baseName: '🌍'.repeat(99) }))).toBeNull();
  });
  test.each(['', '1'.repeat(16), '1'.repeat(21), '12345678901234567x', '123456789012345678\n', Number('123456789012345678'), null])('rejects invalid snowflake %j', (value) => {
    expect(isSnowflake(value)).toBe(false);
  });
  test.each([null, {}, { ...config, guildId: request.channelId }, { ...config, channelId: 'bad' },
    { ...config, baseName: '' }, { ...config, baseName: '  ' }, { ...config, baseName: 123 }])('rejects spoofed or malformed config %j', (value) => {
    expect(parseConfig(name, JSON.stringify(value))).toBeNull();
  });
  test('rejects invalid JSON and wrong namespace', () => {
    expect(parseConfig(name, '{')).toBeNull();
    expect(parseConfig(name + '/extra', JSON.stringify(config))).toBeNull();
    expect(parseConfig('/enshroudedproj/state/status-channel/' + request.guildId, JSON.stringify(config))).toBeNull();
  });
});

describe('channel registration helper (all network mocked)', () => {
  let registerChannel: (value: object) => Promise<string>;
  let finishChannel: (value: object) => Promise<void>;
  const parameters = new Map<string, string>();
  const globalCooldown = `${DELIVERY_PREFIX}/global-rate-limit`;
  const routeCooldown = `${DELIVERY_PREFIX}/registration/${request.guildId}`;
  const rateMessage = 'Discord is rate-limiting bot requests; try again later';
  const inputs = () => mockSend.mock.calls.map(([cmd]) => cmd.input);
  const writes = () => inputs().filter((input) => input.Type);
  beforeEach(() => {
    jest.resetModules();
    ({ registerChannel, finishChannel } = jest.requireActual('../lib/enshrouded/lambda/discord-bot/channel'));
    parameters.clear();
    mockClientOptions.mockClear();
    mockSend.mockReset().mockImplementation((cmd) => {
      if (cmd.input.WithDecryption) return Promise.resolve({ Parameter: { Value: 'bot-secret' } });
      if (cmd.input.Type) {
        parameters.set(cmd.input.Name, cmd.input.Value);
        return Promise.resolve({});
      }
      if (parameters.has(cmd.input.Name)) return Promise.resolve({ Parameter: { Value: parameters.get(cmd.input.Name) } });
      return Promise.reject(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ id: request.channelId, guild_id: request.guildId, type: 0, name: '🟢-world' }),
    } as Response);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test.each([{ memberPermissions: '0' }, { appPermissions: '3072' }, { guildId: 'bad' },
    { channelId: 'bad' }, { channelType: 11 }, { memberPermissions: '-1' }])('revalidates before SDK/network: %j', async (overrides) => {
    const loads = mockLoaded.mock.calls.length;
    expect(await registerChannel({ ...request, ...overrides })).not.toContain('Saved');
    expect(mockLoaded).toHaveBeenCalledTimes(loads);
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['🟢-world', '🔴-world', 'world', 'my-🟢-world'])('stores exact config, stripping only recognized leading prefix: %s', async (channelName) => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: true,
      json: async () => ({ id: request.channelId, guild_id: request.guildId, type: 0, name: channelName }),
    } as Response);
    expect(await registerChannel(request)).toContain('next minute');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`https://discord.com/api/v10/channels/${request.channelId}`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bot bot-secret' }) }));
    expect(inputs().slice(3)).toEqual([
      { Name: name }, { Name: name, Type: 'String', Overwrite: true,
        Value: JSON.stringify({ guildId: request.guildId, channelId: request.channelId,
          baseName: channelName.replace(/^[🟢🔴]-/u, '') }) },
    ]);
  });

  test('same-channel registration preserves original base name after external rename', async () => {
    parameters.set(name, JSON.stringify({ guildId: request.guildId, channelId: request.channelId, baseName: 'original' }));
    await registerChannel(request);
    expect(JSON.parse(writes()[0].Value).baseName).toBe('original');
  });

  test.each([
    { guildId: request.guildId, channelId: '345678901234567890', baseName: 'old-channel' },
    { guildId: '345678901234567890', channelId: request.channelId, baseName: 'spoofed' },
  ])('a different channel or cross-guild config cannot supply the new base name: %j', async (previous) => {
    parameters.set(name, JSON.stringify(previous));
    await registerChannel(request);
    expect(JSON.parse(writes()[0].Value).baseName).toBe('world');
  });

  test.each(['🟢-', 'x'.repeat(99)])('invalid base name never writes config', async (channelName) => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({
      id: request.channelId, guild_id: request.guildId, type: 0, name: channelName,
    }) } as Response);
    expect(await registerChannel(request)).not.toContain('Saved');
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(writes()).toEqual([]);
  });

  test('failed Discord lookup never reads or writes config', async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    await expect(registerChannel(request)).rejects.toThrow('channel-lookup-failed');
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(writes()).toEqual([]);
  });

  test.each([{ guild_id: request.channelId }, { id: request.guildId }, { type: 5 }, { type: 11 }])('rejects fetched channel spoof/type: %j', async (overrides) => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({
      id: request.channelId, guild_id: request.guildId, type: 0, name: 'world', ...overrides,
    }) } as Response);
    expect(await registerChannel(request)).not.toContain('Saved');
    expect(mockSend).toHaveBeenCalledTimes(3); // cooldown reads and token only
  });

  test('SSM read failure does not overwrite unknown configuration', async () => {
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Parameter: { Value: 'bot-secret' } }).mockRejectedValueOnce(new Error('denied'));
    await expect(registerChannel(request)).rejects.toThrow('denied');
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(writes()).toEqual([]);
  });

  test.each(['global', 'route'])('known %s cooldown blocks bot fetch and token lookup', async (scope) => {
    parameters.set(scope === 'global' ? globalCooldown : routeCooldown, JSON.stringify({ retryAt: Date.now() + 60000 }));
    expect(await registerChannel(request)).toBe(rateMessage);
    expect(fetch).not.toHaveBeenCalled();
    expect(inputs().some((input) => input.WithDecryption)).toBe(false);
    expect(writes()).toEqual([]);
  });

  test.each(['expired', 'malformed', 'invalid-type'])('%s cooldowns allow registration', async (kind) => {
    const value = kind === 'expired' ? JSON.stringify({ retryAt: Date.now() - 1 })
      : kind === 'malformed' ? '{' : JSON.stringify({ retryAt: '99999999999999' });
    parameters.set(globalCooldown, value);
    parameters.set(routeCooldown, value);
    expect(await registerChannel(request)).toContain('Saved');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    { retry_after: 2.5, expected: 2500 }, { retry_after: 0, expected: 1000 },
    { retry_after: -1, expected: 1000 }, { retry_after: 0.2, expected: 1000 },
    { retry_after: 999999, expected: 999999000 }, { retry_after: undefined, expected: 60000 },
    { retry_after: '5', expected: 60000 }, { retry_after: Infinity, expected: 60000 },
  ])('route 429 persists bounded retry delay in milliseconds: %j', async ({ retry_after, expected }) => {
    const now = 1800000000000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429,
      json: async () => ({ retry_after, global: false }),
    } as Response);
    expect(await registerChannel(request)).toBe(rateMessage);
    expect(writes()).toEqual([{ Name: routeCooldown, Type: 'String', Overwrite: true,
      Value: JSON.stringify({ retryAt: now + expected }) }]);
    expect(inputs().some((input) => input.Name === name)).toBe(false);
    expect(await registerChannel(request)).toBe(rateMessage);
    expect(fetch).toHaveBeenCalledTimes(1); // persisted route cooldown across calls
    expect(inputs().filter((input) => input.WithDecryption)).toHaveLength(1);
  });

  test('global 429 persists worker-shared global observation and registration route cooldown', async () => {
    const now = 1800000000000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429,
      json: async () => ({ retry_after: 7, global: true }),
    } as Response);
    expect(await registerChannel(request)).toBe(rateMessage);
    expect(writes()).toEqual([globalCooldown, routeCooldown].map((Name) => ({
      Name, Type: 'String', Overwrite: true, Value: JSON.stringify({ retryAt: now + 7000 }),
    })));
    expect(inputs().some((input) => input.Name === name)).toBe(false);
    mockSend.mockClear();
    expect(await registerChannel({ ...request, guildId: '345678901234567890' })).toBe(rateMessage);
    expect(inputs()).toEqual([{ Name: globalCooldown }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('malformed 429 body persists default cooldown without config writes', async () => {
    const now = 1800000000000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429,
      json: async () => { throw new Error('invalid-json'); },
    } as unknown as Response);
    expect(await registerChannel(request)).toBe(rateMessage);
    expect(writes()).toEqual([{ Name: routeCooldown, Type: 'String', Overwrite: true,
      Value: JSON.stringify({ retryAt: now + 60000 }) }]);
  });

  test('SSM cooldown failure fails closed before token lookup or fetch', async () => {
    mockSend.mockRejectedValueOnce(new Error('timeout'));
    await expect(registerChannel(request)).rejects.toThrow('timeout');
    expect(fetch).not.toHaveBeenCalled();
    expect(inputs()).toEqual([{ Name: globalCooldown }]);
  });

  test('registration SSM reads and writes use one attempt and short abort signals', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    await registerChannel(request);
    expect(mockClientOptions).toHaveBeenCalledWith({ maxAttempts: 1 });
    for (const [cmd, options] of mockSend.mock.calls) {
      if (!cmd.input.WithDecryption) expect(options).toEqual({ abortSignal: expect.any(AbortSignal) });
    }
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([1000, 1000, 3000, 1000, 1000]);
  });

  test('known global cooldown still allows interaction-token private reply PATCH', async () => {
    parameters.set(globalCooldown, JSON.stringify({ retryAt: Date.now() + 60000 }));
    await finishChannel(request);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/messages/@original'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ content: rateMessage }) }));
    expect(inputs().some((input) => input.WithDecryption)).toBe(false);
  });

  test('finish-channel edits deferred success; errors never log tokens or raw URLs', async () => {
    await finishChannel(request);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/messages/@original'),
      expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('Saved') }));
    jest.mocked(fetch).mockRejectedValueOnce(new Error('https://discord.com/bot-secret/interaction-secret'));
    await finishChannel(request);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/messages/@original'),
      expect.objectContaining({ body: expect.stringContaining('Unable to save') }));
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toMatch(/bot-secret|interaction-secret|https:/);
  });
});
