// WP-08: scripts/probe-players.py - log parser, rate maths, never-throws, delivery, and the
// "no fd / RSS logic" guard. Runs the real Python via python3 (stdlib only).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dgram from 'dgram';
import { execFile, spawnSync } from 'child_process';

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'probe-players.py');
const PROVISION = path.join(ROOT, 'scripts', 'provision-host.sh');
const probeSrc = fs.readFileSync(PROBE, 'utf8');

// Almost every test here spawns a real Python interpreter, and Jest's default
// per-test budget is 5 s. Interpreter startup on a loaded machine (CI running
// other suites in parallel, or a dev box mid-build) intermittently blows that,
// which produced a flaky failure roughly 1 run in 6 - always in this file, never
// reproducible on a quiet machine. A flaky check in a merge gate is worse than a
// slow one: it teaches people to re-run instead of look.
jest.setTimeout(20000);

const PY = ['python3', 'python'].find((c) => {
  const r = spawnSync(c, ['-c', 'import sys; sys.exit(0 if sys.version_info[0]==3 else 1)']);
  return r.status === 0;
}) as string;

function py(code: string, args: string[] = []): Promise<string> {
  const harness = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("probe", sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
${code}`;
  return new Promise((resolve, reject) => {
    execFile(PY, ['-c', harness, PROBE, ...args], { timeout: 30000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout.trim()));
  });
}
const pyJson = async (code: string, args: string[] = []) => JSON.parse(await py(code, args));

// FIXTURES CAPTURED FROM PRODUCTION: verbatim lines from /srv/enshrouded/logs/enshrouded_server.log
// on the live host (i-02718657e8fed78b0), captured 2026-10-19 via SSM, byte-exact (LF, no CR).
// Real format: every line is prefixed "[I hh:mm:ss,mmm] "; the block is a "-------------- Session
// ----------------" line, a "Machines:" line, one "  m#N(id): ..." row per machine, then a line
// of 39 dashes. NOTE the stamps are uptime-relative, NOT wall-clock (they read ~00:37 while the box
// clock read ~14:55) - nothing may depend on them.
const NL = String.fromCharCode(10);
const CAPTURED_M0_BLOCK = [
  '[I 00:37:03,430] -------------- Session ----------------',
  '[I 00:37:03,430] Machines:',
  '[I 00:37:03,430]   m#0(128): up 0 (0), down 0 (0), remote 0 (0), limit 256, lost 0, ping 0 ms, EstablishingBaseline',
  '[I 00:37:03,430] ---------------------------------------',
].join(NL) + NL;
// Captured while one player was connected (log time 00:10:46 - 00:23:12).
const M1_ROW = '[I 00:11:03,046]   m#1(129): up 92 (114), down 40 (51), remote 92 (114), limit 453, lost 2, ping 45 ms, OperatingNormally';
const CAPTURED_M1_BLOCK = [
  '[I 00:11:03,046] -------------- Session ----------------',
  '[I 00:11:03,046] Machines:',
  '[I 00:11:03,046]   m#0(128): up 0 (0), down 0 (0), remote 0 (0), limit 256, lost 0, ping 0 ms, EstablishingBaseline',
  M1_ROW,
  '[I 00:11:03,046] ---------------------------------------',
].join(NL) + NL;
// Captured context immediately preceding the first idle block after the player left.
const CAPTURED_CONTEXT = [
  '[I 00:23:12,747] [online] Disconnecting peer 0(1)',
  '[I 00:23:12,747] [online] Removed peer 0(1)',
  "[W 00:23:12,752] [session] Remove player from session. Not found in online game info. Player Handle: 0(0) ",
  "[I 00:23:12,752] [SessionPlayer] started transition from 'Remote_InSession' to 'Free' (current='<invalid>')!",
  "[I 00:23:12,752] [SessionPlayer] 'WaitForJoin' (down)!",
  '[I 00:23:12,752] [session] Player removed. Player handle: 0(0)',
  "[I 00:23:12,752] [SessionPlayer] 'Reserve' (down)!",
  "[I 00:23:12,752] [SessionPlayer] finished transition from 'Remote_InSession' to 'Free' (current='Free')!",
].join(NL) + NL;
const FILLER = CAPTURED_CONTEXT;
// Derived (NOT captured): a second/tenth player row made by rewriting the captured row's index.
const rowAs = (n: number) => M1_ROW.replace('m#1(129)', `m#${n}(${128 + n})`);
// Insert extra rows just before the closing dash line (the last line of the block).
const withRows = (block: string, rows: string[]) => {
  const ls = block.split(NL);          // [..., closing, '']
  ls.splice(ls.length - 2, 0, ...rows);
  return ls.join(NL);
};

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const writeTmp = (name: string, body: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; };

const mcount = async (logBody: string) =>
  pyJson('print(json.dumps(p.log_m_count(sys.argv[2])))', [writeTmp(`log-${Math.random()}.log`, logBody)]);

describe('probe-players.py log parser', () => {
  test('python3 is available', () => { expect(PY).toBeDefined(); });

  test('captured block with only m#0 -> mCount 0 (m#0 is not a player)', async () => {
    expect(await mcount(FILLER + CAPTURED_M0_BLOCK)).toBe(0);
  });
  test('captured block with m#0 and m#1 -> mCount 1', async () => {
    expect(await mcount(FILLER + CAPTURED_M1_BLOCK)).toBe(1);
  });
  test('m#0 + m#1 + m#2 -> 2 (a count, not presence)', async () => {
    expect(await mcount(withRows(CAPTURED_M1_BLOCK, [rowAs(2)]))).toBe(2);
  });
  test('m#10 is counted as a single player, not mistaken for m#1 or m#0', async () => {
    expect(await mcount(withRows(CAPTURED_M0_BLOCK, [rowAs(10)]))).toBe(1);
  });
  test('NEWEST block wins by file position: old block had a player, newest has none', async () => {
    expect(await mcount(CAPTURED_M1_BLOCK + FILLER + CAPTURED_M0_BLOCK)).toBe(0);
  });
  test('NEWEST block wins by position even when its timestamp is EARLIER (non-wall-clock stamps)', async () => {
    // Real stamps: M1 block is 00:11:03, M0 block is 00:37:03. Putting the numerically smaller stamp
    // last means an implementation that sorted or compared timestamps would pick the wrong block.
    expect(await mcount(CAPTURED_M0_BLOCK + CAPTURED_M1_BLOCK)).toBe(1);
    expect(await mcount(CAPTURED_M1_BLOCK + CAPTURED_M0_BLOCK)).toBe(0);
  });
  test('no Session block, empty file, or missing file -> null (not 0)', async () => {
    expect(await mcount(FILLER)).toBeNull();
    expect(await mcount('')).toBeNull();
    expect(await pyJson('print(json.dumps(p.log_m_count("/nonexistent/enshrouded_server.log")))')).toBeNull();
  });
  test('only the tail is read: a huge file with the block at the end still parses', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024) + '\n' + CAPTURED_M1_BLOCK;
    expect(await mcount(big)).toBe(1);
  });
  test('log parser never consults a clock', () => {
    const parser = probeSrc.slice(probeSrc.indexOf('# --------------------------------------------------------------------------- game log'), probeSrc.indexOf('# --------------------------------------------------------------------------- rate maths'));
    expect(parser).not.toMatch(/datetime|strptime|time\.time|date\b/);
  });
  test('captured fixture sanity', () => { expect(CAPTURED_M0_BLOCK).toContain('-------------- Session ----------------'); expect(CAPTURED_M1_BLOCK).toContain('m#1(129)'); });
});

