import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';
import { ssmAgentBootstrapLines } from '../lib/enshrouded/server';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GAME_UNIT = 'systemd/enshrouded.service';
const UPDATE_UNIT = 'systemd/enshrouded-update.service';
const PROVISION = 'scripts/provision-host.sh';
const STOP_PATH = '/usr/local/lib/enshrouded/stop-game.sh';

// ---------------------------------------------------------------------------
// Minimal systemd unit parser: last assignment wins; an empty assignment RESETS the
// directive to systemd's default (i.e. it is as good as absent).
// ---------------------------------------------------------------------------
type Unit = Record<string, Record<string, string[]>>;

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
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (unit[section][key] ??= []).push(value);
  }
  return unit;
}

/** Effective value of a directive: last assignment, or undefined if absent / reset to empty. */
function effective(unit: Unit, section: string, key: string): string | undefined {
  const all = unit[section]?.[key];
  if (!all) return undefined;
  const last = all[all.length - 1];
  return last === '' ? undefined : last;
}

/** systemd time span -> seconds. Bare number = seconds. Returns Infinity for "infinity". */
function parseTimespanSeconds(v: string): number {
  if (v.trim().toLowerCase() === 'infinity') return Infinity;
  const units: Record<string, number> = {
    usec: 1e-6, us: 1e-6, msec: 1e-3, ms: 1e-3,
    seconds: 1, second: 1, sec: 1, s: 1,
    minutes: 60, minute: 60, min: 60, m: 60,
    hours: 3600, hour: 3600, hr: 3600, h: 3600,
  };
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v)) !== null) {
    const unit = m[2].toLowerCase();
    if (unit !== '' && !(unit in units)) return NaN;
    total += parseFloat(m[1]) * (unit === '' ? 1 : units[unit]);
    matched = true;
  }
  return matched ? total : NaN;
}

/** The three data-loss-critical shutdown directives (invariant 1.3, ARCHITECTURE 4.3). */
function shutdownProblems(text: string): string[] {
  const u = parseUnit(text);
  const problems: string[] = [];

  const killSignal = effective(u, 'Service', 'KillSignal');
  if (killSignal !== 'SIGINT') {
    problems.push(`KillSignal must be SIGINT, got ${killSignal ?? '(absent: systemd default SIGTERM)'}`);
  }
  const killMode = effective(u, 'Service', 'KillMode');
  if (killMode !== 'control-group') {
    problems.push(`KillMode must be control-group, got ${killMode ?? '(absent)'}`);
  }
  const tso = effective(u, 'Service', 'TimeoutStopSec');
  if (tso === undefined) {
    problems.push('TimeoutStopSec is absent: systemd default (90s) would apply');
  } else {
    const secs = parseTimespanSeconds(tso);
    if (!(secs >= 120)) problems.push(`TimeoutStopSec must be >= 120s, got "${tso}"`);
    if (!(secs <= 180)) problems.push(`TimeoutStopSec must be <= 180s (AWS force-stops at ~4 min, ARCHITECTURE 4.4), got "${tso}"`);
  }
  if (effective(u, 'Service', 'Restart') !== 'no') {
    problems.push(`Restart must be explicitly "no", got ${effective(u, 'Service', 'Restart') ?? '(absent)'}`);
  }
  const sendSigkill = effective(u, 'Service', 'SendSIGKILL');
  if (sendSigkill !== undefined && sendSigkill !== 'yes') {
    problems.push('SendSIGKILL must stay at its default (a wedged unit blocks the next start, ARCHITECTURE 4.3)');
  }
  // ExecStop is REQUIRED (ARCHITECTURE 4.3.1): it SIGINTs the exe alone and waits, BEFORE
  // KillMode=control-group (which would also hit wineserver) is applied.
  const execStop = effective(u, 'Service', 'ExecStop');
  if (execStop !== STOP_PATH) {
    problems.push(`ExecStop must be ${STOP_PATH}, got ${execStop ?? '(absent)'}`);
  }
  return problems;
}

/** Extract the heredoc body that provision-host.sh embeds for a given unit. */
function embeddedUnit(script: string, name: string): string | undefined {
  const re = new RegExp(
    `# BEGIN UNIT: ${name.replace(/\./g, '\\.')}\\n[^\\n]*<<'UNIT_EOF'\\n([\\s\\S]*?)\\nUNIT_EOF\\n[^\\n]*# END UNIT: ${name.replace(/\./g, '\\.')}`,
  );
  const m = re.exec(script);
  return m ? m[1] + '\n' : undefined;
}

