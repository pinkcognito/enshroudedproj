// WP-10: idle-shutdown classification + race-gate branch table (ARCHITECTURE 3.2, 5.5, 5.6).
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IdleShutdown } from '../lib/enshrouded/idle-shutdown';
import {
  handler,
  classify,
  normalizeProbe,
  UDP_RATE_THRESHOLD,
  CPU_RATE_THRESHOLD,
  Probe,
} from '../lib/enshrouded/lambda/idle-shutdown/index';

// ---------------------------------------------------------------- AWS SDK fakes
// (The SDK is provided by the Lambda runtime and is not a local dependency.)
type Cmd = { constructor: { name: string }; input: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const mockWorld = {
  params: new Map<string, string>(),
  instance: undefined as undefined | { State: { Name: string }; LaunchTime: Date },
  sent: [] as Cmd[],
  ssmSend: undefined as undefined | ((c: Cmd) => any), // eslint-disable-line @typescript-eslint/no-explicit-any
  invokeError: undefined as undefined | Error,
};
const mockCmd = (name: string) => ({ [name]: class { constructor(public input: unknown) {} } })[name];
function mockClient(handle: (c: Cmd) => Promise<unknown>) {
  return class {
    send(c: Cmd) {
      mockWorld.sent.push(c);
      return handle(c);
    }
  };
}
const notFound = () => Object.assign(new Error('nf'), { name: 'ParameterNotFound' });

jest.mock(
  '@aws-sdk/client-ec2',
  () => ({
    EC2Client: mockClient(async () => ({ Reservations: [{ Instances: mockWorld.instance ? [mockWorld.instance] : [] }] })),
    DescribeInstancesCommand: mockCmd('DescribeInstancesCommand'),
  }),
  { virtual: true },
);
jest.mock(
  '@aws-sdk/client-lambda',
  () => ({
    LambdaClient: mockClient(async () => {
      if (mockWorld.invokeError) throw mockWorld.invokeError;
      return {};
    }),
    InvokeCommand: mockCmd('InvokeCommand'),
  }),
  { virtual: true },
);
jest.mock(
  '@aws-sdk/client-ssm',
  () => ({
    SSMClient: mockClient(async (c: Cmd) => {
      const name = c.constructor.name;
      if (name === 'GetParameterCommand') {
        if (!mockWorld.params.has(c.input.Name)) throw notFound();
        return { Parameter: { Value: mockWorld.params.get(c.input.Name) } };
      }
      if (name === 'PutParameterCommand') {
        mockWorld.params.set(c.input.Name, c.input.Value);
        return {};
      }
      return mockWorld.ssmSend!(c);
    }),
    GetParameterCommand: mockCmd('GetParameterCommand'),
    PutParameterCommand: mockCmd('PutParameterCommand'),
    SendCommandCommand: mockCmd('SendCommandCommand'),
    GetCommandInvocationCommand: mockCmd('GetCommandInvocationCommand'),
  }),
  { virtual: true },
);

// ---------------------------------------------------------------- harness
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const MIN = 60_000;
const P = {
  maintenance: '/enshroudedproj/state/maintenance-mode',
  lastActive: '/enshroudedproj/state/last-active',
  runState: '/enshroudedproj/state/run-state',
  playerSeen: '/enshroudedproj/state/last-player-seen',
};
const STOP_ARN = 'arn:aws:lambda:us-east-2:123456789012:function:graceful-stop';

const count = (name: string) => mockWorld.sent.filter((c) => c.constructor.name === name).length;
const invokes = () => mockWorld.sent.filter((c) => c.constructor.name === 'InvokeCommand');
const probeCalls = () => count('SendCommandCommand');

/** A probe line as the on-box script would print it; `null` fields mean the signal failed. */
function probeLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ a2sOk: true, players: 0, logOk: true, mCount: 0, udpRate: 0.55, cpuRate: 0.283, ...over });
}
function probeReturns(stdout: string) {
  mockWorld.ssmSend = (c) => {
    if (c.constructor.name === 'SendCommandCommand') return Promise.resolve({ Command: { CommandId: 'cmd-1' } });
    return Promise.resolve({ Status: 'Success', StandardOutputContent: stdout });
  };
}
const probeFails = (status: string) => {
  mockWorld.ssmSend = (c) =>
    c.constructor.name === 'SendCommandCommand'
      ? Promise.resolve({ Command: { CommandId: 'cmd-1' } })
      : Promise.resolve({ Status: status, StandardOutputContent: '' });
};

