// Tests for the Discord interactions handler and the anti-drift guard between
// lambda/discord-bot/commands.js (what gets registered with Discord) and
// lambda/discord-bot/index.js (what the handler dispatches on / reads).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { commands, OPTION_TYPE, Command } from '../lib/enshrouded/lambda/discord-bot/commands';
import { handler } from '../lib/enshrouded/lambda/discord-bot/index';

// The AWS SDK is provided by the Lambda runtime and is not a local dependency.
const sentCommands: unknown[] = [];
const mockSend = jest.fn();
const mockSdkLoaded = jest.fn();
let mockSdkFailure = false;
jest.mock(
  '@aws-sdk/client-lambda',
  () => {
    mockSdkLoaded();
    if (mockSdkFailure) throw new Error("SDK load secret-token");
    return {
    LambdaClient: class {
      send(cmd: unknown, options: unknown) {
        sentCommands.push(cmd);
        return mockSend(options);
      }
    },
    InvokeCommand: class {
      constructor(public input: unknown) {}
    },
    };
  },
  { virtual: true },
);

const commandList: Command[] = commands;
const handlerSource = fs.readFileSync(
  path.join(__dirname, '../lib/enshrouded/lambda/discord-bot/index.js'),
  'utf-8',
);

/** What a handler source dispatches on / reads, extracted textually so the test tracks the code. */
export function extractHandlerUsage(source: string) {
  const grab = (re: RegExp) => new Set([...source.matchAll(re)].map((m) => m[1]));
  return {
    commandNames: grab(/commandName === ['"]([^'"]+)['"]/g),
    subcommandNames: grab(/subcommand === ['"]([^'"]+)['"]/g),
    optionNames: grab(/getOption\(\s*interaction,\s*['"]([^'"]+)['"]\s*\)/g),
  };
}

/** Returns a list of drift problems between a handler source and a command set. */
export function findDrift(source: string, cmds: Command[]): string[] {
  const usage = extractHandlerUsage(source);
  const problems: string[] = [];
  const topNames = new Set(cmds.map((c) => c.name));
  const subs = new Map<string, Set<string>>(); // subcommand name -> its option names
  for (const c of cmds) {
    for (const s of c.options ?? []) {
      if (s.type === OPTION_TYPE.SUB_COMMAND) {
        subs.set(s.name, new Set((s.options ?? []).map((o) => o.name)));
      }
    }
  }
  const allOptions = new Set([...subs.values()].flatMap((s) => [...s]));
  for (const n of usage.commandNames) if (!topNames.has(n)) problems.push(`command "${n}" handled but not registered`);
  for (const n of usage.subcommandNames) if (!subs.has(n)) problems.push(`subcommand "${n}" handled but not registered`);
  for (const n of usage.optionNames) if (!allOptions.has(n)) problems.push(`option "${n}" read but not registered`);
  // Reverse: a registered subcommand the handler never dispatches would be a dead command.
  for (const n of subs.keys()) if (!usage.subcommandNames.has(n)) problems.push(`subcommand "${n}" registered but not handled`);
  return problems;
}

