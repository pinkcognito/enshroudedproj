/**
 * WP-06: game install, config templating, deploy pipeline.
 *
 * A separate suite (not an extension of host-scripts.test.ts) because that file is the
 * WP-05/05a shutdown-and-provisioning guard whose assertions must stay frozen; WP-06 adds
 * its own scripts, template, workflow and construct, each with distinct failure modes.
 * Bash-driven tests skip themselves when bash / python3 are unavailable (as host-scripts does).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fwd = (p: string) => p.replace(/\\/g, '/');

const DEPLOY = 'scripts/deploy-game-server.sh';
const DRIVER = 'scripts/run-game-deploy.sh';
const PROVISION = 'scripts/provision-host.sh';
const TEMPLATE = 'config/enshrouded_server.json.tmpl';
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'deploy-game-server.yml');

const deploy = read(DEPLOY);
const driver = read(DRIVER);
const updateHelper = /<<'UPDATE_EOF'\n([\s\S]*?)\nUPDATE_EOF/.exec(read(PROVISION))?.[1] ?? '';
const code = (s: string) => s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');

function have(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
const HAVE_BASH = have('bash', ['-c', 'true']);
const HAVE_PY = HAVE_BASH && have('bash', ['-c', 'python3 --version']);
const bashTest = HAVE_BASH ? test : test.skip;
const pyTest = HAVE_PY ? test : test.skip;

function runBash(script: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('static hygiene', () => {
  test('LF only, bash -n clean', () => {
    for (const f of [DEPLOY, DRIVER, TEMPLATE]) expect(read(f)).not.toContain('\r');
    expect(fs.readFileSync(WORKFLOW, 'utf8')).not.toContain('\r');
    expect(updateHelper).not.toContain('\r');
    if (!HAVE_BASH) return;
    for (const f of [DEPLOY, DRIVER, PROVISION]) {
      const r = spawnSync('bash', ['-n', fwd(path.join(ROOT, f))], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
    const r = spawnSync('bash', ['-n'], { input: updateHelper, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('nothing references the UO project', () => {
    const all = [deploy, driver, read(TEMPLATE), fs.readFileSync(WORKFLOW, 'utf8'), read('lib/enshrouded/game-deploy.ts')];
    for (const t of all) expect(t).not.toMatch(/InfrastructureStack|AdminUiStack|GithubOidcStack|i-0d2f683b403536375/);
  });
});

describe('steamcmd invocation (section 7)', () => {
  const fn = /run_steamcmd\(\) \{[\s\S]*?\n\}/.exec(deploy)?.[0] ?? '';

  test('forces the Windows platform and installs app 2278520, platform flag first', () => {
    const c = code(fn);
    expect(c).toContain('+@sSteamCmdForcePlatformType windows');
    expect(c).toMatch(/\+app_update 2278520 validate/);
    expect(c).toContain('+login anonymous');
    expect(c.indexOf('+@sSteamCmdForcePlatformType windows')).toBeLessThan(c.indexOf('+force_install_dir'));
    expect(c.indexOf('+@sSteamCmdForcePlatformType windows')).toBeLessThan(c.indexOf('+app_update'));
  });

  test('the script verifies the exe exists after install (a dropped flag fails loudly)', () => {
    expect(deploy).toMatch(/-f "\$\{INSTALL_DIR\}\/enshrouded_server\.exe"/);
  });
});

const PERMISSION_KEYS = [
  'canKickBan', 'canAccessInventories', 'canEditWorld', 'canEditBase', 'canExtendBase', 'reservedSlots',
] as const;
// section 7.1: canEditWorld per group. Friend=true while canExtendBase=false is intentional.
// The game enforces canEditBase => canEditWorld and refuses to boot otherwise (verified on the box).
const CAN_EDIT_WORLD: Record<string, boolean> = { Admin: true, Friend: true, Guest: true, Visitor: false };

function expectExplicitPermissions(cfgGroups: Array<Record<string, unknown>>): void {
  for (const g of cfgGroups) {
    const present = PERMISSION_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(g, k));
    expect({ group: g.name, keys: present }).toEqual({ group: g.name, keys: [...PERMISSION_KEYS] });
    // no unknown permission-like key slipped in without being added to PERMISSION_KEYS
    const extra = Object.keys(g).filter((k) => !PERMISSION_KEYS.includes(k as never) && k !== 'name' && k !== 'password');
    expect({ group: g.name, extra }).toEqual({ group: g.name, extra: [] });
    expect(Object.prototype.hasOwnProperty.call(CAN_EDIT_WORLD, String(g.name))).toBe(true);
    expect(g.canEditWorld).toBe(CAN_EDIT_WORLD[String(g.name)]);
  }
}

describe('config template (section 7 schema)', () => {
  const tmpl = JSON.parse(read(TEMPLATE)) as Record<string, unknown>;
  const groups = tmpl.userGroups as Array<Record<string, unknown>>;

  test('passwords live under userGroups[].password, never as a flat top-level key', () => {
    expect(tmpl).not.toHaveProperty('password');
    expect(Array.isArray(groups)).toBe(true);
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.password)).toEqual([
      '${ADMIN_PASSWORD}', '${FRIEND_PASSWORD}', '${GUEST_PASSWORD}', '${VISITOR_PASSWORD}',
    ]);
    // no `"password"` key anywhere outside userGroups
    const outside = JSON.stringify({ ...tmpl, userGroups: undefined });
    expect(outside).not.toMatch(/"password"/i);
  });

  test('sets name/queryPort/slotCount/ip, and does NOT invent a gamePort', () => {
    expect(tmpl).not.toHaveProperty('gamePort');
    expect(tmpl.name).toBe('${SERVER_NAME}');
    expect(tmpl.slotCount).toBe('${SLOT_COUNT}');
    expect(tmpl.queryPort).toBe(15637);
    expect(tmpl.ip).toBe('0.0.0.0');
  });

  test('7.1: every group sets all six permission keys explicitly, canEditWorld per the matrix', () => {
    expect(groups.map((g) => g.name)).toEqual(Object.keys(CAN_EDIT_WORLD));
    for (const g of groups) expect(g).toHaveProperty('canEditWorld');
    expectExplicitPermissions(groups);
  });

  test('7.1: nesting - every group is (canEditWorld, canEditBase) == (true,true) or (false,false)', () => {
    for (const g of groups) {
      expect({ group: g.name, nested: g.canEditWorld === g.canEditBase }).toEqual({ group: g.name, nested: true });
    }
  });

  test('7.2: enableTextChat pinned true; gameSettings/tags/voice keys deliberately absent', () => {
    expect(tmpl).toHaveProperty('enableTextChat');
    expect(tmpl.enableTextChat).toBe(true);
    for (const k of ['gameSettings', 'tags', 'enableVoiceChat', 'voiceChatMode']) {
      expect(tmpl).not.toHaveProperty(k);
    }
  });

  test('no literal secret: every string that looks like a credential is a ${TOKEN}', () => {
    for (const g of groups) expect(String(g.password)).toMatch(/^\$\{[A-Z_]+\}$/);
  });
});

describe('SSM access from on-box code stays inside server/ (section 6.6)', () => {
  const onBox = [
    ['deploy-game-server.sh', code(deploy)],
    ['update-game.sh', code(updateHelper)],
  ] as const;

  test.each(onBox)('%s reads only /enshroudedproj/server', (_n, text) => {
    const paths = text.match(/\/enshroudedproj\/[A-Za-z0-9_\-/]*/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p).toMatch(/^\/enshroudedproj\/server(\/|$)/);
    expect(text).not.toMatch(/discord|\/state\b/);
    expect(text).not.toMatch(/put-parameter|delete-parameter/);
  });

  test('deploy script does not touch maintenance mode (the workflow owns it)', () => {
    expect(deploy.replace(/^\s*#.*$/gm, '')).not.toMatch(/maintenance/i);
  });

  test('group passwords are fetched with one server/ by-path call', () => {
    expect(code(deploy)).toMatch(/get-parameters-by-path[\s\S]*--path "\$SSM_PREFIX"[\s\S]*--recursive[\s\S]*--with-decryption/);
    expect(deploy).toMatch(/^SSM_PREFIX="\/enshroudedproj\/server"$/m);
  });
});

