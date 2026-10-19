/**
 * ARCHITECTURE 8.2: the blank-disk guard - what may format the data volume.
 *
 * A separate suite so existing host-script assertions stay frozen. The control under test is the
 * one that stands between the world and a reformat, so it is exercised by RUNNING the real
 * functions from provision-host.sh against stubbed disk tools, not only by grepping.
 * Bash-driven tests skip themselves when bash / python3 are unavailable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';
import { DATA_VOLUME_ID_PARAM_PATH } from '../lib/enshrouded/world-storage';

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fwd = (p: string) => p.replace(/\\/g, '/');

const PROVISION = read('scripts/provision-host.sh');
const DRIVER = 'scripts/run-game-deploy.sh';
const WORKFLOW = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-game-server.yml'), 'utf8');

const HAVE_BASH = !spawnSync('bash', ['-c', 'true']).error;
const HAVE_PY = HAVE_BASH && spawnSync('bash', ['-c', 'python3 --version']).status === 0;
const bashTest = HAVE_BASH ? test : test.skip;

const fnBody = (name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, 'm').exec(PROVISION);
  if (!m) throw new Error(`function ${name} not found in provision-host.sh`);
  return m[0];
};
const code = (s: string) => s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');

const VOL = 'vol-0142d5163b94a5e53';
const SERIAL = 'vol0142d5163b94a5e53';
const OTHER = 'vol-0aaaaaaaaaaaaaaaa';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blankguard-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Disk {
  serial?: string; // NVMe serial reported by lsblk
  expected?: string | 'FAIL'; // SSM parameter value
  wipefs?: string; // wipefs output (signatures)
  blkidRc?: number; // rc of `blkid -p dev`: 0 = something found, 2 = nothing
  fstype?: string;
  pttype?: string;
  ack?: string; // ENSHROUDED_ALLOW_FIRST_FORMAT
}

/** Runs `call` with the real guard functions and stubbed disk tools. Reports whether mkfs ran. */
function run(call: string, d: Disk, fnOverride: Record<string, string> = {}) {
  const marker = fwd(path.join(tmp, `mkfs-${Math.random().toString(36).slice(2)}`));
  const names = ['device_volume_id', 'read_expected_volume_id', 'verify_volume_identity', 'device_is_blank', 'format_if_blank', 'ensure_filesystem'];
  const fns = names.map((n) => fnOverride[n] ?? fnBody(n)).join('\n');
  const script = `
set -euo pipefail
log()  { echo "[provision-host] $*"; }
die()  { echo "[provision-host] FATAL: $*" >&2; exit 1; }
DATA_VOLUME_ID_PARAM="/enshroudedproj/server/data-volume-id"
ENSHROUDED_ALLOW_FIRST_FORMAT="\${ACK:-}"
lsblk() { echo "\${SERIAL_OUT-}"; }
aws() { if [ "\${EXPECTED_OUT:-}" = FAIL ]; then return 254; fi; echo "\${EXPECTED_OUT-}"; }
wipefs() { echo "\${WIPEFS_OUT-}"; }
blkid() {
  case "$*" in
    *"-s TYPE"*) [ -n "\${FSTYPE-}" ] && { echo "$FSTYPE"; return 0; }; return "\${BLKID_RC:-2}" ;;
    *"-s PTTYPE"*) echo "\${PTTYPE-}"; return 0 ;;
    *) return "\${BLKID_RC:-2}" ;;
  esac
}
mkfs.ext4() { : > "${marker}"; }
udevadm() { :; }
${fns}
${call}
`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SERIAL_OUT: d.serial ?? SERIAL,
      EXPECTED_OUT: d.expected ?? VOL,
      WIPEFS_OUT: d.wipefs ?? '',
      BLKID_RC: String(d.blkidRc ?? 2),
      FSTYPE: d.fstype ?? '',
      PTTYPE: d.pttype ?? '',
      ACK: d.ack ?? '',
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, formatted: fs.existsSync(marker) };
}

