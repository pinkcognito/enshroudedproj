/**
 * Shared harness for the WP-22 renderer tests (render-config.test.ts, game-deploy.test.ts).
 *
 * Not a test file (jest only matches *.test.ts). It builds a fake `aws` that behaves like
 * `ssm get-parameters --names ...` really does: requested names that exist come back in
 * Parameters, the rest in InvalidParameters. Faithful to the real API on purpose - the whole point
 * of switching off get-parameters-by-path is that a missing parameter is an explicit fact.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';

export const ROOT = path.join(__dirname, '..');
export const fwd = (p: string) => p.replace(/\\/g, '/');
export const RENDER_SRC = path.join(ROOT, 'scripts', 'render-config.sh');
export const TEMPLATE_SRC = path.join(ROOT, 'config', 'enshrouded_server.json.tmpl');

export const SECRETS = {
  admin: 'ADMINSECRET-s3cr3t"\\q',
  friend: 'FRIENDSECRET-9981',
  guest: 'GUESTSECRET-7742',
  visitor: 'VISITORSECRET-5530',
};
export const allSecrets = Object.values(SECRETS);

export const BASE_PARAMS: Record<string, string> = {
  name: 'Test Realm',
  'slot-count': '12',
  'user-groups/admin-password': SECRETS.admin,
  'user-groups/friend-password': SECRETS.friend,
  'user-groups/guest-password': SECRETS.guest,
  'user-groups/visitor-password': SECRETS.visitor,
};

const STUB = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(" ".join(args) + "\\n")
counter = os.environ["STUB_COUNT"]
n = int(open(counter).read() or "0") if os.path.exists(counter) else 0
open(counter, "w").write(str(n + 1))
if n < int(os.environ.get("STUB_FAIL_FIRST", "0")) or os.environ.get("STUB_ALWAYS_FAIL"):
    sys.stderr.write("An error occurred (ThrottlingException) when calling the GetParameters operation\\n")
    sys.exit(254)
if args[:2] != ["ssm", "get-parameters"]:
    sys.stderr.write("stub aws: unexpected subcommand\\n")
    sys.exit(2)
names = []
if "--names" in args:
    for a in args[args.index("--names") + 1:]:
        if a.startswith("--"):
            break
        names.append(a)
have = json.load(open(os.environ["STUB_FIXTURE"]))
out = {"Parameters": [], "InvalidParameters": []}
for nm in names:
    key = nm.replace("/enshroudedproj/server/", "", 1)
    if key in have:
        out["Parameters"].append({"Name": nm, "Type": "SecureString", "Value": have[key]})
    else:
        out["InvalidParameters"].append(nm)
json.dump(out, sys.stdout)
`;

export interface Harness {
  dir: string;
  renderSh: string; // executable copy of render-config.sh
  stub: string; // fake aws
  templateDest: string; // the canonical on-box template path, redirected into the sandbox
  logFile: string;
  countFile: string;
  /** Write the fixture (suffix -> value); null removes a key. Returns its path. */
  fixture(over?: Record<string, string | null>): string;
  /** Run render-config.sh directly (the boot path) against the fixture. */
  run(out: string, over?: Record<string, string | null>, env?: Record<string, string>): SpawnSyncReturns<string>;
  env(fixturePath: string, extra?: Record<string, string>): Record<string, string>;
  calls(): string[];
  reset(): void;
}

export function makeHarness(dir: string): Harness {
  const renderSh = path.join(dir, 'render-config.sh');
  fs.copyFileSync(RENDER_SRC, renderSh);
  fs.chmodSync(renderSh, 0o755);
  const stub = path.join(dir, 'aws-stub');
  fs.writeFileSync(stub, STUB);
  fs.chmodSync(stub, 0o755);
  const templateDest = path.join(dir, 'onbox.tmpl');
  fs.copyFileSync(TEMPLATE_SRC, templateDest);
  const logFile = path.join(dir, 'aws-argv.log');
  const countFile = path.join(dir, 'aws-count');
  const h: Harness = {
    dir,
    renderSh,
    stub,
    templateDest,
    logFile,
    countFile,
    fixture(over = {}) {
      const base = { ...BASE_PARAMS } as Record<string, string>;
      for (const [k, v] of Object.entries(over)) {
        if (v === null) delete base[k];
        else base[k] = v;
      }
      const f = path.join(dir, `fx-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(f, JSON.stringify(base));
      return f;
    },
    env(fixturePath, extra = {}) {
      return {
        MSYS_NO_PATHCONV: '1', // Git Bash on Windows rewrites /-prefixed argv for native exes; the box is Linux
        ENSHROUDED_AWS_BIN: fwd(stub),
        ENSHROUDED_TEMPLATE: fwd(templateDest),
        ENSHROUDED_RENDER_BACKOFF: '0',
        ENSHROUDED_RENDER_OWNER: '', // no chown in the sandbox (tests may run as root or not)
        STUB_LOG: fwd(logFile),
        STUB_COUNT: fwd(countFile),
        STUB_FIXTURE: fwd(fixturePath),
        ...extra,
      };
    },
    run(out, over = {}, env = {}) {
      return spawnSync('bash', [fwd(renderSh), fwd(out)], {
        encoding: 'utf8',
        env: { ...process.env, ...h.env(h.fixture(over), env) },
      });
    },
    calls() {
      return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
    },
    reset() {
      fs.rmSync(logFile, { force: true });
      fs.rmSync(countFile, { force: true });
    },
  };
  return h;
}
