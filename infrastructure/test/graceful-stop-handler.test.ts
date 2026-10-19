// WP-09: graceful-stop. DATA-LOSS CRITICAL. The invariant under test:
//   StopInstances is unreachable unless save verification passes (and the S3 sync succeeds).
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServer } from '../lib/enshrouded/server';
import { GracefulStop } from '../lib/enshrouded/graceful-stop';

const ROOT = path.join(__dirname, '..');
const HANDLER_PATH = path.join(ROOT, 'lib', 'enshrouded', 'lambda', 'graceful-stop', 'index.js');
const DRAIN_PATH = path.join(ROOT, 'scripts', 'drain-and-save.sh');
const PROVISION_PATH = path.join(ROOT, 'scripts', 'provision-host.sh');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mod = require(HANDLER_PATH);

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------
const T0 = 1_000_000; // box wall clock, epoch seconds
const LAUNCH_MS = 500_000_000; // instance LaunchTime
const LAST_ACTIVE_MS = 900_000_000; // last-active, after LaunchTime (a player connected this boot)

interface Facts {
  t0?: number;
  postCount: number;
  postNewest: number;
  activeState?: string;
  result?: string;
  execMainCode?: string;
  execMainStatus?: string;
  gamePids?: number;
}

function drainStdout(f: Facts): string {
  return [
    `DRAIN_T0=${f.t0 ?? T0}`,
    'DRAIN_PRE_COUNT=1',
    'DRAIN_PRE_NEWEST=1',
    `DRAIN_POST_COUNT=${f.postCount}`,
    `DRAIN_POST_NEWEST=${f.postNewest}`,
    'DRAIN_STOP_RC=0',
    `DRAIN_ACTIVE_STATE=${f.activeState ?? 'inactive'}`,
    `DRAIN_RESULT=${f.result ?? 'success'}`,
    `DRAIN_EXEC_MAIN_CODE=${f.execMainCode ?? '1'}`,
    `DRAIN_EXEC_MAIN_STATUS=${f.execMainStatus ?? '0'}`,
    `DRAIN_GAME_PIDS=${f.gamePids ?? 0}`,
    'DRAIN_DONE=1',
  ].join('\n');
}

// A passing world: a disconnect save newer than last-active, nothing new at shutdown.
const COVERED: Facts = { postCount: 11, postNewest: LAST_ACTIVE_MS / 1000 + 5 };

interface Opts {
  probe?: object | 'fail';
  facts?: Facts;
  drainStdout?: string;
  drainOk?: boolean;
  drainThrows?: boolean;
  syncOk?: boolean;
  lastActive?: string | null;
  /** Stored player-seen-boot value; undefined/null = parameter absent. */
  playerSeenBoot?: string | null;
  launchTimeMs?: number;
  state?: string;
  stopThrows?: boolean;
  putParamThrows?: boolean;
}

function makeDeps(o: Opts = {}) {
  const calls: string[] = [];
  const params: Record<string, string> = {};
  const metrics: string[] = [];
  const deps = {
    now: () => 1234,
    getParam: async (n: string) => {
      calls.push(`getParam ${n}`);
      if (n === '/enshroudedproj/state/player-seen-boot') return o.playerSeenBoot ?? null;
      return o.lastActive === undefined ? String(LAST_ACTIVE_MS) : o.lastActive;
    },
    putParam: async (n: string, v: string) => {
      calls.push(`putParam ${n}=${v}`);
      if (o.putParamThrows) throw new Error('ssm down');
      params[n] = v;
    },
    describeInstance: async () => ({ state: o.state ?? 'running', launchTimeMs: o.launchTimeMs ?? LAUNCH_MS }),
    runOnBox: async (cmd: string) => {
      if (cmd.includes('probe-players')) {
        calls.push('probe');
        if (o.probe === 'fail') return { ok: false, status: 'Failed', stdout: '', stderr: '' };
        const p = o.probe ?? { a2sOk: true, players: 0, logOk: true, mCount: 0, udpRate: 1, cpuRate: 0 };
        return { ok: true, status: 'Success', stdout: JSON.stringify(p) + '\n', stderr: '' };
      }
      if (cmd.endsWith(' stop')) {
        calls.push('drain-stop');
        if (o.drainThrows) throw new Error('ssm exploded');
        return {
          ok: o.drainOk ?? true,
          status: o.drainOk === false ? 'Failed' : 'Success',
          stdout: o.drainStdout ?? drainStdout(o.facts ?? COVERED),
          stderr: '',
        };
      }
      if (cmd.endsWith(' sync')) {
        calls.push('drain-sync');
        const ok = o.syncOk ?? true;
        return { ok, status: ok ? 'Success' : 'Failed', stdout: ok ? 'DRAIN_SYNC=ok\n' : '', stderr: '' };
      }
      throw new Error(`unexpected command ${cmd}`);
    },
    stopInstance: async () => {
      calls.push('StopInstances');
      if (o.stopThrows) throw new Error('stop denied');
    },
    putMetric: async (n: string) => {
      calls.push(`metric ${n}`);
      metrics.push(n);
    },
    postDiscord: async (which: string) => {
      calls.push(`discord ${which}`);
      return true;
    },
  };
  return { deps, calls, params, metrics };
}