describe('device_is_blank: the all-zeros condition is gone and must stay gone (8.2)', () => {
  const body = fnBody('device_is_blank');

  test('regression guard: device_is_blank contains no zeros/first-MiB read', () => {
    const c = code(body);
    expect(c).not.toMatch(/head\s+-c/);
    expect(c).not.toMatch(/\\0|\/dev\/zero|nonzero|1048576|tr\s+-d/);
    expect(c).not.toMatch(/\bdd\b|\bcmp\b|\bxxd\b|\bod\b/);
  });

  test('regression guard: no read of the raw device anywhere in provision-host.sh code', () => {
    expect(code(PROVISION)).not.toMatch(/(head|dd|xxd|od|cmp)\b[^\n]*"\$dev"/);
    expect(code(PROVISION)).not.toMatch(/1048576/);
  });

  test('keeps the three signature checks, and says why zeros must not return', () => {
    expect(body).toMatch(/wipefs --noheadings --no-act/);
    expect(body).toMatch(/blkid -p/);
    expect(body).toMatch(/-ne 2/);
    expect(body).toMatch(/PTTYPE/);
    expect(PROVISION).toMatch(/DO NOT REINSTATE/);
    expect(PROVISION).toMatch(/ENCRYPTED/);
  });

  bashTest('an encrypted-style blank disk (no signatures) IS blank - it used to fail here', () => {
    const r = run('device_is_blank /dev/nvme1n1 && echo BLANK', {});
    expect({ s: r.status, o: r.out.trim() }).toEqual({ s: 0, o: 'BLANK' });
  });

  bashTest('each signature check still refuses', () => {
    expect(run('device_is_blank /dev/x && echo BLANK', { wipefs: '0x438 ext4' }).out).not.toContain('BLANK');
    expect(run('device_is_blank /dev/x && echo BLANK', { blkidRc: 0 }).out).not.toContain('BLANK');
    expect(run('device_is_blank /dev/x && echo BLANK', { pttype: 'gpt' }).out).not.toContain('BLANK');
  });
});

describe('volume-identity verification (8.2 replacement 1)', () => {
  bashTest('a matching volume id is accepted and printed', () => {
    const r = run(`verify_volume_identity /dev/nvme1n1 ${VOL}`, {});
    expect({ s: r.status, o: r.out.trim() }).toEqual({ s: 0, o: VOL });
  });

  bashTest('a volume-id MISMATCH refuses, naming device, both ids and the failed condition', () => {
    const r = run(`verify_volume_identity /dev/nvme1n1 ${OTHER}`, {});
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('/dev/nvme1n1');
    expect(r.err).toContain(`resolved volume id: ${VOL}`);
    expect(r.err).toContain(`expected volume id: ${OTHER}`);
    expect(r.err).toMatch(/failed condition:\s+volume identity/);
  });

  bashTest('a mismatch refuses to FORMAT even if the disk is blank and acknowledged', () => {
    const r = run(
      `v="$(verify_volume_identity /dev/nvme1n1 ${OTHER})" || exit 1; ensure_filesystem /dev/nvme1n1 "$v"`,
      { ack: VOL },
    );
    expect(r.status).not.toBe(0);
    expect(r.formatted).toBe(false);
  });

  bashTest('a non-EBS serial refuses', () => {
    const r = run(`verify_volume_identity /dev/nvme1n1 ${VOL}`, { serial: 'AWS-instance-store-1' });
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/cannot be identified/);
  });

  bashTest('an unreadable or malformed SSM parameter refuses (never guesses)', () => {
    const fail = run('read_expected_volume_id', { expected: 'FAIL' });
    expect(fail.status).not.toBe(0);
    expect(fail.err).toContain('/enshroudedproj/server/data-volume-id');
    const junk = run('read_expected_volume_id', { expected: 'None' });
    expect(junk.status).not.toBe(0);
    expect(junk.err).toMatch(/not a volume id/);
    expect(run('read_expected_volume_id', {}).out.trim()).toBe(VOL);
  });

  test('ensure_data_volume verifies identity before touching the filesystem', () => {
    const fn = fnBody('ensure_data_volume');
    const iRead = fn.indexOf('read_expected_volume_id');
    const iVerify = fn.indexOf('verify_volume_identity');
    const iFs = fn.indexOf('ensure_filesystem');
    expect(iRead).toBeGreaterThanOrEqual(0);
    expect(iRead).toBeLessThan(iVerify);
    expect(iVerify).toBeLessThan(iFs);
  });
});

