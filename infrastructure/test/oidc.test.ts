import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedOidcStack } from '../lib/enshrouded-oidc-stack';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function synth(): Template {
  // Mirror cdk.json: without the pinned qualifier the synthesiser defaults to hnb659fds (UO's toolkit).
  const app = new cdk.App({ context: { '@aws-cdk/core:bootstrapQualifier': 'enshrd1' } });
  const stack = new EnshroudedOidcStack(app, 'EnshroudedOidcStack', {
    stackName: 'EnshroudedOidcStack',
    env: { account: '334953720182', region: 'us-east-2' },
  });
  return Template.fromStack(stack);
}

describe('EnshroudedOidcStack', () => {
  const template = synth();
  const json = JSON.stringify(template.toJSON());

  test('imports the existing OIDC provider, never creates one', () => {
    expect(template.findResources('AWS::IAM::OIDCProvider')).toEqual({});
    expect(json).not.toContain('Custom::AWSCDKOpenIdConnectProvider');
    expect(json).toContain('oidc-provider/token.actions.githubusercontent.com');
  });

  test('every role name starts with enshrouded-', () => {
    const roles = template.findResources('AWS::IAM::Role');
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const r of Object.values(roles)) {
      expect(r.Properties.RoleName).toMatch(/^enshrouded-/);
    }
  });

  // GitHub issues ID-based immutable subjects
  // (repo:<owner>@<owner_id>/<repo>@<repo_id>:<context>) as well as the documented
  // name form, so both spellings are accepted. Either way it must be THIS repo.
  const REPO_BY_NAME = 'pinkcognito/enshroudedproj';
  const REPO_BY_ID = 'pinkcognito@7524041/enshroudedproj@1424007989';

  interface RoleRes { Properties: { AssumeRolePolicyDocument: unknown } }

  function subsOf(role: RoleRes): string[] {
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    return [...trust.matchAll(/"(repo:[^"]+)"/g)].map((m) => m[1]);
  }

  function roleNamed(name: string) {
    const found = template.findResources('AWS::IAM::Role', { Properties: { RoleName: name } });
    const vals = Object.values(found);
    expect(vals.length).toBe(1);
    return vals[0] as unknown as RoleRes;
  }

  test('trust policies reference only this repo (either subject spelling)', () => {
    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    const all: string[] = [];
    for (const r of roles) all.push(...subsOf(r as unknown as RoleRes));
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      const repo = s.replace(/^repo:/, '').replace(/:[^:]*$/, '').replace(/:ref\/.*$/, '');
      const ok = s.startsWith(`repo:${REPO_BY_NAME}:`) || s.startsWith(`repo:${REPO_BY_ID}:`);
      expect(ok).toBe(true);
      expect(repo).not.toContain('*'); // never wildcard the repo itself
    }
  });

  test('deploy role is main-only; diff role may run from any ref', () => {
    // The invariant is "deploy cannot be assumed from anything but main". The old
    // test asserted "no StringLike" as a proxy, which broke the moment two subject
    // spellings had to be ORed. Assert the invariant itself instead.
    const deploySubs = subsOf(roleNamed('enshrouded-github-actions-cdk-deploy'));
    expect(deploySubs.length).toBeGreaterThan(0);
    for (const s of deploySubs) {
      expect(s).not.toContain('*'); // no wildcard anywhere in a deploy subject
      expect(s.endsWith(':ref:refs/heads/main')).toBe(true);
    }
    // Both spellings must be present, or a GitHub format flip locks deploys out.
    expect(deploySubs).toContain(`repo:${REPO_BY_ID}:ref:refs/heads/main`);
    expect(deploySubs).toContain(`repo:${REPO_BY_NAME}:ref:refs/heads/main`);

    const diffSubs = subsOf(roleNamed('enshrouded-github-actions-cdk-diff'));
    expect(diffSubs).toContain(`repo:${REPO_BY_ID}:*`);
    expect(diffSubs).toContain(`repo:${REPO_BY_NAME}:*`);
  });

  test('roles only AssumeRole onto cdk-enshrd1-* bootstrap roles (never hnb659fds)', () => {
    expect(json).not.toContain('hnb659fds');
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    expect(policies.length).toBe(2);
    for (const p of policies) {
      for (const st of p.Properties.PolicyDocument.Statement) {
        expect(st.Action).toBe('sts:AssumeRole');
        const resources = Array.isArray(st.Resource) ? st.Resource : [st.Resource];
        for (const res of resources) expect(JSON.stringify(res)).toMatch(/role\/cdk-enshrd1-[a-z-]+-role-/);
      }
    }
  });

  test('does not create or attach the UO guardrail policy', () => {
    expect(json).not.toContain('EnshroudedUoGuardrail');
    expect(template.findResources('AWS::IAM::ManagedPolicy')).toEqual({});
  });
});

describe('workflows', () => {
  const read = (f: string): string => fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', f), 'utf-8');
  const code = (f: string): string =>
    read(f)
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');

  test.each(['deploy.yml', 'pr-aws-diff.yml'])('%s never uses --all', (f) => {
    expect(code(f)).not.toMatch(/--all\b/);
  });

  test('deploy.yml names stacks explicitly and only runs on main', () => {
    const c = code('deploy.yml');
    expect(c).toMatch(/cdk deploy[^\n]*EnshroudedServerStack/);
    expect(c).toMatch(/branches: \[main\]/);
    expect(c).not.toContain('pull_request');
  });

  // EnshroudedOidcStack defines the very role this workflow authenticates as.
  // If CI redeploys it, a bad change can lock CI out of fixing itself and
  // recovery needs manual admin credentials. It is hand-deployed (RUNBOOK 1.6).
  // This guards the exclusion rather than merely tolerating it.
  test('deploy.yml never deploys or synthesises EnshroudedOidcStack', () => {
    const c = code('deploy.yml');
    const cdkLines = c.split('\n').filter((l) => /\bcdk\s+(deploy|synth)\b/.test(l));
    expect(cdkLines.length).toBeGreaterThan(0);
    for (const line of cdkLines) {
      expect(line).not.toContain('EnshroudedOidcStack');
    }
  });

  test('every uses: is pinned to a full commit SHA', () => {
    for (const f of ['deploy.yml', 'pr-aws-diff.yml']) {
      for (const m of read(f).matchAll(/uses:\s*(\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('pr-aws-diff.yml posts a sticky comment and guards foreign stacks', () => {
    const c = read('pr-aws-diff.yml');
    expect(c).toContain('pull-requests: write');
    expect(c).toContain('enshrouded-cdk-diff');
    expect(c).toContain('check-diff-stacks.py');
  });
});