describe('enshrouded.service shutdown directives (invariant 1.3)', () => {
  const unitText = read(GAME_UNIT);

  test('the real unit file has no shutdown problems', () => {
    expect(shutdownProblems(unitText)).toEqual([]);
  });

  test('explicit values', () => {
    const u = parseUnit(unitText);
    expect(effective(u, 'Service', 'KillSignal')).toBe('SIGINT');
    expect(effective(u, 'Service', 'KillMode')).toBe('control-group');
    expect(parseTimespanSeconds(effective(u, 'Service', 'TimeoutStopSec') ?? '')).toBeGreaterThanOrEqual(120);
    expect(effective(u, 'Service', 'Restart')).toBe('no');
    expect(effective(u, 'Service', 'ExecStop')).toBe(STOP_PATH);
    expect(effective(u, 'Service', 'Environment')).toBeDefined();
    expect(u['Service']['Environment']).toContain('WINEDEBUG=-all');
    expect(effective(u, 'Service', 'User')).toBe('enshrouded');
    expect(effective(u, 'Service', 'WorkingDirectory')).toBe('/srv/enshrouded');
  });

  // The checker itself must be sensitive: feed it deliberately broken units.
  const breakUnit = (re: RegExp, repl: string) => unitText.replace(re, repl);
  const cases: Array<[string, string]> = [
    ['KillSignal=SIGTERM', breakUnit(/^KillSignal=.*$/m, 'KillSignal=SIGTERM')],
    ['KillSignal missing', breakUnit(/^KillSignal=.*\n/m, '')],
    ['KillSignal reset to empty', breakUnit(/^KillSignal=.*$/m, 'KillSignal=SIGINT\nKillSignal=')],
    ['KillMode=mixed', breakUnit(/^KillMode=.*$/m, 'KillMode=mixed')],
    ['KillMode=process', breakUnit(/^KillMode=.*$/m, 'KillMode=process')],
    ['KillMode missing', breakUnit(/^KillMode=.*\n/m, '')],
    ['TimeoutStopSec=60', breakUnit(/^TimeoutStopSec=.*$/m, 'TimeoutStopSec=60')],
    ['TimeoutStopSec=119', breakUnit(/^TimeoutStopSec=.*$/m, 'TimeoutStopSec=119')],
    ['TimeoutStopSec=1min', breakUnit(/^TimeoutStopSec=.*$/m, 'TimeoutStopSec=1min')],
    ['TimeoutStopSec=infinity', breakUnit(/^TimeoutStopSec=.*$/m, 'TimeoutStopSec=infinity')],
    ['TimeoutStopSec missing (systemd default 90s)', breakUnit(/^TimeoutStopSec=.*\n/m, '')],
    ['Restart=on-failure', breakUnit(/^Restart=.*$/m, 'Restart=on-failure')],
    ['Restart missing', breakUnit(/^Restart=.*\n/m, '')],
    ['SendSIGKILL=no', breakUnit(/^Restart=no$/m, 'Restart=no\nSendSIGKILL=no')],
    ['ExecStop removed', breakUnit(/^ExecStop=.*\n/m, '')],
    ['ExecStop reset to empty', breakUnit(/^ExecStop=.*$/m, 'ExecStop=/bin/true\nExecStop=')],
    ['ExecStop points elsewhere', breakUnit(/^ExecStop=.*$/m, 'ExecStop=/bin/true')],
  ];
  test.each(cases)('checker rejects: %s', (_name, broken) => {
    expect(shutdownProblems(broken).length).toBeGreaterThan(0);
  });

  test('accepts equivalent spellings of >= 120s', () => {
    for (const v of ['120', '120s', '2min', '2 minutes', '150s', '2min 30s']) {
      expect(shutdownProblems(unitText.replace(/^TimeoutStopSec=.*$/m, `TimeoutStopSec=${v}`))).toEqual([]);
    }
  });
});

