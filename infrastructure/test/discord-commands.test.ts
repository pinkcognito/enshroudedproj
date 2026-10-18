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
jest.mock(
  '@aws-sdk/client-lambda',
  () => ({
    LambdaClient: class {
      send(cmd: unknown) {
        sentCommands.push(cmd);
        return Promise.resolve({});
      }
    },
    InvokeCommand: class {
      constructor(public input: unknown) {}
    },
  }),
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
  test('/enshrouded is a single command with start and status subcommands (type 1)', () => {
    expect(commandList.map((c) => c.name)).toEqual(['enshrouded']);
    const subs = commandList[0].options ?? [];
    expect(subs.map((s) => s.name).sort()).toEqual(['start', 'status']);
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
    expect([...usage.subcommandNames].sort()).toEqual(['start', 'status']);
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
        token: 'tok',
        data: { name: 'enshrouded', options: [{ type: 1, name: 'start' }] },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ type: 5 });
    expect(sentCommands).toHaveLength(1);
    const input = (sentCommands[0] as { input: { InvocationType: string; Payload: string } }).input;
    expect(input.InvocationType).toBe('Event');
    expect(JSON.parse(input.Payload)).toEqual({ _internal: 'finish-start', interactionToken: 'tok' });
  });

  test('/enshrouded status acks with a deferred response', async () => {
    const res = await handler(
      signedEvent({
        type: 2,
        token: 'tok',
        data: { name: 'enshrouded', options: [{ type: 1, name: 'status' }] },
      }),
    );
    expect(JSON.parse(res.body as string)).toEqual({ type: 5 });
    expect(JSON.parse((sentCommands[0] as { input: { Payload: string } }).input.Payload)._internal).toBe('finish-status');
  });
});