beforeEach(() => {
  mockWorld.params = new Map([[P.lastActive, String(NOW - 30 * MIN)]]);
  mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 60 * MIN) };
  mockWorld.sent = [];
  mockWorld.invokeError = undefined;
  probeReturns(probeLine());
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  Object.assign(process.env, {
    INSTANCE_ID: 'i-0123456789abcdef0',
    STOP_FUNCTION_ARN: STOP_ARN,
    IDLE_MINUTES: '10',
    LAUNCH_GRACE_MINUTES: '15',
    MAX_UPTIME_HOURS: '12',
    LAST_ACTIVE_PARAM: P.lastActive,
    MAINTENANCE_MODE_PARAM: P.maintenance,
    RUN_STATE_PARAM: P.runState,
    LAST_PLAYER_SEEN_PARAM: P.playerSeen,
    POLL_INTERVAL_MS: '0',
  });
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------- classification table
const probe = (over: Partial<Probe> = {}): Probe => ({
  a2sOk: true, players: 0, logOk: true, mCount: 0, udpRate: 0.55, cpuRate: 0.283, ...over,
});

describe('classify(): ARCHITECTURE 5.6 branch table', () => {
  test('thresholds are the n=1 calibrations from 5.6', () => {
    expect(UDP_RATE_THRESHOLD).toBe(10);
    expect(CPU_RATE_THRESHOLD).toBe(0.6);
  });

  const table: [string, Partial<Probe> | null, string][] = [
    // ACTIVE: any single signal suffices
    ['A2S players>0 alone', { players: 1, mCount: 0 }, 'ACTIVE'],
    ['log mCount>0 alone (A2S says zero)', { mCount: 2 }, 'ACTIVE'],
    ['log mCount>0, A2S failed', { a2sOk: false, players: null, mCount: 1 }, 'ACTIVE'],
    ['UDP rate at threshold (>=), exact signals both zero', { udpRate: 10 }, 'ACTIVE'],
    ['UDP rate high, both exact signals unavailable', { a2sOk: false, players: null, logOk: false, mCount: null, udpRate: 211 }, 'ACTIVE'],
    ['CPU rate at threshold (>=), exact signals both zero', { cpuRate: 0.6 }, 'ACTIVE'],
    ['CPU rate high, both exact signals unavailable', { a2sOk: false, players: null, logOk: false, mCount: null, cpuRate: 1.36 }, 'ACTIVE'],
    // IDLE: an exact zero AND both heuristics quiet
    ['both exact zero, both heuristics quiet', {}, 'IDLE'],
    ['A2S zero only (log unavailable), heuristics quiet', { logOk: false, mCount: null }, 'IDLE'],
    ['log zero only (A2S unavailable), heuristics quiet', { a2sOk: false, players: null }, 'IDLE'],
    ['just under both thresholds', { udpRate: 9.99, cpuRate: 0.599 }, 'IDLE'],
    // INDETERMINATE
    ['no exact signal at all, heuristics quiet', { a2sOk: false, players: null, logOk: false, mCount: null }, 'INDETERMINATE'],
    ['exact zero but udpRate unavailable', { udpRate: null }, 'INDETERMINATE'],
    ['exact zero but cpuRate unavailable', { cpuRate: null }, 'INDETERMINATE'],
    ['probe failed entirely (null)', null, 'INDETERMINATE'],
  ];
  test.each(table)('%s -> %s', (_name, over, expected) => {
    expect(classify(over === null ? null : probe(over))).toBe(expected);
  });

  test('property 1: ACTIVE needs one signal, IDLE needs an exact zero AND both heuristics', () => {
    expect(classify(probe({ players: 1 }))).toBe('ACTIVE'); // one signal
    expect(classify(probe({ udpRate: 50 }))).toBe('ACTIVE'); // one signal, exact signals say zero
    expect(classify(probe({ udpRate: 50, cpuRate: 5 }))).toBe('ACTIVE');
    expect(classify(probe({ cpuRate: 0.9 }))).not.toBe('IDLE'); // heuristic disagreement blocks IDLE
    expect(classify(probe({ udpRate: 10.5 }))).not.toBe('IDLE');
  });

  test('property 2: CPU alone can never produce IDLE; it can only push toward ACTIVE', () => {
    // Sweep: with NO exact zero, no CPU value (even 0) and no UDP value below threshold gives IDLE.
    for (const cpuRate of [0, 0.1, 0.283, 0.5, 0.59, 0.6, 1.36, 8]) {
      for (const udpRate of [0, 0.55, 9.9]) {
        const noExact = probe({ a2sOk: false, players: null, logOk: false, mCount: null, cpuRate, udpRate });
        expect(classify(noExact)).not.toBe('IDLE');
      }
    }
    // Exact signals that report PLAYERS present can never be overridden into IDLE by a tiny CPU (AFK).
    expect(classify(probe({ players: 1, mCount: 1, cpuRate: 0.01 }))).toBe('ACTIVE');
    // CPU above threshold with an exact zero present is still never IDLE.
    expect(classify(probe({ cpuRate: 0.61 }))).not.toBe('IDLE');
    expect(classify(probe({ cpuRate: 0.61 }))).toBe('ACTIVE');
    // And CPU-low is not sufficient: an AFK player (UDP high, CPU idle-like) is ACTIVE.
    expect(classify(probe({ a2sOk: false, players: null, logOk: false, mCount: null, udpRate: 200, cpuRate: 0.28 }))).toBe('ACTIVE');
  });

  test('a probe with a2sOk:false and logOk:false but good-looking rates is INDETERMINATE', () => {
    expect(classify(probe({ a2sOk: false, players: null, logOk: false, mCount: null, udpRate: 0.4, cpuRate: 0.2 }))).toBe(
      'INDETERMINATE',
    );
  });
});