describe('unit file content', () => {
  const unit = parseUnit(read(GAME_UNIT));

  test('STEAM_COMPAT_* point at the retained data volume, not the root volume', () => {
    const env = unit['Service']['Environment'].join('\n');
    expect(env).toMatch(/STEAM_COMPAT_DATA_PATH=\/srv\/enshrouded\//);
    expect(env).toMatch(/STEAM_COMPAT_CLIENT_INSTALL_PATH=/);
    for (const v of unit['Service']['Environment'].filter((e) => e.startsWith('STEAM_COMPAT_DATA_PATH'))) {
      expect(v).not.toMatch(/\/(home|root|tmp|var)\b/);
    }
  });

  test('refuses to start without the data volume mounted (nofail must not split the world)', () => {
    expect(effective(unit, 'Unit', 'RequiresMountsFor')).toBe('/srv/enshrouded');
    expect(unit['Service']['ExecStartPre']).toContain('/usr/bin/mountpoint -q /srv/enshrouded');
  });

  test('ExecStart runs the pinned GE-Proton, and its version matches the install script', () => {
    const execStart = effective(unit, 'Service', 'ExecStart') ?? '';
    const ver = /GE_PROTON_VERSION="([^"]+)"/.exec(read(PROVISION))?.[1];
    expect(ver).toBeDefined();
    expect(execStart).toBe(
      `/opt/steamcmd/compatibilitytools.d/GE-Proton${ver}/proton run /srv/enshrouded/enshrouded_server.exe`,
    );
  });

  test('update unit is a oneshot ordered Before=enshrouded.service', () => {
    const upd = parseUnit(read(UPDATE_UNIT));
    expect(effective(upd, 'Service', 'Type')).toBe('oneshot');
    expect(effective(upd, 'Unit', 'Before')).toBe('enshrouded.service');
    expect(effective(unit, 'Unit', 'After')).toContain('enshrouded-update.service');
  });
});

