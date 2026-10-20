// WP-23: scripts/configure-password-roles.py preview. Runs the real Python (stdlib only).
import * as path from 'path';
import { execFile, spawnSync } from 'child_process';

jest.setTimeout(20000);
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'configure-password-roles.py');
const PY = ['python3', 'python'].find((c) =>
  spawnSync(c, ['-c', 'import sys; sys.exit(0 if sys.version_info[0]==3 else 1)']).status === 0) as string;
const guildId = '123456789012345678';
const id = (n: number) => '5000000000000000' + String(n).padStart(2, '0');
const role = (name: string, n: number, extra: object = {}) => ({ id: id(n), name, ...extra });
const tierRoles = [role('enshroudedadmin', 1), role('enshroudedfriend', 2), role('enshroudedguest', 3)];

function preview(roles: object[]): Promise<{ lines: string[]; command_roles: Record<string, string> }> {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("cfg", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
mapping, cr = m.resolve_roles(json.loads(sys.argv[2]), sys.argv[3])
print(json.dumps({"lines": m.preview_lines(mapping, cr), "command_roles": cr}))`;
  return new Promise((resolve, reject) => execFile(PY, ['-I', '-c', code, SCRIPT, JSON.stringify(roles), guildId],
    (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)))));
}

test('with the action roles absent every action prints DENIED to everyone, never a blank or an admin fallback', async () => {
  const { lines, command_roles } = await preview(tierRoles);
  expect(command_roles).toEqual({});
  for (const action of ['start', 'stop', 'update', 'backup']) {
    expect(lines).toContain(`${action}: DENIED to everyone (enshrouded${action} not found)`);
  }
  expect(lines.join('\n')).not.toMatch(/fall(s)? back|falls back/i);
  for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
});

test('a resolved action role is reported as allowed only to its holders, with no admin implication', async () => {
  const { lines, command_roles } = await preview([...tierRoles, role('enshroudedstart', 9)]);
  expect(command_roles).toEqual({ start: id(9) });
  expect(lines.find((l) => l.startsWith('start:'))).toMatch(/only to holders of enshroudedstart.*not even enshroudedadmin/);
  expect(lines).toContain('stop: DENIED to everyone (enshroudedstop not found)');
});

test('an action role may reuse a tier role; the script notes it rather than rejecting it', async () => {
  const roles = [...tierRoles];
  const { lines } = await preview([...roles, { ...role('enshroudedstop', 1) }].map((r, i) => (i === 3 ? { ...r, id: id(1) } : r)));
  expect(lines.join('\n')).toContain('stop shares its role with tier admin');
});

test('an ambiguous action role name is an error, not a silent pick', async () => {
  await expect(preview([...tierRoles, role('enshroudedstart', 9), role('enshroudedstart', 10)]))
    .rejects.toThrow(/More than one role is named enshroudedstart/);
});