describe('normalizeProbe(): a missing/unparseable field is unavailable, never zero', () => {
  test.each([
    ['players missing though a2sOk true', { a2sOk: true, logOk: false, udpRate: 1, cpuRate: 0.1 }],
    ['players a string', { a2sOk: true, players: '0', logOk: false, udpRate: 1, cpuRate: 0.1 }],
    ['players null', { a2sOk: true, players: null, logOk: false, udpRate: 1, cpuRate: 0.1 }],
    ['players negative', { a2sOk: true, players: -1, logOk: false, udpRate: 1, cpuRate: 0.1 }],
    ['a2sOk truthy but not boolean true', { a2sOk: 1, players: 0, logOk: false, udpRate: 1, cpuRate: 0.1 }],
  ])('%s -> a2s unavailable', (_n, raw) => {
    const p = normalizeProbe(raw)!;
    expect(p.a2sOk).toBe(false);
    expect(classify(p)).toBe('INDETERMINATE');
  });
  test('missing mCount -> log unavailable', () => {
    expect(normalizeProbe({ a2sOk: false, logOk: true, udpRate: 0, cpuRate: 0 })!.logOk).toBe(false);
  });
  test('missing/NaN rates -> null, which blocks IDLE', () => {
    const p = normalizeProbe({ a2sOk: true, players: 0, logOk: true, mCount: 0, udpRate: 'x' })!;
    expect(p.udpRate).toBeNull();
    expect(p.cpuRate).toBeNull();
    expect(classify(p)).toBe('INDETERMINATE');
  });
  test('non-object / array -> null probe', () => {
    expect(normalizeProbe(null)).toBeNull();
    expect(normalizeProbe([1])).toBeNull();
    expect(normalizeProbe('x')).toBeNull();
  });
});