describe('first-format acknowledgement names the volume (8.2 replacement 2)', () => {
  const fmt = (d: Disk) => run(`ensure_filesystem /dev/nvme1n1 ${VOL}`, d);

  bashTest('unset or empty refuses, and the message gives the exact variable and value', () => {
    for (const ack of [undefined, '']) {
      const r = fmt({ ack });
      expect(r.status).not.toBe(0);
      expect(r.formatted).toBe(false);
      expect(r.err).toContain('/dev/nvme1n1');
      expect(r.err).toContain(`resolved volume id: ${VOL}`);
      expect(r.err).toMatch(/failed condition:\s+ENSHROUDED_ALLOW_FIRST_FORMAT is unset or empty/);
      expect(r.err).toContain(`ENSHROUDED_ALLOW_FIRST_FORMAT=${VOL}`);
    }
  });

  bashTest('a value that does not match the resolved id refuses', () => {
    for (const ack of [OTHER, '1', 'true', 'vol-0142d5163b94a5e5', `${VOL} `]) {
      const r = fmt({ ack });
      expect({ ack, s: r.status, f: r.formatted }).toEqual({ ack, s: 1, f: false });
      expect(r.err).toContain('does not match');
      expect(r.err).toContain(`ENSHROUDED_ALLOW_FIRST_FORMAT=${VOL}`);
    }
  });

  bashTest('a matching value on a blank disk permits the format', () => {
    const r = fmt({ ack: VOL });
    expect({ s: r.status, f: r.formatted }).toEqual({ s: 0, f: true });
  });

  bashTest('a matching acknowledgement does NOT override a signature on the disk', () => {
    for (const d of [{ wipefs: '0x438 ext4' }, { pttype: 'gpt' }]) {
      const r = fmt({ ack: VOL, ...d, ...(d.pttype ? {} : { blkidRc: 2 }) });
      expect(r.status).not.toBe(0);
      expect(r.formatted).toBe(false);
      expect(r.err).toMatch(/failed condition:|partition table/);
    }
  });

  bashTest('an existing filesystem is never formatted and needs NO acknowledgement (replacement / 8.1 restore)', () => {
    for (const fstype of ['ext4', 'xfs']) {
      const r = fmt({ fstype, blkidRc: 0, ack: undefined });
      expect({ fstype, s: r.status, f: r.formatted }).toEqual({ fstype, s: 0, f: false });
      expect(r.out).toContain('will NOT format');
    }
    // ...even with a (matching) acknowledgement lying around
    const r = fmt({ fstype: 'ext4', blkidRc: 0, ack: VOL });
    expect({ s: r.status, f: r.formatted }).toEqual({ s: 0, f: false });
  });

  bashTest('an unexpected filesystem type, or a blkid error, refuses', () => {
    expect(fmt({ fstype: 'ntfs', blkidRc: 0, ack: VOL }).status).not.toBe(0);
    const e = fmt({ blkidRc: 4, ack: VOL });
    expect(e.status).not.toBe(0);
    expect(e.formatted).toBe(false);
  });

  test('the one mkfs is still gated by device_is_blank then the named acknowledgement', () => {
    const fn = fnBody('format_if_blank');
    expect(fn.indexOf('device_is_blank')).toBeLessThan(fn.indexOf('ENSHROUDED_ALLOW_FIRST_FORMAT" != "$vol"'));
    expect(fn.indexOf('ENSHROUDED_ALLOW_FIRST_FORMAT" != "$vol"')).toBeLessThan(fn.indexOf('mkfs.ext4'));
    // it is a comparison to the volume id, never a truthiness test
    expect(code(PROVISION)).not.toMatch(/ENSHROUDED_ALLOW_FIRST_FORMAT:?[-+]?\s*(1|true)\b/);
    expect(code(PROVISION)).not.toMatch(/\[\s+-n\s+"\$ENSHROUDED_ALLOW_FIRST_FORMAT"\s+\]\s*&&[^\n]*mkfs/);
  });
});