describe('slot count', () => {
  test('hard cap of 16 is enforced in the renderer', () => {
    expect(deploy).toMatch(/MAX_SLOTS = 16/);
    expect(deploy).toMatch(/1 <= int\(vals\["SLOT_COUNT"\]\) <= MAX_SLOTS/);
  });
});

describe('rendering (bash + python3 + stubbed aws)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp06-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const SECRETS = {
    admin: 'ADMINSECRET-s3cr3t"\\q',
    friend: 'FRIENDSECRET-9981',
    guest: 'GUESTSECRET-7742',
    visitor: 'VISITORSECRET-5530',
  };
  function fixture(over: Record<string, string | null> = {}): string {
    const base: Record<string, string> = {
      name: 'Test Realm',
      'slot-count': '12',
      'user-groups/admin-password': SECRETS.admin,
      'user-groups/friend-password': SECRETS.friend,
      'user-groups/guest-password': SECRETS.guest,
      'user-groups/visitor-password': SECRETS.visitor,
    };
    for (const [k, v] of Object.entries(over)) {
      if (v === null) delete base[k];
      else base[k] = v;
    }
    const params = Object.entries(base).map(([k, v]) => ({ Name: `/enshroudedproj/server/${k}`, Value: v }));
    const f = path.join(tmp, `fx-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ Parameters: params }));
    return f;
  }
  function render(over: Record<string, string | null> = {}) {
    const fx = fixture(over);
    const out = path.join(tmp, `out-${Math.random().toString(36).slice(2)}.json`);
    // `aws` is shadowed by a function that records its argv and serves the fixture.
    const r = runBash(
      `P="$PATH"; source "${fwd(path.join(ROOT, DEPLOY))}"; PATH="$P"; ` + // the script pins a Linux PATH
        `aws() { echo "$*" >> "${fwd(tmp)}/aws-argv.log"; cat "${fwd(fx)}"; }; ` +
        `fetch_and_render "${fwd(path.join(ROOT, TEMPLATE))}" "${fwd(out)}"`,
    );
    return { r, out };
  }
  const allSecrets = Object.values(SECRETS);

  pyTest('renders the schema: passwords under userGroups, numeric slotCount, no gamePort', () => {
    const { r, out } = render();
    expect(r.status).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(cfg).not.toHaveProperty('password');
    expect(cfg).not.toHaveProperty('gamePort');
    expect(cfg.name).toBe('Test Realm');
    expect(cfg.slotCount).toBe(12);
    expect(cfg.queryPort).toBe(15637);
    expect(cfg.userGroups.map((g: { password: string }) => g.password)).toEqual(allSecrets);
    expect(JSON.stringify(cfg)).not.toContain('${');
    expect(typeof cfg.slotCount).toBe('number');
    expect(cfg.enableTextChat).toBe(true);
    expect(cfg).not.toHaveProperty('gameSettings');
    expectExplicitPermissions(cfg.userGroups);
  });

  pyTest('no secret value is echoed or logged (success path)', () => {
    const { r } = render();
    for (const s of allSecrets) {
      expect(r.stdout).not.toContain(s);
      expect(r.stderr).not.toContain(s);
    }
    // ...and none reached the aws argv either (values flow only through the pipe)
    const argv = fs.readFileSync(path.join(tmp, 'aws-argv.log'), 'utf8');
    for (const s of allSecrets) expect(argv).not.toContain(s);
    expect(argv).toContain('--path /enshroudedproj/server');
  });

  pyTest('no secret value is echoed on any failure path either', () => {
    const cases: Array<Record<string, string | null>> = [
      { 'slot-count': '17' },
      { 'slot-count': '0' },
      { 'slot-count': 'abc' },
      { 'user-groups/guest-password': null },
      { 'user-groups/admin-password': 'x' },
      { name: '' },
    ];
    for (const c of cases) {
      const { r, out } = render(c);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(out)).toBe(false); // nothing half-written
      for (const s of allSecrets) {
        expect(r.stdout).not.toContain(s);
        expect(r.stderr).not.toContain(s);
      }
    }
  });

  pyTest('slotCount: 16 accepted, 17 rejected', () => {
    expect(render({ 'slot-count': '16' }).r.status).toBe(0);
    expect(render({ 'slot-count': '1' }).r.status).toBe(0);
    expect(render({ 'slot-count': '17' }).r.status).not.toBe(0);
  });

  pyTest('rendered file is created 0600', () => {
    const { out } = render();
    if (process.platform === 'win32') return; // NTFS has no POSIX mode bits
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });
});

describe('maintenance mode is cleared on every exit path (run-game-deploy.sh)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp06drv-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function drive(env: Record<string, string>) {
    const log = path.join(tmp, `calls-${Math.random().toString(36).slice(2)}.log`);
    const stub =
      `aws() { echo "$*" >> "${fwd(log)}"; ` +
      `case "$*" in ` +
      `*put-parameter*"--value false"*) [ -n "\${FAIL_CLEAR:-}" ] && return 1; return 0;; ` +
      `*put-parameter*"--value true"*) [ -n "\${FAIL_SET:-}" ] && return 1; return 0;; ` +
      `*send-command*) [ -n "\${FAIL_SEND:-}" ] && return 1; echo cmd-1;; ` +
      `*"--query Status"*) echo "\${FAKE_STATUS:-Success}";; ` +
      `*) echo output;; esac; }; export -f aws; ` +
      `bash "${fwd(path.join(ROOT, DRIVER))}"`;
    const r = runBash(stub, { ENSHROUDED_INSTANCE_ID: 'i-testtest', POLL_SECONDS: '0', MAX_POLLS: '3', ...env });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    const puts = calls.filter((c) => c.includes('put-parameter'));
    return { r, calls, puts };
  }
  const isTrue = (c: string) => c.includes('--value true');
  const isFalse = (c: string) => c.includes('--value false');

  bashTest('success: set true, deploy, then clear false', () => {
    if (!HAVE_PY) return;
    const { r, puts, calls } = drive({});
    expect({ s: r.status, e: r.stderr }).toEqual({ s: 0, e: '' });
    expect(puts).toHaveLength(2);
    expect(isTrue(puts[0])).toBe(true);
    expect(isFalse(puts[1])).toBe(true);
    expect(puts[0]).toContain('/enshroudedproj/state/maintenance-mode');
    // the deploy ran strictly between the two writes
    const iSet = calls.findIndex(isTrue);
    const iSend = calls.findIndex((c) => c.includes('send-command'));
    const iClear = calls.findIndex(isFalse);
    expect(iSet).toBeLessThan(iSend);
    expect(iSend).toBeLessThan(iClear);
  });

  bashTest('FAILURE: the on-box command fails -> exits non-zero AND maintenance is still cleared', () => {
    if (!HAVE_PY) return;
    const { r, puts } = drive({ FAKE_STATUS: 'Failed' });
    expect(r.status).not.toBe(0);
    expect(puts.some(isTrue)).toBe(true);
    expect(isFalse(puts[puts.length - 1])).toBe(true);
  });

  bashTest('FAILURE: send-command itself errors -> maintenance still cleared', () => {
    if (!HAVE_PY) return;
    const { r, puts } = drive({ FAIL_SEND: '1' });
    expect(r.status).not.toBe(0);
    expect(isFalse(puts[puts.length - 1])).toBe(true);
  });

  bashTest('FAILURE: timed out / cancelled command -> maintenance still cleared', () => {
    if (!HAVE_PY) return;
    for (const status of ['TimedOut', 'Cancelled']) {
      const { r, puts } = drive({ FAKE_STATUS: status });
      expect(r.status).not.toBe(0);
      expect(isFalse(puts[puts.length - 1])).toBe(true);
    }
  });

  bashTest('FAILURE: even if setting maintenance mode errors, the clear is still attempted', () => {
    const { r, puts } = drive({ FAIL_SET: '1' });
    expect(r.status).not.toBe(0);
    expect(isFalse(puts[puts.length - 1])).toBe(true);
  });

  bashTest('a clear that cannot succeed fails the run loudly (never silently leaves it disabled)', () => {
    if (!HAVE_PY) return;
    const { r } = drive({ FAIL_CLEAR: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/could not clear maintenance mode/);
  });

  test('static: EXIT trap is armed before maintenance is set, and only the maintenance param is written', () => {
    const c = code(driver);
    expect(c).toMatch(/trap cleanup EXIT/);
    const iSet = c.indexOf('\nset_maintenance true\n');
    const iTrap = c.indexOf('\ntrap cleanup EXIT\n');
    expect(iSet).toBeGreaterThan(0);
    expect(iTrap).toBeGreaterThan(0);
    expect(iTrap).toBeLessThan(iSet);
    expect(c.indexOf('\nMAINT_SET=1\n')).toBeLessThan(iSet);
    expect(c).toMatch(/set_maintenance false/);
    const puts = c.match(/put-parameter[^\n]*(\n[^\n]*)?/g) ?? [];
    expect(puts).toHaveLength(1); // the single helper
    expect(c).toContain('MAINT_PARAM="/enshroudedproj/state/maintenance-mode"');
  });
});

describe('provisioning runs before the game deploy (run-game-deploy.sh, two SSM commands)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp06prov-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, 'prov.sh'), '#!/bin/bash\necho MARKER-PROVISION-BODY\n');
  fs.writeFileSync(path.join(tmp, 'dep.sh'), '#!/bin/bash\necho MARKER-DEPLOY-BODY\n');

  // The stub records every call and copies each send-command payload file so the test can
  // inspect what each phase actually shipped. Status is selectable per phase.
  function drive(env: Record<string, string>) {
    const id = Math.random().toString(36).slice(2);
    const log = path.join(tmp, `calls-${id}.log`);
    const payloads = path.join(tmp, `payloads-${id}`);
    fs.mkdirSync(payloads);
    const stub =
      `aws() { echo "$*" >> "${fwd(log)}"; ` +
      `case "$*" in ` +
      `*put-parameter*) return 0;; ` +
      `*send-command*) a="$*"; f="\${a#*file://}"; f="\${f%% *}"; ` +
      `case "$*" in *"game provisioning"*) n=prov;; *) n=deploy;; esac; ` +
      `cp "$f" "${fwd(payloads)}/$n.json"; echo "cmd-$n";; ` +
      `*"--command-id cmd-prov"*"--query Status"*) echo "\${PROV_STATUS:-Success}";; ` +
      `*"--command-id cmd-deploy"*"--query Status"*) echo "\${DEPLOY_STATUS:-Success}";; ` +
      `*) echo output;; esac; }; export -f aws; ` +
      `bash "${fwd(path.join(ROOT, DRIVER))}"`;
    const r = runBash(stub, {
      ENSHROUDED_INSTANCE_ID: 'i-testtest', POLL_SECONDS: '0', MAX_POLLS: '3',
      PROVISION_SCRIPT: fwd(path.join(tmp, 'prov.sh')), DEPLOY_SCRIPT: fwd(path.join(tmp, 'dep.sh')),
      ...env,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    const payload = (n: string): string | undefined => {
      const f = path.join(payloads, `${n}.json`);
      return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as { commands: string[] }).commands[0] : undefined;
    };
    const timeout = (n: string): string[] | undefined => {
      const f = path.join(payloads, `${n}.json`);
      return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as { executionTimeout: string[] }).executionTimeout : undefined;
    };
    return { r, calls, prov: payload('prov'), dep: payload('deploy'), timeouts: { prov: timeout('prov'), deploy: timeout('deploy') } };
  }
  const sends = (calls: string[]) => calls.filter((c) => c.includes('send-command'));
  const lastPut = (calls: string[]) => calls.filter((c) => c.includes('put-parameter')).pop() ?? '';

  bashTest('ORDER: provision-host.sh is sent first, deploy-game-server.sh second, inside the maintenance window', () => {
    if (!HAVE_PY) return;
    const { r, calls, prov, dep } = drive({});
    expect({ s: r.status, e: r.stderr }).toEqual({ s: 0, e: '' });
    const s = sends(calls);
    expect(s).toHaveLength(2);
    expect(s[0]).toContain('game provisioning');
    expect(s[1]).toContain('game deploy');
    expect(prov).toContain('MARKER-PROVISION-BODY');
    expect(prov).not.toContain('MARKER-DEPLOY-BODY');
    expect(dep).toContain('MARKER-DEPLOY-BODY');
    expect(dep).not.toContain('MARKER-PROVISION-BODY');
    const iSet = calls.findIndex((c) => c.includes('--value true'));
    const iProv = calls.findIndex((c) => c.includes('send-command') && c.includes('game provisioning'));
    const iDep = calls.findIndex((c) => c.includes('send-command') && c.includes('game deploy'));
    const iClear = calls.findIndex((c) => c.includes('--value false'));
    expect(iSet).toBeLessThan(iProv);
    expect(iProv).toBeLessThan(iDep);
    expect(iDep).toBeLessThan(iClear);
    // provisioning must have FINISHED (its status polled) before the deploy was sent
    const iProvPoll = calls.findIndex((c) => c.includes('--command-id cmd-prov') && c.includes('--query Status'));
    expect(iProvPoll).toBeGreaterThan(iProv);
    expect(iProvPoll).toBeLessThan(iDep);
    expect(r.stdout).toContain('phase: provisioning');
    expect(r.stdout).toContain('phase: game deploy');
  });

  bashTest('provisioning FAILS: the game deploy is never sent, clear-on-exit still runs, phase is named', () => {
    if (!HAVE_PY) return;
    for (const status of ['Failed', 'TimedOut', 'Cancelled']) {
      const { r, calls, dep } = drive({ PROV_STATUS: status });
      expect(r.status).not.toBe(0);
      expect(sends(calls)).toHaveLength(1);
      expect(sends(calls)[0]).toContain('game provisioning');
      expect(dep).toBeUndefined();
      expect(calls.some((c) => c.includes('cmd-deploy'))).toBe(false);
      expect(r.stderr).toMatch(/provisioning phase FAILED/);
      expect(r.stderr).toMatch(/game deploy phase was NOT attempted/);
      expect(lastPut(calls)).toContain('--value false');
    }
  });

  bashTest('deploy FAILS after good provisioning: names the deploy phase, maintenance still cleared', () => {
    if (!HAVE_PY) return;
    const { r, calls } = drive({ DEPLOY_STATUS: 'Failed' });
    expect(r.status).not.toBe(0);
    expect(sends(calls)).toHaveLength(2);
    expect(r.stderr).toMatch(/game deploy phase FAILED/);
    expect(r.stderr).not.toMatch(/provisioning phase FAILED/);
    expect(lastPut(calls)).toContain('--value false');
  });

  bashTest('the config template (ENSHROUDED_CONFIG_TEMPLATE_B64) is bundled with the deploy phase ONLY', () => {
    if (!HAVE_PY) return;
    const { prov, dep } = drive({});
    expect(dep).toMatch(/^#!\/bin\/bash\nexport ENSHROUDED_CONFIG_TEMPLATE_B64='[A-Za-z0-9+/=]+'\n/);
    expect(prov).toBeDefined();
    expect(prov).not.toContain('ENSHROUDED_CONFIG_TEMPLATE_B64');
    expect(prov?.startsWith('#!/bin/bash\n')).toBe(true);
  });

  bashTest('execution timeouts: provisioning 1500s, deploy 3000s', () => {
    if (!HAVE_PY) return;
    const { r, timeouts } = drive({});
    expect(r.status).toBe(0);
    expect(timeouts).toEqual({ prov: ['1500'], deploy: ['3000'] });
  });

  test('static: defaults are the two real on-box scripts; one shared send/poll implementation', () => {
    const c = code(driver);
    expect(c).toContain('provision-host.sh');
    expect(c).toContain('deploy-game-server.sh');
    expect(c.indexOf('run_phase provisioning')).toBeGreaterThan(0);
    expect(c.indexOf('run_phase provisioning')).toBeLessThan(c.indexOf('run_phase "game deploy"'));
    expect(c.match(/send-command/g)).toHaveLength(1);
  });
});

describe('deploy workflow', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');

  test('manual dispatch, OIDC (no stored keys), runs the driver, references no secrets', () => {
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).toMatch(/id-token: write/);
    expect(wf).toContain('infrastructure/scripts/run-game-deploy.sh');
    expect(wf).not.toMatch(/secrets\./);
    expect(wf).not.toMatch(/AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/);
    expect(wf).not.toMatch(/cdk (deploy|bootstrap)/);
    expect(wf).not.toMatch(/set -x|ACTIONS_STEP_DEBUG/);
  });

  test('maintenance mode is not hand-rolled in YAML (the driver script owns it, with a trap)', () => {
    expect(wf).not.toMatch(/put-parameter/);
  });
});

describe('update-game.sh pre-update backup (section 7/8)', () => {
  const c = code(updateHelper);

  test('syncs savegame/ to the backup bucket BEFORE steamcmd runs, and fails closed', () => {
    expect(c).toMatch(/aws s3 sync[^\n]*"\$dir" "s3:\/\/\$\{bucket\}\/savegame\/"/);
    expect(c).not.toMatch(/--delete/);
    const iBackupCall = c.lastIndexOf('backup_savegame\n');
    const iExec = c.indexOf('exec /opt/steamcmd/steamcmd.sh');
    expect(iBackupCall).toBeGreaterThan(c.indexOf('auto-update-on-boot'));
    expect(iBackupCall).toBeLessThan(iExec);
    expect(c).toMatch(/refusing to update/);
    expect(c).toMatch(/\|\| \{ echo "pre-update savegame sync failed[^\n]*return 1; \}/);
  });

  test('bucket name comes from the server/ namespace, and --backup-only is supported', () => {
    expect(c).toContain('/enshroudedproj/server/backup-bucket');
    expect(c).toContain('--backup-only');
  });

  test('keeps the platform flag and app id', () => {
    expect(c).toContain('+@sSteamCmdForcePlatformType windows');
    expect(c).toContain('+app_update 2278520 validate');
  });

  bashTest('behaviour: a failed sync aborts before steamcmd; a good sync proceeds; empty save is a no-op', () => {
    const run = (extra: string, dirHasSave: boolean) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp06up-'));
      if (dirHasSave) fs.writeFileSync(path.join(dir, 'world-index'), 'x');
      // Redirect the fixed paths into the sandbox and stub every external command.
      const body = updateHelper
        .replace(/\/srv\/enshrouded\/savegame/g, fwd(dir))
        .replace(/mountpoint -q \/srv\/enshrouded/, 'true')
        .replace('exec /opt/steamcmd/steamcmd.sh', 'echo STEAMCMD-RAN; exit 0 #')
        .replace(/^\s+\+.*$/gm, '');
      const script =
        `curl() { return 1; }; aws() { ${extra}; }; ` +
        `set -- ; ${body.replace(/^#!.*\n/, '')}`;
      const r = runBash(script);
      fs.rmSync(dir, { recursive: true, force: true });
      return r;
    };
    const ok = run('case "$*" in *get-parameter*) echo my-bucket;; *s3*sync*) echo SYNCED >&2;; esac', true);
    expect(ok.stdout).toContain('STEAMCMD-RAN');
    expect(ok.stderr).toContain('SYNCED');
    const bad = run('case "$*" in *get-parameter*) echo my-bucket;; *s3*sync*) return 1;; esac', true);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).not.toContain('STEAMCMD-RAN');
    const noBucket = run('return 1', true);
    expect(noBucket.status).not.toBe(0);
    expect(noBucket.stdout).not.toContain('STEAMCMD-RAN');
    const empty = run('return 1', false); // aws would fail, but must never be called
    expect(empty.stderr + empty.stdout).toContain('STEAMCMD-RAN');
  });
});