const run = async (o: Opts = {}, event: unknown = { reason: 'idle' }) => {
  const h = makeDeps(o);
  const result = await mod.createHandler(h.deps)(event);
  return { ...h, result };
};
const stopped = (calls: string[]) => calls.includes('StopInstances');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------------------------
describe('THE INVARIANT: StopInstances is unreachable unless save verification passes', () => {
  test('verification FAILS -> StopInstances is NEVER called, maintenance mode is set, alarm metric emitted, sync never runs', async () => {
    const { calls, params, metrics, result } = await run({
      facts: { postCount: 11, postNewest: LAST_ACTIVE_MS / 1000 - 600 }, // non-empty, older than last-active
    });
    expect(stopped(calls)).toBe(false);
    expect(calls).not.toContain('drain-sync');
    expect(params['/enshroudedproj/state/maintenance-mode']).toBe('true');
    expect(metrics).toContain('SaveVerificationFailed');
    expect(metrics).toContain('GracefulStopFailed');
    expect(calls).toContain('discord ops');
    expect(result).toMatchObject({ outcome: 'failed', stopped: false, maintenanceSet: true });
  });

  // Every way the verification/drain path can go wrong must land in the same safe place.
  const failures: Array<[string, Opts]> = [
    ['drain command reports Failed', { drainOk: false }],
    ['drain command throws', { drainThrows: true }],
    ['drain output is garbage (no DRAIN_DONE)', { drainStdout: 'Segmentation fault' }],
    ['drain output is empty', { drainStdout: '' }],
    ['unit still deactivating', { facts: { ...COVERED, activeState: 'deactivating' } }],
    ['unit still active', { facts: { ...COVERED, activeState: 'active' } }],
    ['Result=timeout', { facts: { ...COVERED, result: 'timeout', activeState: 'failed' } }],
    ['killed/9 (numeric code)', { facts: { ...COVERED, execMainCode: '2', execMainStatus: '9' } }],
    ['killed/9 (text code)', { facts: { ...COVERED, execMainCode: 'killed', execMainStatus: '9' } }],
    ['game process still alive', { facts: { ...COVERED, gamePids: 1 } }],
    ['last-active unreadable and nothing newer than t0', { lastActive: null }],
    ['S3 sync fails (world verified but not backed up)', { syncOk: false }],
    ['StopInstances itself throws', { stopThrows: true }],
  ];
  test.each(failures)('%s -> never stops via the verified path, maintenance mode set', async (_name, opts) => {
    const { calls, params, result } = await run(opts);
    expect(params['/enshroudedproj/state/maintenance-mode']).toBe('true');
    expect(result.outcome).toBe('failed');
    expect(result.stopped).toBe(false);
    if (opts.stopThrows !== true) expect(stopped(calls)).toBe(false);
    // A failed verification must also never reach the sync.
    if (opts.syncOk !== false && opts.stopThrows !== true) expect(calls).not.toContain('drain-sync');
  });

  test('an unexpected exception anywhere before the stop still does not stop the instance', async () => {
    const h = makeDeps();
    h.deps.describeInstance = async () => {
      throw new Error('ec2 down');
    };
    const result = await mod.createHandler(h.deps)({});
    expect(stopped(h.calls)).toBe(false);
    expect(h.params['/enshroudedproj/state/maintenance-mode']).toBe('true');
    expect(result.outcome).toBe('failed');
  });

  test('if setting maintenance mode itself fails, the instance is STILL not stopped and the result says so', async () => {
    const { calls, result } = await run({ facts: { postCount: 3, postNewest: 1 }, putParamThrows: true });
    expect(stopped(calls)).toBe(false);
    expect(result).toMatchObject({ outcome: 'failed', maintenanceSet: false });
  });
});

