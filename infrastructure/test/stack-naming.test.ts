import * as cdk from 'aws-cdk-lib/core';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';

// Names owned by the live UO project in the same AWS account. Synthesising
// any of these could let a deploy mutate or destroy the running game server.
const FORBIDDEN = ['InfrastructureStack', 'AdminUiStack', 'GithubOidcStack'];

function synthStackNames(): string[] {
  const app = new cdk.App();
  new EnshroudedServerStack(app, 'EnshroudedServerStack', {
    stackName: 'EnshroudedServerStack',
    // Explicit env lets Vpc.fromLookup return a dummy VPC instead of throwing.
    env: { account: '123456789012', region: 'us-east-2' },
  });
  return app.synth().stacks.map((s) => s.stackName);
}

describe('stack naming', () => {
  const names = synthStackNames();

  test('at least one stack is synthesised', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  test.each(FORBIDDEN)('no stack is named %s', (forbidden) => {
    expect(names).not.toContain(forbidden);
  });

  test('every stack name starts with Enshrouded', () => {
    for (const name of names) {
      expect(name).toMatch(/^Enshrouded/);
    }
  });
});