describe('provision-host.sh', () => {
  const script = read(PROVISION);

  test('pins GE-Proton by version AND sha256 (invariant 1.4)', () => {
    expect(script).toMatch(/^GE_PROTON_VERSION="10-26"$/m);
    expect(script).toMatch(/^GE_PROTON_SHA256="e2ffd9d2a1ece30b5da3d3dc9cedaa82875008d1c984b5efc7666c028203f9db"$/m);
    expect(script).toMatch(/\/download\/GE-Proton\$\{GE_PROTON_VERSION\}\//);
    expect(script).not.toMatch(/releases\/latest/);
  });

  test('fails loudly on checksum mismatch and has an S3 mirror fallback', () => {
    expect(script).toMatch(/sha256sum/);
    expect(script).toMatch(/NOT installing an unverified binary/);
    expect(script).toMatch(/ENSHROUDED_MIRROR_S3_URI/);
    expect(script).toMatch(/^set -euo pipefail$/m);
    // extraction must come after verification
    expect(script.indexOf('verify_sha256 "$tarball"')).toBeLessThan(script.indexOf('tar -xzf "$tarball"'));
  });

  test('uses +@sSteamCmdForcePlatformType windows with app 2278520', () => {
    expect(script).toMatch(/\+@sSteamCmdForcePlatformType windows/);
    expect(script).toMatch(/\+app_update 2278520 validate/);
    // the platform flag precedes login/app_update
    expect(script.indexOf('+@sSteamCmdForcePlatformType windows')).toBeLessThan(script.indexOf('+app_update 2278520'));
  });

  test('data volume: never keyed on /dev/sdf, UUID + nofail fstab, formats only when blank', () => {
    expect(script).not.toMatch(/mount[^\n]*\/dev\/sdf/);
    expect(script).toMatch(/UUID=\$\{uuid\} \$\{DATA_MOUNT\} \$\{fstype\} defaults,nofail/);
    expect(script).toMatch(/nvme id-ctrl/);
    expect(script).toMatch(/lsblk -dno SERIAL/);
    const mkfs = script.match(/^\s*mkfs[.\w]*\s.*$/gm) ?? [];
    expect(mkfs).toHaveLength(1);
    expect(mkfs[0]).not.toMatch(/\s-[a-zA-Z]*[Ff]\b/); // no force flag
    // the only mkfs sits in format_if_blank, directly after the blank-device guard
    const fn = /format_if_blank\(\) \{[\s\S]*?\n\}/.exec(script)?.[0] ?? '';
    expect(fn).toContain('mkfs.ext4');
    expect(fn.indexOf('device_is_blank')).toBeGreaterThanOrEqual(0);
    expect(fn.indexOf('device_is_blank')).toBeLessThan(fn.indexOf('mkfs.ext4'));
    // format_if_blank is only reachable when blkid reported "nothing found" (rc 2)
    expect(script).toMatch(/elif \[ "\$rc" -eq 2 \]; then[\s\S]*?format_if_blank/);
    expect(script).not.toMatch(/wipefs\s+(?!--noheadings --no-act)(-a|--all)/);
    expect(script).not.toMatch(/\bdd\b[^\n]*of=\/dev\//);
    expect(script).toMatch(/mountpoint -q "\$DATA_MOUNT"/);
  });

  test('never starts, stops or restarts the game, and never stops/disables ufw/ssm', () => {
    expect(script).not.toMatch(/systemctl\s+(start|stop|restart|reload|kill|try-restart|reload-or-restart)\b[^\n]*enshrouded/);
    expect(script).not.toMatch(/systemctl\s+enable\s+--now[^\n]*enshrouded/);
    expect(script).toMatch(/systemctl enable enshrouded\.service/);
    expect(script).not.toMatch(/ufw\s+(--force\s+)?enable/);
    expect(script).not.toMatch(/ufw\s+--force\s+reset/);
  });

  test('creates the unprivileged user, opens UDP 15636/15637, installs steamcmd and the CW agent', () => {
    expect(script).toMatch(/^GAME_USER="enshrouded"$/m);
    expect(script).toMatch(/useradd --system[^\n]*"\$GAME_USER"/);
    expect(script).toMatch(/ufw allow 15636\/udp/);
    expect(script).toMatch(/ufw allow 15637\/udp/);
    expect(script).toMatch(/steamcmd_linux\.tar\.gz/);
    expect(script).toMatch(/amazon-cloudwatch-agent/);
    expect(script).toMatch(/enshrouded_server\.log/);
    expect(script).not.toMatch(/\b(15636|15637)\/tcp\b/);
  });

  test('embedded unit copies are byte-identical to systemd/*.service (no drift)', () => {
    expect(embeddedUnit(script, 'enshrouded.service')).toBe(read(GAME_UNIT));
    expect(embeddedUnit(script, 'enshrouded-update.service')).toBe(read(UPDATE_UNIT));
  });

  test('the installed (embedded) game unit also passes the shutdown checks', () => {
    const embedded = embeddedUnit(script, 'enshrouded.service');
    expect(embedded).toBeDefined();
    expect(shutdownProblems(embedded as string)).toEqual([]);
  });

  /** Header (path + mode) and body of the stop-game.sh heredoc embedded in provision-host.sh. */
  function embeddedStop(s: string): { header: string; body: string } | undefined {
    const m = /\n[ \t]*write_if_changed (\S+) (\d+) <<'STOP_EOF'\n([\s\S]*?)\nSTOP_EOF\n/.exec(s);
    return m ? { header: `${m[1]} ${m[2]}`, body: m[3] + '\n' } : undefined;
  }
  /** Executable lines only (comments and blanks removed). */
  const code = (s: string) =>
    s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
  const PKILL_OK = /\bpkill -(INT|2|SIGINT) -f "\$PATTERN"/;
  /** Problems with how stop-game.sh signals; empty = signals only the exe pattern. */
  function stopSignalProblems(body: string): string[] {
    const c = code(body);
    const p: string[] = [];
    if (/wine/i.test(c)) p.push('mentions wine (wineserver must never be signalled)');
    if (/\bkill(all)?\b/.test(c)) p.push('uses kill/killall');
    if (/\bpkill\b[^\n]*\b(proton|python)\b/i.test(c)) p.push('signals the launcher by name');
    if (!c.includes(String.raw`PATTERN='[e]nshrouded_server\.exe'`)) p.push('exe pattern/bracket trick missing');
    const pkills = c.match(/^.*\bpkill\b.*$/gm) ?? [];
    if (pkills.length === 0) p.push('no pkill');
    for (const l of pkills) if (!PKILL_OK.test(l)) p.push(`pkill not keyed on $PATTERN with SIGINT: ${l}`);
    return p;
  }

  test('stop-game.sh is installed executable (0755) at the path the unit references', () => {
    const e = embeddedStop(script);
    expect(e).toBeDefined();
    expect(e?.header).toBe(`${STOP_PATH} 0755`);
    expect(e?.body.startsWith('#!/bin/bash\n')).toBe(true);
    expect(effective(parseUnit(read(GAME_UNIT)), 'Service', 'ExecStop')).toBe(STOP_PATH);
  });

  test('stop-game.sh signals ONLY the exe pattern, never wineserver, and waits <=110s', () => {
    const body = embeddedStop(script)?.body ?? '';
    expect(stopSignalProblems(body)).toEqual([]);
    const c = code(body);
    // waits for exit: bounded loop of 110 one-second polls, then fails (systemd then reaps)
    expect(c).toMatch(/seq 1 110/);
    expect(c).toMatch(/pgrep -f "\$PATTERN"/);
    expect(c).toMatch(/sleep 1/);
    expect(c).toMatch(/exit 1\s*$/);
    // idempotent: absent process => exit 0 before any signal is sent
    expect(c.indexOf('exit 0')).toBeGreaterThanOrEqual(0);
    expect(c.indexOf('exit 0')).toBeLessThan(c.indexOf('pkill'));
  });

  test('stop-game.sh passes bash -n and is LF-only (skipped if bash is unavailable)', () => {
    const body = embeddedStop(script)?.body ?? '';
    expect(body).not.toContain('\r');
    const r = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' });
    if (r.error) return;
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('the stop-game.sh checker rejects a wineserver / bare-pkill "simplification"', () => {
    const body = embeddedStop(script)?.body ?? '';
    const pk = (repl: string) => body.replace(/^pkill .*$/m, () => repl);
    for (const bad of [
      pk('pkill -INT -f "$PATTERN"; pkill wineserver'),
      pk('pkill -2'),
      pk('pkill wineserver'),
      pk('pkill -INT -f wineserver'),
      pk('pkill -INT -f "$PATTERN"; pkill -INT -f proton'),
      pk('killall -INT wineserver'),
    ]) {
      expect(stopSignalProblems(bad).length).toBeGreaterThan(0);
    }
  });

  test('update helper carries the platform flag and refuses an unmounted data volume', () => {
    const helper = /<<'UPDATE_EOF'\n([\s\S]*?)\nUPDATE_EOF/.exec(script)?.[1] ?? '';
    expect(helper).toContain('+@sSteamCmdForcePlatformType windows');
    expect(helper).toContain('mountpoint -q /srv/enshrouded');
    expect(helper).toContain('/enshroudedproj/server/auto-update-on-boot');
    expect(helper).not.toMatch(/discord|state\//);
    expect(effective(parseUnit(read(UPDATE_UNIT)), 'Service', 'ExecStart')).toBe('/usr/local/lib/enshrouded/update-game.sh');
  });

  test('no CRLF line endings (would break bash / systemd on the host)', () => {
    for (const f of [PROVISION, GAME_UNIT, UPDATE_UNIT]) expect(read(f)).not.toContain('\r');
  });

  test('passes bash -n (skipped if bash is unavailable)', () => {
    const r = spawnSync('bash', ['-n', path.join(ROOT, PROVISION)], { encoding: 'utf8' });
    if (r.error) return; // no bash on this machine
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('does not mention any UO-project resource', () => {
    for (const f of [PROVISION, GAME_UNIT, UPDATE_UNIT]) {
      expect(read(f)).not.toMatch(/InfrastructureStack|AdminUiStack|GithubOidcStack|i-0d2f683b403536375/);
    }
  });
});

describe('SSM Agent bootstrap: user data == provision-host.sh block (no drift)', () => {
  function synth(): Template {
    const app = new cdk.App();
    cdk.Tags.of(app).add('project', 'enshroudedproj');
    cdk.Tags.of(app).add('repo', 'pinkcognito/enshroudedproj');
    const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
      stackName: 'EnshroudedServerStack',
      env: { account: '123456789012', region: 'us-east-2' },
    });
    return Template.fromStack(stack);
  }
  const template = synth();

  function userDataText(): string {
    const instances = Object.values(template.findResources('AWS::EC2::Instance'));
    expect(instances).toHaveLength(1);
    const ud = (instances[0].Properties as Record<string, unknown>).UserData as { 'Fn::Base64': unknown };
    expect(typeof ud['Fn::Base64']).toBe('string');
    return ud['Fn::Base64'] as string;
  }

  test('synthesised user data contains the script block verbatim', () => {
    const script = read(PROVISION).replace(/\r\n/g, '\n');
    const m = /^# BEGIN SSM-AGENT-BOOTSTRAP\n([\s\S]*?)\n# END SSM-AGENT-BOOTSTRAP$/m.exec(script);
    expect(m).not.toBeNull();
    const block = (m as RegExpExecArray)[1];
    expect(ssmAgentBootstrapLines().join('\n')).toBe(block);
    expect(userDataText()).toBe(`#!/bin/bash\n${block}`);
  });

  test('block installs/starts the snap agent and fails loudly', () => {
    const ud = userDataText();
    expect(ud).toContain('snap list amazon-ssm-agent');
    expect(ud).toContain('snap install amazon-ssm-agent');
    expect(ud).toContain('snap start amazon-ssm-agent');
    expect(ud).toContain('systemctl enable --now "$snap_unit"');
    expect(ud).toContain('snap.amazon-ssm-agent.amazon-ssm-agent.service');
    expect(ud).toMatch(/exit 1/);
  });

  test('still no key pair on the instance', () => {
    for (const inst of Object.values(template.findResources('AWS::EC2::Instance'))) {
      expect(inst.Properties).not.toHaveProperty('KeyName');
    }
  });
});