describe('probe-players.py rate maths', () => {
  test('udp rate = delta / seconds', async () => {
    expect(await pyJson('print(json.dumps(p.udp_rate(1000, 3110, 10.0)))')).toBeCloseTo(211, 5);
  });
  test('32-bit wraparound is corrected, never negative', async () => {
    expect(await pyJson('print(json.dumps(p.udp_rate(2**32-50, 150, 10.0)))')).toBeCloseTo(20, 5);
  });
  test('64-bit wraparound is corrected', async () => {
    expect(await pyJson('print(json.dumps(p.udp_rate(2**64-100, 100, 10.0)))')).toBeCloseTo(20, 5);
  });
  test('missing sample or zero interval -> null', async () => {
    expect(await pyJson('print(json.dumps([p.udp_rate(None, 5, 10), p.udp_rate(5, None, 10), p.udp_rate(1, 5, 0)]))')).toEqual([null, null, null]);
  });
  test('cpu rate is in cores: 13.6 CPU-seconds in 10 s = 1.36', async () => {
    expect(await pyJson('print(json.dumps(p.cpu_rate(5_000_000, 18_600_000, 10.0)))')).toBeCloseTo(1.36, 6);
  });
  test('cpu counter reset (decrease) -> null, not a wrapped garbage value', async () => {
    expect(await pyJson('print(json.dumps(p.cpu_rate(9_000_000, 1_000_000, 10.0)))')).toBeNull();
  });
  test('snmp and cpu.stat readers parse the real formats', async () => {
    const snmp = writeTmp('snmp', 'Ip: Forwarding\nIp: 1\nUdp: InDatagrams NoPorts InErrors OutDatagrams\nUdp: 12345 6 0 999\n');
    const cpu = writeTmp('cpu.stat', 'usage_usec 777000\nuser_usec 500000\nsystem_usec 277000\n');
    expect(await pyJson('print(json.dumps([p.read_udp_in_datagrams(sys.argv[2]), p.read_cpu_usage_usec(sys.argv[3])]))', [snmp, cpu])).toEqual([12345, 777000]);
    expect(await pyJson('print(json.dumps([p.read_udp_in_datagrams("/nope"), p.read_cpu_usage_usec("/nope")]))')).toEqual([null, null]);
  });
});