// ---------------------------------------------------------------- handler behaviour
describe('handler: gates', () => {
  test('maintenance mode true -> returns immediately: no describe, no probe, no stop, no writes', async () => {
    mockWorld.params.set(P.maintenance, 'true');
    probeReturns(probeLine());
    const r = await handler();
    expect(r.action).toBe('maintenance');
    expect(count('DescribeInstancesCommand')).toBe(0);
    expect(probeCalls()).toBe(0);
    expect(invokes()).toHaveLength(0);
    expect(count('PutParameterCommand')).toBe(0);
  });

  test('maintenance mode "false" or absent does not gate', async () => {
    mockWorld.params.set(P.maintenance, 'false');
    expect((await handler()).action).not.toBe('maintenance');
    mockWorld.params.delete(P.maintenance);
    expect((await handler()).action).not.toBe('maintenance');
  });

  test.each(['stopped', 'stopping', 'pending', 'shutting-down'])('state %s -> resets the clock, no probe, no stop', async (state) => {
    mockWorld.instance = { State: { Name: state }, LaunchTime: new Date(NOW - 600 * MIN) };
    const r = await handler();
    expect(r.action).toBe('not-running');
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
    expect(probeCalls()).toBe(0);
    expect(invokes()).toHaveLength(0);
  });

  test('instance not found at all -> resets the clock, no stop', async () => {
    mockWorld.instance = undefined;
    expect((await handler()).action).toBe('not-running');
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
    expect(invokes()).toHaveLength(0);
  });

  test('within the 15-minute LaunchTime grace -> no stop even with a zero reading and a stale clock', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 14 * MIN) };
    mockWorld.params.set(P.lastActive, String(NOW - 5 * 60 * MIN)); // 5 hours stale
    const r = await handler();
    expect(r.action).toBe('launch-grace');
    expect(probeCalls()).toBe(1); // grace PROBES (cannot stop yet, but can observe)
    expect(invokes()).toHaveLength(0);
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
  });

  // THE BUG THAT REACHED PRODUCTION: launch 17:21:33, a real player connected ~17:30 and left, and the
  // whole log was "within grace - not stopping". Grace returned BEFORE the probe, so last-player-seen was
  // never written and graceful-stop's save check had no evidence a player had ever been present.
  test('a player detected INSIDE grace writes last-player-seen, and grace still does not stop', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 11.4 * MIN) };
    probeReturns(probeLine({ a2sOk: true, players: 1, logOk: false, mCount: null }));
    const r = await handler();
    expect(r.action).toBe('launch-grace');
    expect(mockWorld.params.get(P.playerSeen)).toBe(String(NOW));
    expect(invokes()).toHaveLength(0);
  });

  test('a log-only exact detection inside grace also writes last-player-seen', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 3 * MIN) };
    probeReturns(probeLine({ a2sOk: false, players: null, logOk: true, mCount: 2 }));
    await handler();
    expect(mockWorld.params.get(P.playerSeen)).toBe(String(NOW));
  });

  test('a heuristic-only ACTIVE inside grace does NOT write last-player-seen', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 3 * MIN) };
    probeReturns(probeLine({ udpRate: 500, cpuRate: 2 })); // exact signals say zero
    await handler();
    expect(mockWorld.params.has(P.playerSeen)).toBe(false);
  });

  // last-active is a CONTROL variable (6.6.0). The unconditional grace write IS the race fix; narrowing it
  // to "only when ACTIVE" would let a fresh boot inherit a stale clock.
  test.each([
    ['a player is present', probeLine({ players: 1 })],
    ['no player (exact zero, quiet)', probeLine()],
    ['probe INDETERMINATE', probeLine({ a2sOk: false, players: null, logOk: false, mCount: null })],
  ])('grace writes last-active = now UNCONDITIONALLY and never stops (%s)', async (_n, line) => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 5 * MIN) };
    mockWorld.params.set(P.lastActive, String(NOW - 5 * 60 * MIN));
    probeReturns(line);
    expect((await handler()).action).toBe('launch-grace');
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
    expect(invokes()).toHaveLength(0);
  });

  test('grace with a failed probe still writes last-active and does not stop', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 5 * MIN) };
    mockWorld.params.set(P.lastActive, String(NOW - 5 * 60 * MIN));
    probeFails('Failed');
    expect((await handler()).action).toBe('launch-grace');
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
    expect(invokes()).toHaveLength(0);
  });

  test('grace exceeds the idle threshold: 11 minutes after launch is still protected', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 11 * MIN) };
    mockWorld.params.set(P.lastActive, String(NOW - 60 * MIN));
    await handler();
    expect(invokes()).toHaveLength(0);
  });

  test('stale last-active after a FAST restart (reset never ran) -> no stop', async () => {
    // Instance stopped and started inside one schedule tick: state was never seen as stopped,
    // last-active is hours old, but LaunchTime is fresh.
    mockWorld.params.set(P.lastActive, String(NOW - 9 * 60 * MIN));
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 2 * MIN) };
    probeReturns(probeLine());
    await handler();
    expect(invokes()).toHaveLength(0);
  });

  test('missing LaunchTime fails toward staying up', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: undefined as unknown as Date };
    await handler();
    expect(invokes()).toHaveLength(0);
    expect(probeCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------- last-player-seen (FACT, ARCHITECTURE 6.6.0)
describe('handler: last-player-seen is written only on EXACT detection', () => {
  const nowStr = () => String(NOW);
  const written = () =>
    mockWorld.sent.filter((c) => c.constructor.name === 'PutParameterCommand' && c.input.Name === P.playerSeen);

  test('A2S players > 0 -> stores wall-clock now (epoch ms)', async () => {
    probeReturns(probeLine({ players: 2, mCount: 0 }));
    await handler();
    expect(mockWorld.params.get(P.playerSeen)).toBe(nowStr());
  });

  test('log mCount > 0 with A2S failed -> stores now', async () => {
    probeReturns(probeLine({ a2sOk: false, players: null, mCount: 1 }));
    await handler();
    expect(mockWorld.params.get(P.playerSeen)).toBe(nowStr());
  });

  test('refreshed on every tick a player is present (it is a "last seen" timestamp)', async () => {
    mockWorld.params.set(P.playerSeen, String(NOW - 5 * MIN));
    probeReturns(probeLine({ players: 1 }));
    await handler();
    expect(mockWorld.params.get(P.playerSeen)).toBe(nowStr());
  });

  test.each([
    ['high udpRate, both exact signals zero', { udpRate: 211 }],
    ['high cpuRate, both exact signals zero', { cpuRate: 1.36 }],
    ['high udpRate and cpuRate, exact signals UNAVAILABLE', { a2sOk: false, players: null, logOk: false, mCount: null, udpRate: 300, cpuRate: 5 }],
  ])('HEURISTIC ONLY (%s) -> ACTIVE but last-player-seen is NOT written', async (_n, over) => {
    probeReturns(probeLine(over));
    const r = await handler();
    expect(r.classification).toBe('ACTIVE');
    expect(written()).toHaveLength(0);
    expect(mockWorld.params.has(P.playerSeen)).toBe(false);
  });

  test('IDLE and INDETERMINATE probes do not write it', async () => {
    probeReturns(probeLine());
    await handler();
    probeReturns(probeLine({ a2sOk: false, players: null, logOk: false, mCount: null }));
    await handler();
    expect(written()).toHaveLength(0);
  });

  test('a failed probe does not write it', async () => {
    probeFails('Failed');
    await handler();
    expect(written()).toHaveLength(0);
  });

  test('the five last-active housekeeping writes (bootstrap, reset, grace, INDETERMINATE) never touch it', async () => {
    // clock bootstrap on first IDLE observation
    mockWorld.params.delete(P.lastActive);
    probeReturns(probeLine());
    expect((await handler()).action).toBe('first-observation');
    // INDETERMINATE
    probeReturns(probeLine({ a2sOk: false, players: null, logOk: false, mCount: null }));
    expect((await handler()).action).toBe('indeterminate');
    expect(written()).toHaveLength(0);
    expect(mockWorld.params.has(P.playerSeen)).toBe(false);
  });

  test('NEVER CLEARED: the not-running reset leaves it untouched', async () => {
    mockWorld.params.set(P.playerSeen, '12345');
    mockWorld.instance = { State: { Name: 'stopped' }, LaunchTime: new Date(NOW - 60 * MIN) };
    const r = await handler();
    expect(r.action).toBe('not-running');
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW)); // the reset did run
    expect(mockWorld.params.get(P.playerSeen)).toBe('12345');
    expect(written()).toHaveLength(0);
  });

  test('NEVER CLEARED: launch-grace leaves it untouched', async () => {
    mockWorld.params.set(P.playerSeen, '12345');
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 3 * MIN) };
    expect((await handler()).action).toBe('launch-grace');
    expect(mockWorld.params.get(P.playerSeen)).toBe('12345');
    expect(written()).toHaveLength(0);
  });

  test('source guard: never deleted, and the ONLY write is recordPlayerSeen, called only behind exactPlayerDetected', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/enshrouded/lambda/idle-shutdown/index.js'), 'utf-8');
    expect(src).not.toMatch(/DeleteParameter/);
    const puts = src.split('\n').filter((l) => /lastPlayerSeenParam/.test(l) && /putParam\(/.test(l));
    expect(puts).toEqual(['    await putParam(c.lastPlayerSeenParam, nowMs);']);
    const calls = src.split('\n').filter((l) => /recordPlayerSeen\(/.test(l) && !/^async function/.test(l));
    expect(calls).toEqual(['  if (exactPlayerDetected(probe)) await recordPlayerSeen(c, now);']);
  });

  test('player-seen-boot is gone', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/enshrouded/lambda/idle-shutdown/index.js'), 'utf-8');
    expect(src).not.toMatch(/player-seen-boot|PLAYER_SEEN_BOOT|playerSeenBoot/);
  });
});