describe('command definitions', () => {
  test('/enshrouded is a single command with channel, help, pw, start and status subcommands (type 1)', () => {
    expect(commandList.map((c) => c.name)).toEqual(['enshrouded']);
    const subs = commandList[0].options ?? [];
    expect(subs.map((s) => s.name).sort()).toEqual(['channel', 'help', 'pw', 'start', 'status']);
    expect(subs.find((s) => s.name === 'channel')?.options ?? []).toEqual([]);
    for (const s of subs) expect(s.type).toBe(1);
  });

  test('names and descriptions satisfy Discord limits', () => {
    for (const cmd of commandList) {
      expect(cmd.name).toMatch(/^[-_\p{L}\p{N}]{1,32}$/u);
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeLessThanOrEqual(100);
      for (const opt of cmd.options ?? []) {
        expect(opt.name).toMatch(/^[-_\p{L}\p{N}]{1,32}$/u);
        expect(opt.name).toBe(opt.name.toLowerCase());
        expect(opt.description.length).toBeGreaterThan(0);
        expect(opt.description.length).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('anti-drift: handler vs commands.js', () => {
  test('the real handler has no drift against the real command set', () => {
    expect(findDrift(handlerSource, commandList)).toEqual([]);
  });

  test('the handler actually dispatches on something (extractor is not vacuous)', () => {
    const usage = extractHandlerUsage(handlerSource);
    expect(usage.commandNames).toContain('enshrouded');
    expect([...usage.subcommandNames].sort()).toEqual(['channel', 'help', 'pw', 'start', 'status']);
  });

  test('fails when the handler reads an option commands.js does not register', () => {
    const drifted = handlerSource + "\nconst x = getOption(interaction, 'surprise');\n";
    expect(findDrift(drifted, commandList)).toContain('option "surprise" read but not registered');
  });

  test('fails when the handler dispatches on an unregistered subcommand', () => {
    const drifted = handlerSource + "\nif (subcommand === 'stop') {}\n";
    expect(findDrift(drifted, commandList)).toContain('subcommand "stop" handled but not registered');
  });

  test('fails when the handler dispatches on an unregistered command', () => {
    const drifted = handlerSource + "\nif (commandName === 'other') {}\n";
    expect(findDrift(drifted, commandList)).toContain('command "other" handled but not registered');
  });

  test('fails when a registered subcommand is never handled', () => {
    const trimmed = handlerSource.replace("subcommand === 'status'", "subcommand === 'start'");
    expect(findDrift(trimmed, commandList)).toContain('subcommand "status" registered but not handled');
  });
});

describe('handler: signature verification, PING, deferred ack', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Raw 32-byte public key = last 32 bytes of the SPKI DER encoding.
  const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

  const TIMESTAMP = '1700000000';
  function signedEvent(body: object, opts: { tamper?: boolean; omit?: boolean } = {}) {
    const raw = JSON.stringify(body);
    const sig = crypto.sign(null, Buffer.from(TIMESTAMP + raw), privateKey).toString('hex');
    return {
      headers: opts.omit
        ? {}
        : { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': opts.tamper ? '1700000001' : TIMESTAMP },
      body: raw,
    };
  }

  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, DISCORD_PUBLIC_KEY: publicKeyHex, AWS_LAMBDA_FUNCTION_NAME: 'enshrouded-discord-bot' };
    sentCommands.length = 0;
    mockSdkFailure = false;
    mockSend.mockReset().mockResolvedValue({});
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 204 } as Response);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = OLD_ENV;
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('PING with a valid signature returns PONG', async () => {
    const res = await handler(signedEvent({ type: 1 }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ type: 1 });
  });

  test('invalid signature returns 401', async () => {
    const res = await handler(signedEvent({ type: 1 }, { tamper: true }));
    expect(res.statusCode).toBe(401);
  });

  test('missing signature headers return 401', async () => {
    const res = await handler(signedEvent({ type: 1 }, { omit: true }));
    expect(res.statusCode).toBe(401);
  });

  test('signature by a different key returns 401', async () => {
    process.env.DISCORD_PUBLIC_KEY = crypto
      .generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('hex');
    const res = await handler(signedEvent({ type: 1 }));
    expect(res.statusCode).toBe(401);
  });

  test('placeholder all-zero public key rejects everything with 401 (no throw)', async () => {
    process.env.DISCORD_PUBLIC_KEY = '0'.repeat(64);
    const res = await handler(signedEvent({ type: 1 }));
    expect(res.statusCode).toBe(401);
  });

  test('/enshrouded start acks with a deferred response and async self-invokes', async () => {
    const res = await handler(
      signedEvent({
        type: 2,
        id: 'interaction-id',
        token: 'tok',
        data: { name: 'enshrouded', options: [{ type: 1, name: 'start' }] },
      }),
    );
    expect(res).toEqual({ statusCode: 202, body: '' });
    expect(fetch).toHaveBeenCalledWith(
      'https://discord.com/api/v10/interactions/interaction-id/tok/callback',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ type: 5 }), signal: expect.any(AbortSignal) }),
    );
    expect(sentCommands).toHaveLength(1);
    const input = (sentCommands[0] as { input: { InvocationType: string; Payload: string } }).input;
    expect(input.InvocationType).toBe('Event');
    expect(JSON.parse(input.Payload)).toEqual({ _internal: 'finish-start', interactionToken: 'tok' });
  });

  test('/enshrouded status acks with a deferred response', async () => {
    const res = await handler(
      signedEvent({
        type: 2,
        id: 'interaction-id',
        token: 'tok',
        data: { name: 'enshrouded', options: [{ type: 1, name: 'status' }] },
      }),
    );
    expect(res).toEqual({ statusCode: 202, body: '' });
    expect(JSON.parse((sentCommands[0] as { input: { Payload: string } }).input.Payload)._internal).toBe('finish-status');
  });

  function commandEvent() {
    return signedEvent({ id: 'interaction-id', type: 2, token: 'secret-token',
      data: { name: 'enshrouded', options: [{ type: 1, name: 'start' }] } });
  }

  const channelRequest = {
    guild_id: '123456789012345678', channel_id: '234567890123456789',
    channel: { type: 0 }, member: { permissions: '32' }, app_permissions: '3088',
  };
  function channelEvent(overrides: object = {}) {
    return signedEvent({ type: 2, id: 'interaction-id', token: 'tok', ...channelRequest,
      data: { name: 'enshrouded', options: [{ type: 1, name: 'channel' }] }, ...overrides });
  }

  test.each([
    { member: undefined }, { member: { permissions: '0' } }, { member: { permissions: 'invalid' } },
    { guild_id: undefined }, { guild_id: 'bad' }, { channel_id: 'bad' },
    ...[1, 2, 5, 10, 11, 12, 13, 15, 16].map((type) => ({ channel: { type } })),
    { channel: undefined }, { app_permissions: '3072' }, { app_permissions: '1040' },
    { app_permissions: '2064' }, { app_permissions: undefined },
    { data: { name: 'enshrouded', options: [{ type: 1, name: 'channel', options: [{ name: 'channel', value: 'other' }] }] } },
  ])('channel rejection is ephemeral with no fetch or SDK load: %j', async (overrides) => {
    const loads = mockSdkLoaded.mock.calls.length;
    const res = await handler(channelEvent(overrides));
    expect(JSON.parse(res.body as string)).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockSdkLoaded).toHaveBeenCalledTimes(loads);
    expect(sentCommands).toHaveLength(0);
  });

  test.each(['32', '8'])('signed channel command accepts member permissions %s and defers ephemerally', async (permissions) => {
    expect(await handler(channelEvent({ member: { permissions }, app_permissions: '8' })))
      .toEqual({ statusCode: 202, body: '' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/callback'),
      expect.objectContaining({ body: JSON.stringify({ type: 5, data: { flags: 64 } }) }));
    expect(JSON.parse((sentCommands[0] as { input: { Payload: string } }).input.Payload)).toEqual({
      _internal: 'finish-channel', interactionToken: 'tok', guildId: channelRequest.guild_id,
      channelId: channelRequest.channel_id, channelType: 0, memberPermissions: permissions, appPermissions: '8',
    });
  });

  test('channel failed acknowledgement never dispatches', async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    expect(await handler(channelEvent())).toEqual({ statusCode: 202, body: '' });
    expect(sentCommands).toHaveLength(0);
  });

  test('invalid signed channel request never dispatches', async () => {
    const event = channelEvent();
    event.headers['X-Signature-Timestamp'] = 'tampered';
    expect((await handler(event)).statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
  });

  test('ack completes before SDK load and dispatch even when invocation stays pending', async () => {
    jest.resetModules();
    let coldHandler!: typeof handler;
    jest.isolateModules(() => {
      coldHandler = jest.requireActual('../lib/enshrouded/lambda/discord-bot/index').handler;
    });
    let acknowledge!: (response: Response) => void;
    let submit!: (value: object) => void;
    const ack = new Promise<Response>((resolve) => { acknowledge = resolve; });
    const submission = new Promise<object>((resolve) => { submit = resolve; });
    jest.mocked(fetch).mockReturnValueOnce(ack);
    mockSend.mockReturnValueOnce(submission);
    const loads = mockSdkLoaded.mock.calls.length;
    let returned = false;
    const result = coldHandler(commandEvent()).then((value) => { returned = true; return value; });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockSdkLoaded).toHaveBeenCalledTimes(loads);
    expect(sentCommands).toHaveLength(0);
    acknowledge({ ok: true, status: 204 } as Response);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sentCommands).toHaveLength(1);
    expect(returned).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"outcome":"acknowledged"'));
    submit({});
    expect(await result).toEqual({ statusCode: 202, body: '' });
  });

  test.each([400, 401, 404, 429, 500])('rejected ack (%s) never dispatches or retries', async (status) => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status } as Response);
    expect(await handler(commandEvent())).toEqual({ statusCode: 202, body: '' });
    expect(sentCommands).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"outcome":"rejected"'));
  });

  test.each(['network', 'timeout'])('unknown ack (%s) logs no token or URL and never dispatches', async (kind) => {
    jest.mocked(fetch).mockRejectedValueOnce(new Error(`${kind} https://discord.com/secret-token`));
    expect(await handler(commandEvent())).toEqual({ statusCode: 202, body: '' });
    expect(sentCommands).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const logs = JSON.stringify(jest.mocked(console.error).mock.calls);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"outcome":"unknown"'));
    expect(logs).not.toContain('secret-token');
    expect(logs).not.toContain('https://');
  });

  test.each(['success', 'rejected', 'network'])('invoke failure edits deferred message; PATCH %s still returns 202', async (patch) => {
    mockSend.mockRejectedValueOnce(new Error('transport secret-token'));
    if (patch === 'network') jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response)
      .mockRejectedValueOnce(new Error('https://discord.com/secret-token'));
    else jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response)
      .mockResolvedValueOnce({ ok: patch === 'success', status: patch === 'success' ? 200 : 404 } as Response);
    expect(await handler(commandEvent())).toEqual({ statusCode: 202, body: '' });
    expect(sentCommands).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/messages/@original'),
      expect.objectContaining({ method: 'PATCH', signal: expect.any(AbortSignal),
        body: JSON.stringify({ content: 'Unable to confirm request submission; check status before retrying.' }) }));
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('secret-token');
  });

  test('callback aborts at two seconds and dispatch remains blocked', async () => {
    jest.useFakeTimers();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    jest.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('secret-token')));
    }));
    try {
      const result = handler(commandEvent());
      await jest.advanceTimersByTimeAsync(2000);
      expect(await result).toEqual({ statusCode: 202, body: '' });
      expect(timeout).toHaveBeenCalledWith(2000);
      expect(sentCommands).toHaveLength(0);
    } finally { jest.useRealTimers(); }
  });

  test('SDK require failure after acknowledgement edits the reply and returns 202', async () => {
    mockSdkFailure = true;
    jest.resetModules();
    let isolatedHandler!: typeof handler;
    try {
      jest.isolateModules(() => {
        isolatedHandler = jest.requireActual('../lib/enshrouded/lambda/discord-bot/index').handler;
      });
      expect(await isolatedHandler(commandEvent())).toEqual({ statusCode: 202, body: '' });
      expect(sentCommands).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/messages/@original'),
        expect.objectContaining({ method: 'PATCH' }));
      expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('secret-token');
    } finally { mockSdkFailure = false; }
  });

  test('stalled Invoke and failure PATCH abort within five seconds after acknowledgement', async () => {
    jest.useFakeTimers();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mockSend.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('transport secret-token')));
    }));
    jest.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response)
      .mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('PATCH secret-token')));
      }));
    try {
      const result = handler(commandEvent());
      await jest.advanceTimersByTimeAsync(5000);
      expect(await result).toEqual({ statusCode: 202, body: '' });
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([2000, 3000, 2000]);
      expect(sentCommands).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('secret-token');
    } finally { jest.useRealTimers(); }
  });

  test('base64 signature verification still accepts PING', async () => {
    const event = signedEvent({ type: 1 });
    expect(await handler({ ...event, body: Buffer.from(event.body).toString('base64'), isBase64Encoded: true }))
      .toEqual(expect.objectContaining({ statusCode: 200, body: JSON.stringify({ type: 1 }) }));
    expect(fetch).not.toHaveBeenCalled();
  });

  test('bad command signature never calls Discord or AWS', async () => {
    const event = commandEvent();
    event.headers['X-Signature-Timestamp'] = 'tampered';
    expect((await handler(event)).statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
  });

});
