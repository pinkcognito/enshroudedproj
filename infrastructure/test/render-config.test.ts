/**
 * WP-22: boot-time config render (ARCHITECTURE 7.3, invariant 1.12).
 *
 * Why this suite exists. Passwords used to reach the game only through deploy-game-server.sh, so
 * rotating the SSM parameters would have left the running game on the old ones while
 * `/enshrouded pw` handed out the new ones: credentials that do not work, and no signal anywhere.
 * enshrouded.service now Requires= a oneshot that re-renders the config from SSM on every
 * activation. Each guard below protects a way that guarantee can be lost without anything failing:
 *   - Requires= downgraded to Wants=            -> a failed render no longer blocks the game
 *   - Requires= without After= (or the reverse)  -> no blocking / no ordering
 *   - RemainAfterExit=yes                        -> a manual restart skips the render
 *   - Restart= on the oneshot                    -> looks like retry, gives none (the dependent's job already failed)
 *   - render before steamcmd validate            -> a depot restore clobbers the fresh config
 *   - a second renderer or template path         -> a stale on-box template overwrites a fresh deploy
 *   - a blanket ignore in verify-systemd.sh      -> the check stops catching real unit errors
 * Bash-driven tests skip themselves when bash / python3 are unavailable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { allSecrets, BASE_PARAMS, fwd, makeHarness } from './render-harness';

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GAME_UNIT = 'systemd/enshrouded.service';
const CONFIG_UNIT = 'systemd/enshrouded-config.service';
const RENDER = 'scripts/render-config.sh';
const PROVISION = 'scripts/provision-host.sh';
const TEMPLATE = 'config/enshrouded_server.json.tmpl';
const VERIFY = path.join(REPO, '.github', 'scripts', 'verify-systemd.sh');

function have(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
const HAVE_BASH = have('bash', ['-c', 'true']);
const HAVE_PY = HAVE_BASH && have('bash', ['-c', 'python3 --version']);
const bashTest = HAVE_BASH ? test : test.skip;
const pyTest = HAVE_PY ? test : test.skip;

type Unit = Record<string, Record<string, string[]>>;
/** Comments stripped; every assignment kept (After= may legitimately appear on several lines). */
function parseUnit(text: string): Unit {
  const unit: Unit = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      unit[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0 || !section) continue;
    (unit[section][line.slice(0, eq).trim()] ??= []).push(line.slice(eq + 1).trim());
  }
  return unit;
}
/** All space-separated tokens across every assignment of a directive. */
const tokens = (u: Unit, sec: string, key: string): string[] =>
  (u[sec]?.[key] ?? []).flatMap((v) => v.split(/\s+/).filter(Boolean));

// ---------------------------------------------------------------------------------------------
describe('enshrouded.service depends on enshrouded-config.service (invariant 1.12)', () => {
  const game = parseUnit(read(GAME_UNIT));

  test('Requires= AND After= enshrouded-config.service are present', () => {
    expect(tokens(game, 'Unit', 'Requires')).toContain('enshrouded-config.service');
    expect(tokens(game, 'Unit', 'After')).toContain('enshrouded-config.service');
  });

  test('Wants=enshrouded-config.service is ABSENT - the anti-silent-no-op assertion', () => {
    // Downgrading Requires= to Wants= breaks nothing visibly: a failed dependency "has no impact on
    // the validity of the transaction as a whole" (systemd.unit(5)), so the game just starts on a
    // stale config. This is the one assertion that makes that downgrade fail CI.
    expect(tokens(game, 'Unit', 'Wants')).not.toContain('enshrouded-config.service');
    expect(read(GAME_UNIT)).not.toMatch(/^\s*(Wants|BindsTo|PartOf|Upholds)=[^\n]*enshrouded-config/m);
  });

  test('the pre-existing ordering and dependencies are untouched (contract file, 6.1.3)', () => {
    expect(tokens(game, 'Unit', 'After')).toEqual(expect.arrayContaining(['network-online.target', 'enshrouded-update.service']));
    expect(tokens(game, 'Unit', 'Wants')).toEqual(['network-online.target', 'enshrouded-update.service']);
    expect(game['Service']['ExecStartPre']).toEqual(['/usr/bin/mountpoint -q /srv/enshrouded', '/usr/bin/test -f /srv/enshrouded/enshrouded_server.exe']);
    // the shutdown path (invariant 1.3) is exactly as it was
    expect(game['Service']['KillSignal']).toEqual(['SIGINT']);
    expect(game['Service']['KillMode']).toEqual(['control-group']);
    expect(game['Service']['TimeoutStopSec']).toEqual(['120']);
  });
});

