import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';

function synth(): Template {
  const app = new cdk.App();
  // Same tags as bin/enshrouded.ts.
  cdk.Tags.of(app).add('project', 'enshroudedproj');
  cdk.Tags.of(app).add('repo', 'pinkcognito/enshroudedproj');
  // Explicit env so Vpc.fromLookup returns its dummy VPC instead of throwing.
  const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
    stackName: 'EnshroudedServerStack',
    env: { account: '123456789012', region: 'us-east-2' },
  });
  return Template.fromStack(stack);
}

type Rule = Record<string, unknown>;

describe('EnshroudedServer', () => {
  const template = synth();
  const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> =
    template.toJSON().Resources;

  test('security group ingress is exactly UDP 15636 and 15637 from 0.0.0.0/0', () => {
    const inline = Object.values(template.findResources('AWS::EC2::SecurityGroup')).flatMap(
      (sg) => (sg.Properties.SecurityGroupIngress ?? []) as Rule[],
    );
    const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map(
      (r) => r.Properties as Rule,
    );
    const all = [...inline, ...standalone];
    expect(all).toHaveLength(2);
    for (const rule of all) {
      expect(rule.IpProtocol).toBe('udp');
      expect(rule.CidrIp).toBe('0.0.0.0/0');
      expect(rule.FromPort).toBe(rule.ToPort);
    }
    expect(all.map((r) => r.FromPort).sort()).toEqual([15636, 15637]);
  });

  test('no ingress on port 22 or 3389 anywhere, and no TCP ingress', () => {
    const text = JSON.stringify(
      Object.values(resources).filter((r) => r.Type.startsWith('AWS::EC2::SecurityGroup')),
    );
    expect(text).not.toMatch(/"(From|To)Port":(22|3389)\b/);
    expect(text).not.toMatch(/"IpProtocol":"(tcp|-1)"[^}]*"CidrIp":"0\.0\.0\.0\/0"[^}]*"FromPort"/);
    const ingress = Object.values(template.findResources('AWS::EC2::SecurityGroup')).flatMap(
      (sg) => (sg.Properties.SecurityGroupIngress ?? []) as Rule[],
    );
    for (const rule of ingress) {
      expect(rule.IpProtocol).toBe('udp');
    }
  });

  test('instance has no KeyName', () => {
    const instances = template.findResources('AWS::EC2::Instance');
    expect(Object.keys(instances)).toHaveLength(1);
    for (const inst of Object.values(instances)) {
      expect(inst.Properties).not.toHaveProperty('KeyName');
    }
  });

  test('instance is r6i.large with a gp3 root volume and an EIP', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 'r6i.large',
      BlockDeviceMappings: [{ Ebs: { VolumeType: 'gp3' } }],
    });
    template.resourceCountIs('AWS::EC2::EIP', 1);
  });

  test('instance role is enshrouded- prefixed with scoped SSM access', () => {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'enshrouded-server-instance' });
    const text = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(text).toContain('parameter/enshroudedproj/server/*');
    expect(text).toContain('kms:ViaService');
  });

  test('every taggable resource carries both tags', () => {
    const taggableTypes = ['AWS::EC2::SecurityGroup', 'AWS::EC2::Instance', 'AWS::EC2::EIP', 'AWS::IAM::Role'];
    const taggable = Object.entries(resources).filter(([, r]) => taggableTypes.includes(r.Type));
    expect(taggable.length).toBeGreaterThanOrEqual(4);
    for (const [id, r] of taggable) {
      const tags: Record<string, string> = {};
      for (const t of (r.Properties?.Tags ?? []) as { Key: string; Value: string }[]) {
        tags[t.Key] = t.Value;
      }
      expect({ id, project: tags.project, repo: tags.repo }).toEqual({
        id,
        project: 'enshroudedproj',
        repo: 'pinkcognito/enshroudedproj',
      });
    }
  });
});