// ---------------------------------------------------------------------------------------------
describe('save verification table (ARCHITECTURE 3.2 step 12b), every row, through the handler', () => {
  test('row 1: a file has mtime > t0 -> PASS (shutdown save written)', async () => {
    const { calls, result } = await run({ facts: { postCount: 11, postNewest: T0 + 3 } });
    expect(result).toMatchObject({ outcome: 'stopped', stopped: true, saveCheck: 'shutdown-save-written' });
    expect(stopped(calls)).toBe(true);
  });

  test('row 2: newest mtime >= last-active (disconnect save covered it) -> PASS', async () => {
    const { calls, result } = await run({ facts: { postCount: 11, postNewest: LAST_ACTIVE_MS / 1000 + 5 } });
    expect(result).toMatchObject({ outcome: 'stopped', saveCheck: 'covered-by-disconnect-save' });
    expect(stopped(calls)).toBe(true);
  });

  test('row 2 boundary: newest mtime exactly == last-active -> PASS', async () => {
    const { result } = await run({ facts: { postCount: 2, postNewest: LAST_ACTIVE_MS / 1000 } });
    expect(result.outcome).toBe('stopped');
  });

  test('row 3: non-empty, newest < last-active, nothing newer than t0 -> FAIL (the real data-loss signature)', async () => {
    const { calls, params, result } = await run({ facts: { postCount: 11, postNewest: LAST_ACTIVE_MS / 1000 - 1 } });
    expect(result).toMatchObject({ outcome: 'failed', check: 'save-verification' });
    expect(result.detail).toMatch(/save-not-flushed/);
    expect(stopped(calls)).toBe(false);
    expect(params['/enshroudedproj/state/maintenance-mode']).toBe('true');
  });

  // THE WEDGE REGRESSION. last-active is stamped to "now" by idle-shutdown's launch-grace and
  // INDETERMINATE branches, so on a session nobody joined it is AFTER LaunchTime. The old rule read that as
  // "a player connected" -> FAIL -> maintenance mode set. Started, nobody showed up, savegame/ empty
  // must PASS, with last-active deliberately well after LaunchTime and player-seen-boot absent.
  test('row 4 (WEDGE REGRESSION): empty savegame/, nobody connected, last-active AFTER LaunchTime -> PASS + SaveSkippedEmptyWorld, maintenance mode NOT set', async () => {
    const { calls, params, metrics, result } = await run({
      facts: { postCount: 0, postNewest: 0 },
      lastActive: String(LAUNCH_MS + 60_000), // stamped by the grace branch: after LaunchTime
      playerSeenBoot: null,
    });
    expect(result).toMatchObject({ outcome: 'stopped', saveCheck: 'empty-no-player' });
    expect(metrics).toContain('SaveSkippedEmptyWorld');
    expect(stopped(calls)).toBe(true);
    expect(params['/enshroudedproj/state/maintenance-mode']).toBeUndefined();
    expect(metrics).not.toContain('GracefulStopFailed');
  });

  test('row 4: a STALE player-seen-boot (a previous boot) -> not seen -> PASS', async () => {
    const { calls, params, metrics, result } = await run({
      facts: { postCount: 0, postNewest: 0 },
      playerSeenBoot: String(LAUNCH_MS - 3_600_000),
    });
    expect(result).toMatchObject({ outcome: 'stopped', saveCheck: 'empty-no-player' });
    expect(metrics).toContain('SaveSkippedEmptyWorld');
    expect(stopped(calls)).toBe(true);
    expect(params['/enshroudedproj/state/maintenance-mode']).toBeUndefined();
  });

  test('row 4: an unparseable player-seen-boot is "not seen", not an error -> PASS', async () => {
    const { result } = await run({ facts: { postCount: 0, postNewest: 0 }, playerSeenBoot: 'garbage' });
    expect(result).toMatchObject({ outcome: 'stopped', saveCheck: 'empty-no-player' });
  });

  test('row 5: empty savegame/ WITH player-seen-boot == this boot LaunchTime -> FAIL', async () => {
    const { calls, params, metrics, result } = await run({
      facts: { postCount: 0, postNewest: 0 },
      playerSeenBoot: String(LAUNCH_MS),
    });
    expect(result).toMatchObject({ outcome: 'failed', check: 'save-verification' });
    expect(result.detail).toMatch(/empty-world-after-player/);
    expect(metrics).not.toContain('SaveSkippedEmptyWorld');
    expect(stopped(calls)).toBe(false);
    expect(params['/enshroudedproj/state/maintenance-mode']).toBe('true');
  });

  test('row 5 does not depend on last-active at all (stale last-active, matching flag -> still FAIL)', async () => {
    const { result } = await run({
      facts: { postCount: 0, postNewest: 0 },
      lastActive: String(LAUNCH_MS - 1000),
      playerSeenBoot: String(LAUNCH_MS),
    });
    expect(result).toMatchObject({ outcome: 'failed', check: 'save-verification' });
  });

  test('player-seen-boot is read before the stop and never written or cleared by graceful-stop', async () => {
    const { calls } = await run({ facts: { postCount: 0, postNewest: 0 } });
    expect(calls.indexOf('getParam /enshroudedproj/state/player-seen-boot')).toBeLessThan(calls.indexOf('drain-stop'));
    expect(calls.filter((c) => c.startsWith('putParam /enshroudedproj/state/player-seen-boot'))).toHaveLength(0);
  });

  test('the pure verdict function agrees with the table (no handler involved)', () => {
    const f = (postCount: number, postNewest: number) => mod.parseDrainFacts(drainStdout({ postCount, postNewest }));
    const ev = (facts: object, lastActiveMs: number, playerSeenBootMs = NaN) =>
      mod.evaluateSave(facts, { lastActiveMs, launchTimeMs: LAUNCH_MS, playerSeenBootMs });
    expect(ev(f(5, T0 + 1), LAST_ACTIVE_MS).pass).toBe(true);
    expect(ev(f(5, 800_000), 790_000_000).pass).toBe(true);
    expect(ev(f(5, 700_000), 790_000_000).pass).toBe(false);
    expect(ev(f(0, 0), LAUNCH_MS + 1).pass).toBe(true); // last-active after LaunchTime says NOTHING
    expect(ev(f(0, 0), LAUNCH_MS + 1).skippedEmptyWorld).toBe(true);
    expect(ev(f(0, 0), LAUNCH_MS + 1, LAUNCH_MS - 5).pass).toBe(true); // stale flag
    expect(ev(f(0, 0), LAUNCH_MS - 1, LAUNCH_MS).pass).toBe(false); // matching flag
  });
});