describe('handler: classification outcomes', () => {
  test('ACTIVE -> last-active = now, no stop', async () => {
    probeReturns(probeLine({ players: 2, mCount: 2 }));
    const r = await handler();
    expect(r).toMatchObject({ action: 'active', classification: 'ACTIVE' });
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
    expect(invokes()).toHaveLength(0);
  });

  test('a heuristic reporting activity overrides exact signals reporting zero', async () => {
    probeReturns(probeLine({ players: 0, mCount: 0, udpRate: 211 }));
    const r = await handler();
    expect(r.classification).toBe('ACTIVE');
    expect(invokes()).toHaveLength(0);
  });

  test('IDLE for >= 10 minutes -> invokes graceful-stop exactly once with exactly {reason:"idle"}', async () => {
    mockWorld.params.set(P.lastActive, String(NOW - 10 * MIN));
    const r = await handler();
    expect(r).toMatchObject({ action: 'stop-requested', classification: 'IDLE' });
    expect(invokes()).toHaveLength(1);
    const input = invokes()[0].input;
    expect(input.FunctionName).toBe(STOP_ARN);
    expect(input.InvocationType).toBe('Event');
    expect(JSON.parse(Buffer.from(input.Payload).toString())).toEqual({ reason: 'idle' });
    expect(mockWorld.params.get(P.runState)).toBe('stopping');
  });

  // Live: "Idle for 10.0 minutes (threshold 10)" printed on a tick that correctly did NOT stop (true value
  // ~9.996). The display is floored so it can never render the threshold while the gate still holds.
  test('9.996 idle minutes -> waits, and the log never renders the threshold', async () => {
    mockWorld.params.set(P.lastActive, String(NOW - 9.996 * MIN));
    const log = jest.spyOn(console, 'log');
    const r = await handler();
    expect(r.action).toBe('idle-waiting');
    expect(invokes()).toHaveLength(0);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Idle for'));
    expect(line).toBe('Idle for 9.9 minutes (threshold 10).');
  });

  test('IDLE for < 10 minutes -> waits, no stop, clock untouched', async () => {
    mockWorld.params.set(P.lastActive, String(NOW - 9 * MIN));
    const r = await handler();
    expect(r.action).toBe('idle-waiting');
    expect(invokes()).toHaveLength(0);
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW - 9 * MIN));
  });

  test('IDLE with no last-active recorded -> first observation, no stop', async () => {
    mockWorld.params.delete(P.lastActive);
    const r = await handler();
    expect(r.action).toBe('first-observation');
    expect(invokes()).toHaveLength(0);
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
  });

  test('run-state already "stopping" -> idempotence guard, no second invoke', async () => {
    mockWorld.params.set(P.runState, 'stopping');
    const r = await handler();
    expect(r.action).toBe('stop-in-flight');
    expect(invokes()).toHaveLength(0);
  });

  test('graceful-stop invoke failure restores run-state and surfaces the error', async () => {
    mockWorld.invokeError = new Error('throttled');
    await expect(handler()).rejects.toThrow('throttled');
    expect(mockWorld.params.get(P.runState)).not.toBe('stopping');
  });

  test('one exact signal unavailable, the other zero, heuristics low -> IDLE (exact tier is redundant)', async () => {
    mockWorld.params.set(P.lastActive, String(NOW - 20 * MIN));
    probeReturns(probeLine({ a2sOk: false, players: null })); // A2S broke; log says zero
    expect((await handler()).classification).toBe('IDLE');
    expect(invokes()).toHaveLength(1);
  });
});