describe('probe-players.py A2S leg and end-to-end', () => {
  const HDR = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const QUERY = Buffer.concat([HDR, Buffer.from('TSource Engine Query\0', 'latin1')]);
  const info = (n: number) => Buffer.concat([HDR, Buffer.from("I\x11Dave's Enshrouded Server\x00\x00Enshrouded\x00Enshrouded\x00\x00\x00", 'latin1'), Buffer.from([n, 16, 0]), Buffer.from('dl\x01\x000.0.15.0\x00', 'latin1')]);

  async function serve(behaviour: 'honest1' | 'honest0' | 'silent' | 'noChallengeSupport') {
    const sock = dgram.createSocket('udp4');
    const seen: Buffer[] = [];
    let n = 0;
    sock.on('message', (m, r) => {
      seen.push(m);
      if (behaviour === 'silent') return;
      if (m.length === QUERY.length) {
        const c = Buffer.from([++n, 0xaa, 0xbb, 0xcc]);
        sock.send(Buffer.concat([HDR, Buffer.from('A'), c]), r.port, r.address);
      } else if (behaviour !== 'noChallengeSupport') {
        sock.send(info(behaviour === 'honest1' ? 1 : 0), r.port, r.address);
      }
    });
    await new Promise<void>((res) => sock.bind(0, '127.0.0.1', res));
    return { port: sock.address().port, seen, close: () => new Promise<void>((res) => sock.close(() => res())) };
  }

  test('two-leg handshake returns players; 0 is distinct from failure', async () => {
    const s1 = await serve('honest1');
    expect(await pyJson('print(json.dumps(p.a2s_players("127.0.0.1", int(sys.argv[2]), 2.0)))', [String(s1.port)])).toBe(1);
    expect(s1.seen).toHaveLength(2);
    expect(s1.seen[1].length).toBe(QUERY.length + 4);
    await s1.close();
    const s0 = await serve('honest0');
    expect(await pyJson('print(json.dumps(p.a2s_players("127.0.0.1", int(sys.argv[2]), 2.0)))', [String(s0.port)])).toBe(0);
    await s0.close();
  });
  test('silent server -> null (failure), never 0', async () => {
    const s = await serve('silent');
    expect(await pyJson('print(json.dumps(p.a2s_players("127.0.0.1", int(sys.argv[2]), 0.5)))', [String(s.port)])).toBeNull();
    await s.close();
  });
  test('garbage / truncated replies -> null', async () => {
    const r = await pyJson(`
print(json.dumps([p.parse_a2s_info(b"junk"), p.parse_a2s_info(b"\\xff\\xff\\xff\\xffI\\x11name"), p.parse_a2s_info(b"")]))`);
    expect(r).toEqual([null, null, null]);
  });

  test('probe() with everything broken still returns the failure shape (no throw)', async () => {
    const out = await pyJson(
      'print(json.dumps(p.probe(window=0.2, log_path="/nope", snmp_path="/nope", cpu_path="/nope", a2s_port=1)))');
    expect(out).toEqual({ a2sOk: false, players: null, logOk: false, mCount: null, udpRate: null, cpuRate: null });
  });
  test('probe() with working inputs fills every field', async () => {
    const s = await serve('honest1');
    const log = writeTmp('e2e.log', CAPTURED_M1_BLOCK);
    const snmp = writeTmp('e2e-snmp', 'Udp: InDatagrams NoPorts\nUdp: 10 0\n');
    const cpu = writeTmp('e2e-cpu', 'usage_usec 100\n');
    const out = await pyJson(
      'print(json.dumps(p.probe(window=0.2, log_path=sys.argv[2], snmp_path=sys.argv[3], cpu_path=sys.argv[4], a2s_port=int(sys.argv[5]))))',
      [log, snmp, cpu, String(s.port)]);
    await s.close();
    expect(Object.keys(out)).toEqual(['a2sOk', 'players', 'logOk', 'mCount', 'udpRate', 'cpuRate']);
    expect(out).toMatchObject({ a2sOk: true, players: 1, logOk: true, mCount: 1, udpRate: 0, cpuRate: 0 });
  });
  test('main() prints exactly one JSON line with exactly the six keys, even if probe() raises', async () => {
    const out = await py('def boom(*a, **k): raise RuntimeError("x")\np.probe = boom\np.main()');
    expect(out.split('\n')).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({ a2sOk: false, players: null, logOk: false, mCount: null, udpRate: null, cpuRate: null });
  });
  test('the real script runs in under 15 s and prints one valid JSON line', async () => {
    const t0 = Date.now();
    const out = await new Promise<string>((resolve, reject) =>
      execFile(PY, [PROBE], { timeout: 20000 }, (e, so) => (e ? reject(e) : resolve(so))));
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(Object.keys(JSON.parse(out)).sort()).toEqual(['a2sOk', 'cpuRate', 'logOk', 'mCount', 'players', 'udpRate']);
  }, 30000);
});