// ---------------------------------------------------------------------------------------------
describe('unit exit signature (ARCHITECTURE 3.2 step 12c): fail ONLY on truncation, never gate on Result=success', () => {
  test.each([
    ['exit-code', '1', '130'],
    ['signal', '2', '2'], // killed by SIGINT, not SIGKILL
    ['signal', 'killed', '2'],
    ['exit-code', '1', '1'],
    ['success', '1', '0'],
    ['core-dump', '3', '6'],
  ])('Result=%s ExecMainCode=%s ExecMainStatus=%s is ACCEPTED (stop proceeds)', async (result, code, status) => {
    const { calls, result: r } = await run({
      facts: { ...COVERED, activeState: result === 'success' ? 'inactive' : 'failed', result, execMainCode: code, execMainStatus: status },
    });
    expect(r.outcome).toBe('stopped');
    expect(stopped(calls)).toBe(true);
  });

  test.each([
    ['timeout', '1', '0', 'Result=timeout'],
    ['signal', 'killed', '9', 'killed/9 spelled as text'],
    ['signal', '2', '9', 'killed/9 spelled as systemctl show prints it (CLD_KILLED=2)'],
  ])('Result=%s ExecMainCode=%s ExecMainStatus=%s is REJECTED (%s)', async (result, code, status) => {
    const { calls, params, result: r } = await run({
      facts: { ...COVERED, activeState: 'failed', result, execMainCode: code, execMainStatus: status },
    });
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/truncated-stop/);
    expect(stopped(calls)).toBe(false);
    expect(params['/enshroudedproj/state/maintenance-mode']).toBe('true');
  });

  test('exit status 137 (shell convention) is NOT what systemd reports and is not gated on', () => {
    expect(mod.isTruncatedStop('exit-code', '1', '137')).toBe(false);
  });

  test('ActiveState=failed (what systemd reports after Result=exit-code/signal) is accepted; deactivating is not', async () => {
    const ok = await run({ facts: { ...COVERED, activeState: 'failed', result: 'exit-code' } });
    expect(ok.result.outcome).toBe('stopped');
    const bad = await run({ facts: { ...COVERED, activeState: 'deactivating' } });
    expect(bad.result.outcome).toBe('failed');
  });
});