describe('enshrouded-config.service', () => {
  const text = read(CONFIG_UNIT);
  const u = parseUnit(text);

  test('is a oneshot that does NOT remain after exit, so every activation re-renders', () => {
    expect(u['Service']['Type']).toEqual(['oneshot']);
    // "no" is the default, so absent is also correct; "yes" is the bug.
    expect(u['Service']['RemainAfterExit'] ?? ['no']).toEqual(['no']);
    expect(text).not.toMatch(/^\s*RemainAfterExit\s*=\s*(yes|true|1|on)\b/im);
  });

  test('renders AFTER steamcmd validate (enshrouded-update.service), never before', () => {
    expect(tokens(u, 'Unit', 'After')).toEqual(expect.arrayContaining(['enshrouded-update.service', 'network-online.target']));
    expect(tokens(u, 'Unit', 'Before')).not.toContain('enshrouded-update.service');
  });

  test('has no Restart= (it gives a oneshot pulled in by Requires= no in-boot retry; the retry is in the script)', () => {
    expect(u['Service']).not.toHaveProperty('Restart');
    expect(u['Service']).not.toHaveProperty('RestartSec');
    expect(text.replace(/^\s*#.*$/gm, '')).not.toMatch(/Restart/);
  });

  test('runs as root (no User=), needs the data volume mounted, and its timeout covers the retry budget', () => {
    expect(u['Service']).not.toHaveProperty('User');
    expect(u['Service']).not.toHaveProperty('Group');
    expect(u['Unit']['RequiresMountsFor']).toEqual(['/srv/enshrouded']);
    expect(Number(u['Service']['TimeoutStartSec'][0])).toBeGreaterThanOrEqual(120);
  });

  test('ExecStart is the shared renderer writing the live config; the unit is not enabled on its own', () => {
    expect(u['Service']['ExecStart']).toEqual(['/usr/local/lib/enshrouded/render-config.sh /srv/enshrouded/enshrouded_server.json']);
    expect(u).not.toHaveProperty('Install'); // pulled in only by enshrouded.service Requires=
  });

  test('LF only; no UO-project reference', () => {
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/InfrastructureStack|AdminUiStack|GithubOidcStack|i-0d2f683b403536375/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('render-config.sh (static)', () => {
  const raw = read(RENDER);
  const code = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');

  test('LF only, bash shebang, bash -n clean', () => {
    expect(raw).not.toContain('\r');
    expect(raw.startsWith('#!/bin/bash\n')).toBe(true);
    if (!HAVE_BASH) return;
    const r = spawnSync('bash', ['-n', fwd(path.join(ROOT, RENDER))], { encoding: 'utf8' });
    expect({ s: r.status, e: r.stderr }).toEqual({ s: 0, e: '' });
  });

  test('never traces (no set -x / xtrace) and never echoes a value', () => {
    expect(code).not.toMatch(/set\s+-[a-z]*x|xtrace/);
    expect(code).not.toMatch(/echo[^\n]*(\$resp|\$\{resp)/);
    expect(code).not.toMatch(/logger|tee\b|>>/);
  });

  test('the retry is a bounded counter loop, not systemd Restart= and not an unbounded loop', () => {
    expect(code).toMatch(/ATTEMPTS="\$\{ENSHROUDED_RENDER_ATTEMPTS:-5\}"/);
    expect(code).toMatch(/\[ "\$attempt" -ge "\$ATTEMPTS" \]/);
    expect(code).not.toMatch(/while (true|:)\b|until false/);
  });

  test('the hardcoded name list matches the python token map exactly (six names, no dynamic names)', () => {
    const list = (/PARAM_NAMES=\(([\s\S]*?)\n\)/.exec(raw)?.[1] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const mapped = [...raw.matchAll(/^\s+"[A-Z_]+": "([a-z/-]+)",$/gm)].map((m) => `/enshroudedproj/server/${m[1]}`);
    expect(list).toHaveLength(6);
    expect([...list].sort()).toEqual([...mapped].sort());
    expect(code).not.toMatch(/get-parameters-by-path|--recursive/);
  });

  test('provision-host.sh installs a byte-identical copy as a root-owned 0755 helper', () => {
    const m = /\n[ \t]*write_if_changed (\S+) (\d+) <<'RENDER_EOF'\n([\s\S]*?)\nRENDER_EOF\n/.exec(read(PROVISION));
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/usr/local/lib/enshrouded/render-config.sh');
    expect(m![2]).toBe('0755');
    expect(m![3]).toBe(raw.replace(/\n$/, ''));
  });

  test('provision-host.sh installs the checked-in template at the ONE canonical path, 0644', () => {
    const m = /\n[ \t]*write_if_changed (\S+) (\d+) <<'TMPL_EOF'\n([\s\S]*?)\nTMPL_EOF\n/.exec(read(PROVISION));
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/usr/local/lib/enshrouded/enshrouded_server.json.tmpl');
    expect(m![2]).toBe('0644');
    expect(m![3]).toBe(read(TEMPLATE).replace(/\n$/, ''));
    // the same path is the renderer's default and the deploy's destination: one path, three users
    expect(raw).toContain('${ENSHROUDED_TEMPLATE:-/usr/local/lib/enshrouded/enshrouded_server.json.tmpl}');
    expect(read('scripts/deploy-game-server.sh')).toContain('${ENSHROUDED_TEMPLATE_DEST:-/usr/local/lib/enshrouded/enshrouded_server.json.tmpl}');
  });

  test('provision-host.sh embeds the new unit byte-identically and verifies it', () => {
    const m = /# BEGIN UNIT: enshrouded-config\.service\n[^\n]*<<'UNIT_EOF'\n([\s\S]*?)\nUNIT_EOF\n[^\n]*# END UNIT: enshrouded-config\.service/.exec(read(PROVISION));
    expect(m).not.toBeNull();
    expect(m![1]).toBe(read(CONFIG_UNIT).replace(/\n$/, ''));
    expect(read(PROVISION)).toMatch(/systemd-analyze verify[^\n]*\\\n[^\n]*enshrouded-config\.service/);
    // the embedded game unit carries the two new directives too (the existing drift test pins equality)
    const g = /# BEGIN UNIT: enshrouded\.service\n[^\n]*<<'UNIT_EOF'\n([\s\S]*?)\nUNIT_EOF/.exec(read(PROVISION));
    expect(g![1]).toContain('Requires=enshrouded-config.service');
    expect(tokens(parseUnit(g![1]), 'Unit', 'After')).toContain('enshrouded-config.service');
  });
});

// ---------------------------------------------------------------------------------------------
describe('render-config.sh (bash + python3 + faithful get-parameters stub)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp22-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const h = makeHarness(tmp);
  const outPath = () => path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  const leftovers = () => fs.readdirSync(tmp).filter((f) => f.includes('.tmp.')); // the renderer's sibling temp files
  const noSecretsIn = (...texts: string[]) => {
    for (const t of texts) for (const s of allSecrets) expect(t).not.toContain(s);
  };
  beforeEach(() => h.reset());

  pyTest('all four password tokens (plus name and slotCount) are substituted', () => {
    const out = outPath();
    const r = h.run(out);
    expect({ s: r.status, e: r.stderr }).toMatchObject({ s: 0 });
    const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(cfg.userGroups.map((g: { password: string }) => g.password)).toEqual(allSecrets);
    expect(cfg.name).toBe('Test Realm');
    expect(cfg.slotCount).toBe(12);
    expect(JSON.stringify(cfg)).not.toContain('${');
    expect(h.calls()).toHaveLength(1);
  });

  pyTest('reads by name: one get-parameters call naming exactly the six parameters, with decryption', () => {
    h.run(outPath());
    const [call] = h.calls();
    expect(call).toContain('ssm get-parameters ');
    expect(call).toContain('--with-decryption');
    expect(call).not.toContain('by-path');
    for (const k of Object.keys(BASE_PARAMS)) expect(call).toContain(`/enshroudedproj/server/${k}`);
    expect(call.match(/\/enshroudedproj\//g)).toHaveLength(6);
  });

  pyTest.each(Object.keys(BASE_PARAMS))('FAIL CLOSED: parameter %s absent -> non-zero, names it, no file written', (key) => {
    const out = outPath();
    const r = h.run(out, { [key]: null });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`/enshroudedproj/server/${key}`); // InvalidParameters surfaced by name
    expect(fs.existsSync(out)).toBe(false);
    expect(leftovers()).toEqual([]);
    noSecretsIn(r.stdout, r.stderr);
    // a missing parameter is a fact about the data, not a transient error: it is not retried
    expect(h.calls()).toHaveLength(1);
  });

  pyTest.each(Object.keys(BASE_PARAMS))('FAIL CLOSED: parameter %s present but EMPTY -> non-zero, no file written', (key) => {
    const out = outPath();
    const r = h.run(out, { [key]: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`/enshroudedproj/server/${key}`);
    expect(fs.existsSync(out)).toBe(false);
    expect(leftovers()).toEqual([]);
    noSecretsIn(r.stdout, r.stderr);
  });

  pyTest('FAIL CLOSED: a failed re-render leaves the previous config byte-for-byte untouched', () => {
    const out = outPath();
    expect(h.run(out).status).toBe(0);
    const before = fs.readFileSync(out, 'utf8');
    expect(h.run(out, { 'user-groups/admin-password': null }).status).not.toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(before);
  });

  pyTest('rejects a too-short password and an out-of-range slot count', () => {
    const bad: Array<Record<string, string | null>> = [{ 'user-groups/guest-password': 'abc' }, { 'slot-count': '17' }, { 'slot-count': '0' }, { 'slot-count': 'x' }];
    for (const over of bad) {
      const out = outPath();
      const r = h.run(out, over);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(out)).toBe(false);
      noSecretsIn(r.stdout, r.stderr);
    }
  });

  pyTest('RETRY: a transient SSM failure is retried and the render then succeeds', () => {
    const out = outPath();
    const r = h.run(out, {}, { STUB_FAIL_FIRST: '2' });
    expect(r.status).toBe(0);
    expect(h.calls()).toHaveLength(3);
    expect(r.stderr).toMatch(/retrying in/);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).name).toBe('Test Realm');
  });

  pyTest('RETRY IS BOUNDED: persistent failure makes exactly 5 attempts, then exits non-zero (no infinite loop)', () => {
    const out = outPath();
    const r = h.run(out, {}, { STUB_ALWAYS_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(h.calls()).toHaveLength(5);
    expect(r.stderr).toMatch(/after 5 attempts/);
    expect(fs.existsSync(out)).toBe(false);
  });

  pyTest('the attempt count is configurable and still bounded (ENSHROUDED_RENDER_ATTEMPTS=2)', () => {
    const r = h.run(outPath(), {}, { STUB_ALWAYS_FAIL: '1', ENSHROUDED_RENDER_ATTEMPTS: '2' });
    expect(r.status).not.toBe(0);
    expect(h.calls()).toHaveLength(2);
  });

  pyTest('the default backoff budget fits inside TimeoutStartSec', () => {
    // 4 sleeps of base*2^(n-1) = 2+4+8+16 = 30 s, plus 5 calls capped at 12 s = 90 s < 120 s.
    const src = read(RENDER);
    expect(src).toContain('ENSHROUDED_RENDER_BACKOFF:-2');
    expect(src).toContain('ENSHROUDED_RENDER_CALL_TIMEOUT:-12');
    const budget = (2 + 4 + 8 + 16) + 5 * 12;
    expect(budget).toBeLessThan(Number(parseUnit(read(CONFIG_UNIT))['Service']['TimeoutStartSec'][0]));
  });

  pyTest('NO password is echoed, logged or put in argv on success or on any failure path', () => {
    const out = outPath();
    const cases: Array<[Record<string, string | null>, Record<string, string>]> = [
      [{}, {}],
      [{ 'user-groups/friend-password': null }, {}],
      [{ 'slot-count': '99' }, {}],
      [{}, { STUB_ALWAYS_FAIL: '1' }],
    ];
    for (const [over, env] of cases) {
      const r = h.run(out + Math.random(), over, env);
      noSecretsIn(r.stdout, r.stderr);
    }
    noSecretsIn(h.calls().join('\n')); // values never reached the aws argv either
    // ...and the only file in the sandbox that contains a password is a rendered config
    for (const f of fs.readdirSync(tmp)) {
      if (f.startsWith('cfg-') || f.startsWith('fx-') || f === 'aws-stub') continue; // outputs / test fixtures
      const body = fs.readFileSync(path.join(tmp, f), 'utf8');
      noSecretsIn(body);
    }
  });

  pyTest('the rendered file is 0600 and no temp sibling is left behind', () => {
    const out = outPath();
    expect(h.run(out).status).toBe(0);
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(out)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  pyTest('a missing template or an unmounted (absent) output directory fails before touching SSM', () => {
    let r = h.run(outPath(), {}, { ENSHROUDED_TEMPLATE: fwd(path.join(tmp, 'nope.tmpl')) });
    expect(r.status).not.toBe(0);
    r = h.run(path.join(tmp, 'no-such-dir', 'x.json'));
    expect(r.status).not.toBe(0);
    expect(h.calls()).toHaveLength(0);
  });

  pyTest('re-rendering is idempotent: same SSM + same template -> identical bytes', () => {
    const a = outPath();
    const b = outPath();
    expect(h.run(a).status).toBe(0);
    expect(h.run(b).status).toBe(0);
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
  });
});

// ---------------------------------------------------------------------------------------------
describe('verify-systemd.sh filters exactly four missing-binary notices, by exact path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp22v-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const script = fs.readFileSync(VERIFY, 'utf8');
  const NO = 'is not executable: No such file or directory';
  const FOUR = [
    `enshrouded.service: Command /opt/steamcmd/compatibilitytools.d/GE-Proton11-9/proton ${NO}`,
    `enshrouded.service: Command /usr/local/lib/enshrouded/stop-game.sh ${NO}`,
    `enshrouded-update.service: Command /usr/local/lib/enshrouded/update-game.sh ${NO}`,
    `enshrouded-config.service: Command /usr/local/lib/enshrouded/render-config.sh ${NO}`,
  ];

  /** Runs the real script with a fake systemd-analyze that prints `lines` and exits 1, as the real one does. */
  function run(lines: string[]) {
    const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
    fs.writeFileSync(path.join(bin, 'systemd-analyze'), `#!/bin/bash\ncat <<'X'\n${lines.join('\n')}\nX\nexit 1\n`);
    fs.chmodSync(path.join(bin, 'systemd-analyze'), 0o755);
    const r = spawnSync('bash', [fwd(VERIFY), fwd(path.join(ROOT, 'systemd'))], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    return r;
  }

  test('the comment and the success message both say four, not three', () => {
    expect(script).toMatch(/exactly four "Command/);
    expect(script).toMatch(/only the 4 expected missing-binary notices/);
    expect(script).not.toMatch(/exactly three|only the 3 expected/);
    expect(script).toContain('render-config.sh');
  });

  test('the filter is NOT a blanket ignore', () => {
    const expected = /^expected='(.*)'$/m.exec(script)![1];
    expect(expected).not.toMatch(/\.\*/);
    expect(script).toMatch(/exit 1/);
  });

  bashTest('passes with exactly the four expected notices', () => {
    const r = run(FOUR);
    expect({ s: r.status, e: r.stderr }).toEqual({ s: 0, e: '' });
    expect(r.stdout).toContain('only the 4 expected missing-binary notices were filtered');
  });

  bashTest('FAILS on a fifth, unexpected notice (a different binary, or any other message)', () => {
    for (const extra of [
      `enshrouded-config.service: Command /usr/local/bin/something-else.sh ${NO}`,
      `enshrouded-config.service: Command /usr/local/lib/enshrouded/render-config.sh.bak ${NO}`,
      `enshrouded.service: Command /usr/local/lib/enshrouded/render-config.sh ${NO}`, // right path, wrong unit
      'enshrouded-config.service: Unknown key name Restrat in section Service, ignoring.',
      'enshrouded.service: Failed to create unit file: Requires dependency cycle',
    ]) {
      const r = run([...FOUR, extra]);
      expect({ extra, s: r.status }).toEqual({ extra, s: 1 });
      expect(r.stderr).toContain(extra);
    }
  });

  bashTest('a notice for render-config.sh is only tolerated for enshrouded-config.service', () => {
    const r = run([`enshrouded-update.service: Command /usr/local/lib/enshrouded/render-config.sh ${NO}`]);
    expect(r.status).toBe(1);
  });
});