describe('GameDeploy construct', () => {
  const PROVIDER = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
  function synth(providerArn?: string): Template {
    const app = new cdk.App({ context: providerArn ? { githubOidcProviderArn: providerArn } : {} });
    const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
      stackName: 'EnshroudedServerStack',
      env: { account: '123456789012', region: 'us-east-2' },
    });
    return Template.fromStack(stack);
  }

  test('publishes the backup bucket under server/ (box-readable), never under discord/ or state/', () => {
    const t = synth();
    const params = Object.values(t.findResources('AWS::SSM::Parameter')).map((p) => p.Properties as { Name: string });
    const names = params.map((p) => p.Name);
    expect(names).toContain('/enshroudedproj/server/backup-bucket');
    for (const n of names) expect(n).toMatch(/^\/enshroudedproj\/server\//);
    // no SecureString / secrets ever created by CFN
    expect(names.join()).not.toMatch(/password/);
  });

  test('no deploy role without an OIDC provider ARN', () => {
    const t = synth();
    t.resourceCountIs('AWS::IAM::Role', Object.keys(t.findResources('AWS::IAM::Role')).length);
    expect(Object.values(t.findResources('AWS::IAM::Role')).some((r) => r.Properties.RoleName === 'enshrouded-github-game-deploy')).toBe(false);
  });

  test('deploy role: enshrouded- prefix, main-only OIDC trust, PutParameter on maintenance-mode only', () => {
    const t = synth(PROVIDER);
    const roles = t.findResources('AWS::IAM::Role', { Properties: { RoleName: 'enshrouded-github-game-deploy' } });
    expect(Object.keys(roles)).toHaveLength(1);
    const [id, role] = Object.entries(roles)[0];
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    expect(trust).toContain('repo:pinkcognito/enshroudedproj:ref:refs/heads/main');
    expect(trust).toContain('sts.amazonaws.com');
    expect(trust).toContain(PROVIDER);

    const stmts: Array<{ Action: string | string[]; Resource: unknown; Effect: string }> = [];
    for (const pol of Object.values(t.findResources('AWS::IAM::Policy'))) {
      if ((pol.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === id)) stmts.push(...pol.Properties.PolicyDocument.Statement);
    }
    const acts = (s: { Action: string | string[] }) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
    const puts = stmts.filter((s) => acts(s).includes('ssm:PutParameter'));
    expect(puts).toHaveLength(1);
    expect(acts(puts[0])).toEqual(['ssm:PutParameter']);
    expect(JSON.stringify(puts[0].Resource)).toMatch(/parameter\/enshroudedproj\/state\/maintenance-mode"/);
    for (const s of stmts) {
      for (const a of acts(s)) expect(a).not.toMatch(/^ssm:(Delete|\*$)|^s3:|^ec2:(Run|Terminate|Stop|Start)|^iam:|^\*$/);
    }
    const send = stmts.find((s) => acts(s).includes('ssm:SendCommand'));
    expect(JSON.stringify(send?.Resource)).toContain('document/AWS-RunShellScript');
    expect(JSON.stringify(send?.Resource)).toContain(':instance/');
    // no read of secrets: deploy role never gets GetParameter*
    for (const s of stmts) for (const a of acts(s)) expect(a).not.toMatch(/^ssm:GetParameter/);
  });

  test('the instance role still has no SSM write (6.6.2) with the new construct present', () => {
    const t = synth(PROVIDER);
    const roles = t.findResources('AWS::IAM::Role', { Properties: { RoleName: 'enshrouded-server-instance' } });
    const id = Object.keys(roles)[0];
    for (const pol of Object.values(t.findResources('AWS::IAM::Policy'))) {
      if (!(pol.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === id)) continue;
      expect(JSON.stringify(pol.Properties.PolicyDocument)).not.toMatch(/ssm:Put/);
    }
  });
});