// ---------------------------------------------------------------------------------------------
describe('player re-check', () => {
  test.each([
    ['A2S reports a player', { a2sOk: true, players: 1, logOk: true, mCount: 0 }],
    ['log reports a player', { a2sOk: true, players: 0, logOk: true, mCount: 2 }],
    ['A2S failed but the log reports a player', { a2sOk: false, players: null, logOk: true, mCount: 1 }],
  ])('%s -> aborts without stopping, distinct from a failure', async (_n, probe) => {
    const { calls, params, metrics, result } = await run({ probe });
    expect(result).toMatchObject({ outcome: 'aborted-players-present', stopped: false });
    expect(result.outcome).not.toBe('failed');
    expect(stopped(calls)).toBe(false);
    expect(calls).not.toContain('drain-stop'); // the game was never stopped
    expect(params['/enshroudedproj/state/maintenance-mode']).toBeUndefined(); // NOT a failure
    expect(metrics).toEqual([]); // no alarm
    expect(calls).not.toContain('discord ops');
    expect(params['/enshroudedproj/state/last-active']).toBe('1234'); // 3.2 step 10
    expect(params['/enshroudedproj/state/run-state']).toBe('none');
  });

  test.each([
    ['probe command fails', 'fail' as const],
    ['probe says nothing is readable', { a2sOk: false, players: null, logOk: false, mCount: null }],
  ])('%s -> does not stop (indeterminate), no maintenance mode, no alarm', async (_n, probe) => {
    const { calls, params, metrics, result } = await run({ probe });
    expect(result).toMatchObject({ outcome: 'aborted-indeterminate', stopped: false });
    expect(calls).not.toContain('drain-stop');
    expect(stopped(calls)).toBe(false);
    expect(params['/enshroudedproj/state/maintenance-mode']).toBeUndefined();
    expect(metrics).toEqual([]);
  });

  test('a not-running instance is a no-op', async () => {
    const { calls, result } = await run({ state: 'stopped' });
    expect(result.outcome).toBe('noop-not-running');
    expect(calls).not.toContain('drain-stop');
    expect(stopped(calls)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('ordering', () => {
  test('happy path order: recheck, last-active read, stop+verify, S3 sync, THEN StopInstances', async () => {
    const { calls, result } = await run();
    expect(result.outcome).toBe('stopped');
    const idx = (s: string) => calls.indexOf(s);
    expect(idx('probe')).toBeGreaterThanOrEqual(0);
    expect(idx('probe')).toBeLessThan(idx('drain-stop'));
    expect(idx('getParam /enshroudedproj/state/last-active')).toBeLessThan(idx('drain-stop'));
    expect(idx('drain-stop')).toBeLessThan(idx('drain-sync'));
    expect(idx('drain-sync')).toBeLessThan(idx('StopInstances'));
    expect(calls.filter((c) => c === 'StopInstances')).toHaveLength(1);
  });

  test('the S3 sync is never issued after StopInstances', async () => {
    const { calls } = await run();
    expect(calls.slice(calls.indexOf('StopInstances') + 1)).not.toContain('drain-sync');
  });

  test('source: evaluateSave precedes the sync, which precedes the single stopInstance call', () => {
    const src = fs.readFileSync(HANDLER_PATH, 'utf8');
    const verify = src.indexOf('evaluateSave(facts');
    const sync = src.indexOf('${DRAIN_SCRIPT} sync');
    const stop = src.indexOf('deps.stopInstance()');
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(sync);
    expect(sync).toBeLessThan(stop);
    expect(src.match(/\.stopInstance\(\)/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('payload tolerance', () => {
  test.each([[undefined], [null], [{}], ['junk'], [{ reason: 7, requestedBy: {} }], [{ reason: 'manual', requestedBy: 'u1', extra: 1 }]])(
    'payload %j is accepted',
    async (payload) => {
      const { result } = await run({}, payload);
      expect(result.outcome).toBe('stopped');
    },
  );
});

// ---------------------------------------------------------------------------------------------
describe('wall-clock discipline', () => {
  test('no game-log timestamp is read or compared anywhere in the handler or the drain script', () => {
    for (const p of [HANDLER_PATH, DRAIN_PATH]) {
      const code = fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*#|^\s*\/\//.test(l)) // comments may explain the rule
        .join('\n');
      expect(code).not.toMatch(/enshrouded_server\.log|\/logs\/|journalctl|--since/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('drain-and-save.sh', () => {
  const raw = fs.readFileSync(DRAIN_PATH, 'utf8');
  // Comments may explain the rules; assertions are about executable lines.
  const sh = raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  test('is LF-only and parses structurally', () => {
    expect(raw).not.toMatch(/\r/);
    expect(raw.startsWith('#!/bin/bash\n')).toBe(true);
  });
  test('stops via systemctl and never signals the game itself (ExecStop owns that)', () => {
    expect(sh).toMatch(/systemctl stop "\$UNIT"/);
    expect(sh).toMatch(/UNIT=enshrouded\.service/);
    expect(sh).not.toMatch(/\bkill\b|pkill|killall|-INT|SIGINT/);
  });
  test('snapshots before the stop and reads Result/ExecMainCode/ExecMainStatus', () => {
    expect(sh.indexOf('read -r pre_count')).toBeLessThan(sh.indexOf('systemctl stop'));
    expect(sh.indexOf('t0="$(date +%s.%N)"')).toBeLessThan(sh.indexOf('systemctl stop'));
    for (const p of ['ActiveState', 'Result', 'ExecMainCode', 'ExecMainStatus']) expect(sh).toContain(`-p ${p}`);
  });
  test('syncs without --delete and refuses while the game process is alive', () => {
    expect(sh).toMatch(/aws s3 sync/);
    expect(sh).not.toMatch(/--delete/);
    expect(sh).toMatch(/pgrep -x "\$GAME_COMM"/);
  });
  test('provision-host.sh delivers a byte-identical copy as a root-owned 0755 helper', () => {
    const provision = fs.readFileSync(PROVISION_PATH, 'utf8');
    const m = /\n[ \t]*write_if_changed (\S+) (\d+) <<'DRAIN_EOF'\n([\s\S]*?)\nDRAIN_EOF\n/.exec(provision);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/usr/local/lib/enshrouded/drain-and-save.sh');
    expect(m![2]).toBe('0755');
    expect(m![3]).toBe(raw.replace(/\n$/, ''));
  });
});

// ---------------------------------------------------------------------------------------------
describe('construct / IAM', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'EnshroudedTestGracefulStop', {
    env: { account: '123456789012', region: 'us-east-2' },
  });
  const server = new EnshroudedServer(stack, 'Server');
  const gs = new GracefulStop(stack, 'GracefulStop', { instance: server.instance });
  const template = Template.fromStack(stack);

  type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
  const roleLogical = Object.keys(template.findResources('AWS::IAM::Role', { Properties: { RoleName: 'enshrouded-graceful-stop' } }));
  const statements: Statement[] = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const roles = (policy.Properties.Roles as { Ref: string }[]).map((r) => r.Ref);
    if (roles.includes(roleLogical[0])) statements.push(...(policy.Properties.PolicyDocument.Statement as Statement[]));
  }
  const acts = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
  const withAction = (a: string) => statements.filter((s) => acts(s).includes(a));
  const res = (s: Statement) => JSON.stringify(s.Resource);

  test('exposes stopFunction, and the role is enshrouded- prefixed', () => {
    expect(gs.stopFunction).toBeDefined();
    expect(roleLogical).toHaveLength(1);
  });
  test('ec2:StopInstances is scoped to our instance ARN only, never a wildcard', () => {
    const s = withAction('ec2:StopInstances');
    expect(s).toHaveLength(1);
    expect(res(s[0])).not.toMatch(/"\*"/);
    expect(res(s[0])).toMatch(/instance\//);
    expect(res(s[0])).toContain('"Ref":"ServerInstance');
  });
  test('ssm:SendCommand: our instance and AWS-RunShellScript only', () => {
    const s = withAction('ssm:SendCommand');
    expect(s).toHaveLength(1);
    expect(res(s[0])).toContain('document/AWS-RunShellScript');
    expect(res(s[0])).toMatch(/instance\//);
    expect(res(s[0])).not.toMatch(/"\*"/);
  });
  test('SSM parameter grants: state/* RW, discord/* R, and NO server/* anywhere', () => {
    const ssmStmts = statements.filter((s) => acts(s).some((a) => /^ssm:(Get|Put)Parameter/.test(a)));
    const all = ssmStmts.map(res).join('\n');
    expect(all).not.toMatch(/parameter\/enshroudedproj\/server/);
    expect(all).not.toMatch(/parameter\/enshroudedproj\/\*/);
    const put = withAction('ssm:PutParameter');
    expect(put).toHaveLength(1);
    expect(res(put[0])).toContain('enshroudedproj/state/*');
    expect(res(put[0])).not.toContain('discord');
  });
  test('async retries are disabled so a drain is never re-run automatically', () => {
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0 });
  });
  test('alarms exist on SaveVerificationFailed and GracefulStopFailed', () => {
    for (const name of ['SaveVerificationFailed', 'GracefulStopFailed']) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: name, Namespace: 'Enshrouded' });
    }
  });
  test('stack name guard: the test stack is Enshrouded-prefixed', () => {
    expect(stack.stackName.startsWith('Enshrouded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Whole-stack wiring (GracefulStop + IdleShutdown instantiated in EnshroudedServerStack).
// ---------------------------------------------------------------------------------------------
describe('stack wiring: idle-shutdown -> graceful-stop', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EnshroudedServerStack } = require('../lib/enshrouded-server-stack');
  const app = new cdk.App();
  const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
    stackName: 'EnshroudedServerStack',
    env: { account: '123456789012', region: 'us-east-2' },
  });
  // Same App-level tags as bin/enshrouded.ts.
  cdk.Tags.of(app).add('project', 'enshroudedproj');
  cdk.Tags.of(app).add('repo', 'pinkcognito/enshroudedproj');
  const template = Template.fromStack(stack);
  type Stmt = { Effect: string; Action: string | string[]; Resource: unknown };
  const stmtsFor = (roleName: string): Stmt[] => {
    const ids = Object.keys(template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } }));
    expect(ids).toHaveLength(1);
    const out: Stmt[] = [];
    for (const p of Object.values(template.findResources('AWS::IAM::Policy'))) {
      const attached = (p.Properties.Roles as { Ref: string }[]).map((r) => r.Ref);
      if (attached.includes(ids[0])) out.push(...(p.Properties.PolicyDocument.Statement as Stmt[]));
    }
    return out;
  };
  const acts = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
  const idle = stmtsFor('enshrouded-idle-shutdown');
  const gstop = stmtsFor('enshrouded-graceful-stop');
  const fnLogicalId = (name: string) =>
    Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }))[0];

  test('both Lambdas are in the synthesised stack', () => {
    expect(fnLogicalId('enshrouded-idle-shutdown')).toBeDefined();
    expect(fnLogicalId('enshrouded-graceful-stop')).toBeDefined();
  });
  test('interface contract: idle-shutdown is wired to graceful-stop (env ARN, invoke grant), not to a literal', () => {
    const gsId = fnLogicalId('enshrouded-graceful-stop');
    const env = template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'enshrouded-idle-shutdown' } });
    const vars = Object.values(env)[0].Properties.Environment.Variables;
    expect(JSON.stringify(vars.STOP_FUNCTION_ARN)).toContain(gsId);
    const inv = idle.filter((s) => acts(s).includes('lambda:InvokeFunction'));
    expect(inv).toHaveLength(1);
    expect(JSON.stringify(inv[0].Resource)).toContain(gsId);
    expect(vars.PLAYER_SEEN_BOOT_PARAM).toBe('/enshroudedproj/state/player-seen-boot');
  });
  test('the idle-shutdown payload {reason:"idle"} is accepted by the graceful-stop handler (no throw, a verdict)', async () => {
    const { result } = await run({}, { reason: 'idle' });
    expect(result.outcome).toBe('stopped');
  });
  test('idle-shutdown has NO ec2:StopInstances (nor ec2:*), so every stop routes through graceful-stop', () => {
    for (const s of idle) for (const a of acts(s)) expect(a).not.toMatch(/^ec2:(\*|Stop|Terminate)/i);
    expect(JSON.stringify(idle)).not.toContain('StopInstances');
  });
  test('graceful-stop ec2:StopInstances is exactly one statement, on our instance ARN only', () => {
    const s = gstop.filter((x) => acts(x).includes('ec2:StopInstances'));
    expect(s).toHaveLength(1);
    expect(JSON.stringify(s[0].Resource)).not.toContain('"*"');
    expect(JSON.stringify(s[0].Resource)).toContain('"Ref":"ServerInstance');
  });
  test('neither Lambda can touch server/*; idle-shutdown is state/* only', () => {
    for (const set of [idle, gstop]) {
      const ssm = set.filter((s) => acts(s).some((a) => /^ssm:(Get|Put)Parameter/.test(a)));
      expect(JSON.stringify(ssm)).not.toMatch(/enshroudedproj\/server/);
      expect(JSON.stringify(ssm)).not.toMatch(/parameter\/enshroudedproj\/\*/);
    }
    const idleSsm = idle.filter((s) => acts(s).some((a) => /^ssm:(Get|Put)Parameter/.test(a)));
    expect(JSON.stringify(idleSsm)).toContain('enshroudedproj/state/*');
    expect(JSON.stringify(idleSsm)).not.toContain('discord');
  });
  test('every taggable resource of both constructs carries project + repo tags', () => {
    const tagsOf = (r: { [k: string]: any }) => // eslint-disable-line @typescript-eslint/no-explicit-any
      Object.fromEntries(((r.Properties.Tags ?? []) as { Key: string; Value: string }[]).map((t) => [t.Key, t.Value]));
    const checks: [string, (r: any) => boolean][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ['AWS::Lambda::Function', (r) => /^enshrouded-(idle-shutdown|graceful-stop)$/.test(r.Properties.FunctionName)],
      ['AWS::IAM::Role', (r) => /^enshrouded-(idle-shutdown|graceful-stop)$/.test(r.Properties.RoleName)],
      ['AWS::CloudWatch::Alarm', (r) => /SaveVerificationFailed|GracefulStopFailed/.test(r.Properties.AlarmName)],
      ['AWS::Events::Rule', (r) => r.Properties.Name === 'enshrouded-idle-shutdown'],
    ];
    for (const [type, pick] of checks) {
      const found = Object.values(template.findResources(type)).filter(pick);
      expect(found.length).toBeGreaterThan(0);
      for (const r of found) {
        expect(tagsOf(r)).toMatchObject({ project: 'enshroudedproj', repo: 'pinkcognito/enshroudedproj' });
      }
    }
  });
  // (hnb659fds is checked against the real `cdk synth` output: the qualifier comes from cdk.json, which
  // a bare `new cdk.App()` does not read.)
  test('stack is Enshrouded-named', () => {
    expect(stack.stackName).toMatch(/^Enshrouded/);
  });
});