describe('handler: property 3 - INDETERMINATE never stops the instance', () => {
  // Every case runs with a clock stale enough that an IDLE reading WOULD stop the box.
  beforeEach(() => mockWorld.params.set(P.lastActive, String(NOW - 600 * MIN)));

  const cases: [string, () => void][] = [
    ['SSM command Failed', () => probeFails('Failed')],
    ['SSM command TimedOut', () => probeFails('TimedOut')],
    ['SSM command Cancelled', () => probeFails('Cancelled')],
    ['SendCommand throws', () => { mockWorld.ssmSend = () => Promise.reject(new Error('AccessDenied')); }],
    ['command never completes (poll budget exhausted)', () => {
      process.env.POLL_ATTEMPTS = '3';
      mockWorld.ssmSend = (c) =>
        c.constructor.name === 'SendCommandCommand'
          ? Promise.resolve({ Command: { CommandId: 'c' } })
          : Promise.resolve({ Status: 'InProgress' });
    }],
    ['InvocationDoesNotExist forever', () => {
      process.env.POLL_ATTEMPTS = '3';
      mockWorld.ssmSend = (c) =>
        c.constructor.name === 'SendCommandCommand'
          ? Promise.resolve({ Command: { CommandId: 'c' } })
          : Promise.reject(Object.assign(new Error('x'), { name: 'InvocationDoesNotExist' }));
    }],
    ['stdout is not JSON', () => probeReturns('Traceback (most recent call last):')],
    ['stdout is empty', () => probeReturns('')],
    ['stdout is JSON but not an object', () => probeReturns('42')],
    ['a2sOk:false, logOk:false with good-looking rates', () => probeReturns(probeLine({ a2sOk: false, players: null, logOk: false, mCount: null, udpRate: 0.4, cpuRate: 0.2 }))],
    ['probe nulls everything (script crashed gracefully)', () => probeReturns(JSON.stringify({ a2sOk: false, players: null, logOk: false, mCount: null, udpRate: null, cpuRate: null }))],
    ['exact zero but rates missing', () => probeReturns(JSON.stringify({ a2sOk: true, players: 0, logOk: true, mCount: 0 }))],
    ['players missing though a2sOk:true (not coerced to zero)', () => probeReturns(JSON.stringify({ a2sOk: true, logOk: false, udpRate: 0.1, cpuRate: 0.1 }))],
  ];
  test.each(cases)('%s -> INDETERMINATE, graceful-stop never invoked, clock refreshed', async (_n, arrange) => {
    arrange();
    const r = await handler();
    expect(r.classification).toBe('INDETERMINATE');
    expect(r.action).toBe('indeterminate');
    expect(invokes()).toHaveLength(0);
    expect(mockWorld.params.get(P.runState)).toBeUndefined();
    expect(mockWorld.params.get(P.lastActive)).toBe(String(NOW));
  });

  test('CPU above threshold with no exact zero is never IDLE and never stops', async () => {
    probeReturns(JSON.stringify({ a2sOk: false, players: null, logOk: false, mCount: null, udpRate: 0.4, cpuRate: 0.9 }));
    const r = await handler();
    expect(r.classification).not.toBe('IDLE');
    expect(invokes()).toHaveLength(0);
  });

  test('metrics: DetectionIndeterminate=1 is emitted (EMF) on an indeterminate check', async () => {
    probeFails('Failed');
    await handler();
    const lines = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('{"_aws"'));
    expect(lines.map((l) => JSON.parse(l)).some((m) => m.DetectionIndeterminate === 1)).toBe(true);
  });
});