describe('run-game-deploy.sh and the workflow (8.2)', () => {
  const driver = read(DRIVER);

  test('the driver never sets or defaults the acknowledgement itself', () => {
    const c = code(driver);
    // The only assignment is the pass-through read, defaulting to empty; the only export is
    // the payload line that echoes an operator-supplied, validated value.
    const lines = c.split('\n').filter((l) => l.includes('ENSHROUDED_ALLOW_FIRST_FORMAT'));
    for (const l of lines) {
      const ok =
        /^FIRST_FORMAT_ACK="\$\{ENSHROUDED_ALLOW_FIRST_FORMAT:-\}"$/.test(l.trim()) ||
        /^echo "export ENSHROUDED_ALLOW_FIRST_FORMAT='\$\{FIRST_FORMAT_ACK\}'"$/.test(l.trim());
      expect({ l, ok }).toEqual({ l, ok: true });
    }
    expect(c).not.toMatch(/^\s*(export\s+)?ENSHROUDED_ALLOW_FIRST_FORMAT=/m);
  });

  test('workflow input exists, is optional, defaults to empty and feeds the driver env', () => {
    expect(WORKFLOW).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+allow_first_format:/);
    const block = /allow_first_format:\n([\s\S]*?)\n\njobs|allow_first_format:\n([\s\S]*?)\n# One deploy/.exec(WORKFLOW)?.[0] ?? '';
    expect(block).toMatch(/required:\s*false/);
    expect(block).toMatch(/default:\s*''/);
    expect(WORKFLOW).toContain('ENSHROUDED_ALLOW_FIRST_FORMAT: ${{ inputs.allow_first_format }}');
    // passed via env, never interpolated into a run: line
    expect(WORKFLOW).not.toMatch(/run:[^\n]*inputs\.allow_first_format/);
  });

  // --- behaviour: drive the real script with a stubbed aws, as game-deploy.test.ts does ---
  const sdir = fs.mkdtempSync(path.join(tmp, 'drv-'));
  fs.writeFileSync(path.join(sdir, 'prov.sh'), '#!/bin/bash\necho MARKER-PROVISION-BODY\n');
  fs.writeFileSync(path.join(sdir, 'dep.sh'), '#!/bin/bash\necho MARKER-DEPLOY-BODY\n');
  function drive(env: Record<string, string>) {
    const id = Math.random().toString(36).slice(2);
    const payloads = path.join(sdir, `p-${id}`);
    fs.mkdirSync(payloads);
    const stub =
      `aws() { case "$*" in ` +
      `*put-parameter*) return 0;; ` +
      `*send-command*) a="$*"; f="\${a#*file://}"; f="\${f%% *}"; ` +
      `case "$*" in *"game provisioning"*) n=prov;; *) n=deploy;; esac; ` +
      `cp "$f" "${fwd(payloads)}/$n.json"; echo "cmd-$n";; ` +
      `*"--query Status"*) echo Success;; *) echo output;; esac; }; export -f aws; ` +
      `bash "${fwd(path.join(ROOT, DRIVER))}"`;
    const base: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete base.ENSHROUDED_ALLOW_FIRST_FORMAT;
    const r = spawnSync('bash', ['-c', stub], {
      encoding: 'utf8',
      env: {
        ...base, ENSHROUDED_INSTANCE_ID: 'i-testtest', POLL_SECONDS: '0', MAX_POLLS: '3',
        PROVISION_SCRIPT: fwd(path.join(sdir, 'prov.sh')), DEPLOY_SCRIPT: fwd(path.join(sdir, 'dep.sh')),
        ...env,
      },
    });
    const get = (n: string): string | undefined => {
      const f = path.join(payloads, `${n}.json`);
      return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as { commands: string[] }).commands[0] : undefined;
    };
    return { r, prov: get('prov'), dep: get('deploy') };
  }
  const pyTest = HAVE_PY ? test : test.skip;

  pyTest('no input: neither phase carries the acknowledgement', () => {
    const { r, prov, dep } = drive({});
    expect(r.status).toBe(0);
    expect(prov).not.toContain('ENSHROUDED_ALLOW_FIRST_FORMAT');
    expect(dep).not.toContain('ENSHROUDED_ALLOW_FIRST_FORMAT');
    const empty = drive({ ENSHROUDED_ALLOW_FIRST_FORMAT: '' });
    expect(empty.prov).not.toContain('ENSHROUDED_ALLOW_FIRST_FORMAT');
  });

  pyTest('input supplied: reaches the provisioning phase ONLY; template stays deploy-only', () => {
    const { r, prov, dep } = drive({ ENSHROUDED_ALLOW_FIRST_FORMAT: VOL });
    expect(r.status).toBe(0);
    expect(prov?.startsWith(`#!/bin/bash\nexport ENSHROUDED_ALLOW_FIRST_FORMAT='${VOL}'\n`)).toBe(true);
    expect(prov).toContain('MARKER-PROVISION-BODY');
    expect(prov).not.toContain('ENSHROUDED_CONFIG_TEMPLATE_B64');
    expect(dep).not.toContain('ENSHROUDED_ALLOW_FIRST_FORMAT');
    expect(dep).toMatch(/^#!\/bin\/bash\nexport ENSHROUDED_CONFIG_TEMPLATE_B64='[A-Za-z0-9+/=]+'\n/);
  });

  pyTest('a value that is not a volume id is rejected before anything is sent (no injection, no "1")', () => {
    for (const bad of ['1', 'true', "vol-1'; rm -rf /; '", 'vol-XYZ']) {
      const { r, prov } = drive({ ENSHROUDED_ALLOW_FIRST_FORMAT: bad });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/allow_first_format must be a volume id/);
      expect(prov).toBeUndefined();
    }
  });
});

describe('WorldStorage publishes the data volume id (8.2)', () => {
  const app = new cdk.App();
  const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
    stackName: 'EnshroudedServerStack',
    env: { account: '123456789012', region: 'us-east-2' },
  });
  const t = Template.fromStack(stack);

  test('/enshroudedproj/server/data-volume-id is a String param referencing the data volume', () => {
    const volId = Object.keys(t.findResources('AWS::EC2::Volume'))[0];
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/enshroudedproj/server/data-volume-id',
      Type: 'String',
      Value: { Ref: volId },
    });
  });

  test('it lives under server/ (the instance role is not widened to read it)', () => {
    expect(DATA_VOLUME_ID_PARAM_PATH.startsWith('/enshroudedproj/server/')).toBe(true);
    expect(PROVISION).toContain(`DATA_VOLUME_ID_PARAM="${DATA_VOLUME_ID_PARAM_PATH}"`);
  });
});