describe('probe-players.py guards and delivery', () => {
  test('no fd-count or RSS logic (measured DEAD signals)', () => {
    const code = probeSrc.replace(/"""[\s\S]*?"""/g, '').replace(/#.*$/gm, '');
    expect(code).not.toMatch(/\/proc\/[^"']*\/fd|listdir|VmRSS|\brss\b|memory\.current|memory\.stat|\/status/i);
  });
  test('does not implement the classification rule or A2S_PLAYER', () => {
    const code = probeSrc.replace(/"""[\s\S]*?"""/g, '').replace(/#.*$/gm, '');
    expect(code).not.toMatch(/THRESHOLD|ACTIVE|INDETERMINATE|\\x55|A2S_PLAYER/);
  });
  test('stdlib-only imports', () => {
    const imports = [...probeSrc.matchAll(/^(?:import|from)\s+(\w+)/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['json', 're', 'socket', 'sys', 'time']);
  });
  test('LF only', () => { expect(probeSrc).not.toContain('\r'); });

  const provision = fs.readFileSync(PROVISION, 'utf8');
  const m = /\n[ \t]*write_if_changed (\S+) (\d+) <<'PROBE_EOF'\n([\s\S]*?)\nPROBE_EOF\n/.exec(provision);
  test('provision-host.sh installs probe-players.py as root-owned 0755 helper next to the others', () => {
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('/usr/local/lib/enshrouded/probe-players.py');
    expect(m?.[2]).toBe('0755');
  });
  test('embedded copy is byte-identical to scripts/probe-players.py (no drift)', () => {
    expect(m?.[3] + '\n').toBe(probeSrc);
  });
});