describe('handler: raw metrics and max-uptime cap', () => {
  const emf = () =>
    (console.log as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('{"_aws"'))
      .map((l) => JSON.parse(l));

  test('raw players / mCount / udpRate / cpuRate are emitted on every check', async () => {
    probeReturns(probeLine({ players: 1, mCount: 1, udpRate: 211, cpuRate: 1.36 }));
    await handler();
    const m = emf()[0];
    expect(m).toMatchObject({ Players: 1, MCount: 1, UdpRate: 211, CpuRate: 1.36 });
    expect(m._aws.CloudWatchMetrics[0].Metrics.map((x: { Name: string }) => x.Name)).toEqual(
      expect.arrayContaining(['Players', 'MCount', 'UdpRate', 'CpuRate']),
    );
  });

  test('an unavailable signal is omitted from the metrics, never recorded as 0', async () => {
    probeReturns(probeLine({ a2sOk: false, players: null, udpRate: null }));
    await handler();
    expect(emf()[0]).not.toHaveProperty('Players');
    expect(emf()[0]).not.toHaveProperty('UdpRate');
  });

  test('disagreement (ACTIVE while an exact signal says zero) emits SignalDisagreement=1', async () => {
    probeReturns(probeLine({ udpRate: 211 }));
    await handler();
    expect(emf()[0].SignalDisagreement).toBe(1);
  });

  test('max-uptime cap: > 12 h and not ACTIVE -> stop even when INDETERMINATE, and emits MaxUptimeCapHit', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 13 * 60 * MIN) };
    mockWorld.params.set(P.lastActive, String(NOW - 1 * MIN));
    probeFails('Failed');
    const r = await handler();
    expect(r.action).toBe('stop-requested');
    expect(invokes()).toHaveLength(1);
    expect(emf().some((m) => m.MaxUptimeCapHit === 1)).toBe(true);
  });

  test('max-uptime cap never interrupts a genuinely active session', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 30 * 60 * MIN) };
    probeReturns(probeLine({ players: 3, mCount: 3 }));
    await handler();
    expect(invokes()).toHaveLength(0);
  });

  test('under the cap, INDETERMINATE does not stop (cap is not a general escape hatch)', async () => {
    mockWorld.instance = { State: { Name: 'running' }, LaunchTime: new Date(NOW - 11 * 60 * MIN) };
    probeFails('Failed');
    await handler();
    expect(invokes()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- static guards
describe('handler source guards', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/enshrouded/lambda/idle-shutdown/index.js'), 'utf-8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

  test('no refuted mechanism: no fd / RSS / memory / working-set logic', () => {
    expect(code).not.toMatch(/\brss\b|vmrss|memory|workingset|working_set|wsDelta|\bfd\b|\/proc\/|open files|socket count|fdCount/i);
  });
  test('never calls StopInstances (stops go through graceful-stop only)', () => {
    expect(code).not.toMatch(/StopInstances|client-ec2.*Stop/);
    expect(code).not.toMatch(/TerminateInstances/);
  });
});

// ---------------------------------------------------------------- synthesised IAM
describe('IdleShutdown construct', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: { account: '123456789012', region: 'us-east-2' } });
  // Only instanceId is read by the construct.
  const instance = { instanceId: 'i-0123456789abcdef0' } as unknown as ec2.IInstance;
  const stopFn = lambda.Function.fromFunctionArn(stack, 'Stop', STOP_ARN);
  new IdleShutdown(stack, 'Idle', { instance, stopFunction: stopFn });
  const template = Template.fromStack(stack);
  const json = JSON.stringify(template.toJSON());
  type Stmt = { Effect: string; Action: string | string[]; Resource: unknown };
  const statements = (): Stmt[] =>
    Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Stmt[],
    );
  const actions = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

  test('policy contains NO ec2:StopInstances (nor any ec2:Stop*/Terminate*/ec2:*)', () => {
    for (const s of statements()) {
      for (const a of actions(s)) {
        expect(a).not.toMatch(/^ec2:(Stop|Terminate)/i);
        expect(a).not.toBe('ec2:*');
        expect(a).not.toBe('*');
      }
    }
    expect(json).not.toContain('StopInstances');
  });

  test('role is named enshrouded-idle-shutdown', () => {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'enshrouded-idle-shutdown' });
  });

  test('SSM: state/* only; no server/* or discord/*', () => {
    const ssmParamStmts = statements().filter((s) => actions(s).includes('ssm:GetParameter'));
    expect(ssmParamStmts).toHaveLength(1);
    const res = JSON.stringify(ssmParamStmts[0].Resource);
    expect(res).toContain('parameter/enshroudedproj/state/*');
    expect(json).not.toMatch(/parameter\/enshroudedproj\/(server|discord)/);
    expect(json).not.toContain('parameter//');
  });

  test('SendCommand is scoped to our instance + AWS-RunShellScript', () => {
    const s = statements().find((x) => actions(x).includes('ssm:SendCommand'))!;
    const res = JSON.stringify(s.Resource);
    expect(res).toContain('instance/i-0123456789abcdef0');
    expect(res).toContain('document/AWS-RunShellScript');
  });

  test('lambda:InvokeFunction only on the graceful-stop function', () => {
    const inv = statements().filter((s) => actions(s).includes('lambda:InvokeFunction'));
    expect(inv).toHaveLength(1);
    expect(inv[0].Resource).toBe(STOP_ARN);
  });

  test('1-minute schedule targeting the function; env wires 10 min idle, 15 min grace, 12 h cap', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 minute)' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          IDLE_MINUTES: '10',
          LAUNCH_GRACE_MINUTES: '15',
          MAX_UPTIME_HOURS: '12',
          STOP_FUNCTION_ARN: STOP_ARN,
        }),
      },
    });
  });

  test('grace exceeds idle threshold in the shipped config', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0];
    const v = fn.Properties.Environment.Variables;
    expect(Number(v.LAUNCH_GRACE_MINUTES)).toBeGreaterThan(Number(v.IDLE_MINUTES));
  });
});