describe('run-game-deploy.sh poll budget', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'run-game-deploy.sh'), 'utf8');

  // A fixed MAX_POLLS silently went stale: DEPLOY_TIMEOUT=3000s against an 1800s
  // window meant a slow deploy would be reported failed while SSM was still running
  // it, and the EXIT trap would clear maintenance mode mid-install. The budget is now
  // derived from the phase timeout, so this asserts the derivation exists rather than
  // re-checking two numbers that can drift apart again.
  test('polls are derived from the phase timeout, not a fixed count', () => {
    expect(src).toMatch(/polls=\$\(\(\s*\(\s*timeout\s*\+\s*POLL_GRACE\s*\)\s*\/\s*\w+\s*\)\)/);
    expect(src).toMatch(/seq 1 "\$polls"/);
    expect(src).not.toMatch(/seq 1 "\$MAX_POLLS"/);
    // The divisor must be guarded: POLL_SECONDS=0 (used by these tests, and by anyone
    // tuning for speed) would otherwise be a division-by-zero at runtime.
    expect(src).toMatch(/_interval=1/);
  });

  test('every declared phase timeout fits inside its derived window', () => {
    // Read the default out of `NAME="${NAME:-123}"` without a heavily escaped regex:
    // find the declaration line, take the digits. Simpler to read, and it survives
    // the quoting style changing.
    const num = (name: string): number => {
      const line = src
        .split('\n')
        .find((l) => l.startsWith(`${name}=`) && l.includes(`${name}:-`));
      if (!line) throw new Error(`${name} declaration not found in run-game-deploy.sh`);
      const digits = line.match(/:-(\d+)\}/);
      if (!digits) throw new Error(`${name} has no numeric default: ${line}`);
      return Number(digits[1]);
    };
    const pollSeconds = num('POLL_SECONDS');
    const grace = num('POLL_GRACE');
    const floor = num('MAX_POLLS');
    for (const t of [num('PROVISION_TIMEOUT'), num('DEPLOY_TIMEOUT')]) {
      const window = Math.max(Math.floor((t + grace) / pollSeconds), floor) * pollSeconds;
      expect(window).toBeGreaterThan(t);
    }
  });
});
