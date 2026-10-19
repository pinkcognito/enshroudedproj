import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { EnshroudedServer } from '../lib/enshrouded/server';
import { WorldStorage } from '../lib/enshrouded/world-storage';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';
import { ENSHROUDED_AZ, ENSHROUDED_SUBNET_ID } from '../lib/enshrouded/constants';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Res = { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string };

const ENV = { account: '123456789012', region: 'us-east-2' };

/** The real stack, exactly as bin/enshrouded.ts builds it. */
function synthStack(): Template {
  const app = new cdk.App();
  const stack = new EnshroudedServerStack(app, 'EnshroudedServerStack', {
    stackName: 'EnshroudedServerStack',
    env: ENV,
  });
  return Template.fromStack(stack);
}

/** Same wiring as the stack, but with a chosen instance type. */
function synthWithType(instanceType: ec2.InstanceType): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'EnshroudedServerStack', { stackName: 'EnshroudedServerStack', env: ENV });
  const server = new EnshroudedServer(stack, 'Server', { instanceType });
  new WorldStorage(stack, 'WorldStorage', { instance: server.instance, role: server.role });
  return Template.fromStack(stack);
}

const template = synthStack();
const resources = template.toJSON().Resources as Record<string, Res>;
const byType = (t: string) => Object.entries(resources).filter(([, r]) => r.Type === t);

describe('WorldStorage', () => {
  test('data volume is retained on delete and on replace', () => {
    const vols = byType('AWS::EC2::Volume');
    expect(vols).toHaveLength(1);
    expect(vols[0][1].DeletionPolicy).toBe('Retain');
    expect(vols[0][1].UpdateReplacePolicy).toBe('Retain');
    expect(vols[0][1].Properties).toMatchObject({ VolumeType: 'gp3', Encrypted: true, Size: 40 });
  });

  test('volume is attached to the instance', () => {
    template.hasResourceProperties('AWS::EC2::VolumeAttachment', {
      InstanceId: { Ref: byType('AWS::EC2::Instance')[0][0] },
      VolumeId: { Ref: byType('AWS::EC2::Volume')[0][0] },
    });
  });

  test('bucket is versioned, encrypted, private, SSL-only, retained, with lifecycle', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [
          {
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 180 },
            NoncurrentVersionTransitions: [{ StorageClass: 'GLACIER_IR', TransitionInDays: 30 }],
          },
        ],
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ],
      },
    });
    expect(byType('AWS::S3::Bucket')[0][1].DeletionPolicy).toBe('Retain');
  });

  test('volume AZ equals the instance AZ (resolved values) and the pinned subnet', () => {
    const volAz = byType('AWS::EC2::Volume')[0][1].Properties!.AvailabilityZone;
    const inst = byType('AWS::EC2::Instance')[0][1].Properties!;
    expect(typeof volAz).toBe('string');
    expect(typeof inst.AvailabilityZone).toBe('string');
    expect(volAz).toBe(inst.AvailabilityZone);
    expect(volAz).toBe('us-east-2a');
    expect(inst.SubnetId).toBe('subnet-0362ac5390834c32e');
    expect(ENSHROUDED_AZ).toBe('us-east-2a');
    expect(ENSHROUDED_SUBNET_ID).toBe('subnet-0362ac5390834c32e');
  });

  test('S3 grant is scoped to savegame/*, never the whole bucket', () => {
    const bucketId = byType('AWS::S3::Bucket')[0][0];
    const stmts: any[] = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => JSON.stringify(s).includes(bucketId));
    const list = stmts.filter((s) => JSON.stringify(s.Action).includes('ListBucket'));
    const objects = stmts.filter((s) => !JSON.stringify(s.Action).includes('ListBucket'));
    expect(objects).toHaveLength(1);
    const arns = ([] as any[]).concat(objects[0].Resource);
    expect(arns).toHaveLength(1);
    // Resolves to Fn::Join [ "", [ <bucket arn>, "/savegame/*" ] ]; last part is the prefix.
    const parts: any[] = arns[0]['Fn::Join'][1];
    expect(parts[parts.length - 1]).toBe('/savegame/*');
    expect(JSON.stringify(objects[0].Action)).toBe('["s3:GetObject","s3:PutObject"]');
    expect(list).toHaveLength(1);
    expect(list[0].Condition).toEqual({ StringLike: { 's3:prefix': ['savegame/*'] } });
    expect(JSON.stringify(stmts)).not.toMatch(/s3:\*|s3:Delete/);
  });

  test('DLM daily 7-day policy targets the data volume tag', () => {
    template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      State: 'ENABLED',
      PolicyDetails: {
        ResourceTypes: ['VOLUME'],
        TargetTags: [{ Key: 'enshrouded-snapshot', Value: 'world' }],
        Schedules: [
          Match.objectLike({
            CreateRule: Match.objectLike({ Interval: 24, IntervalUnit: 'HOURS' }),
            RetainRule: { Count: 7 },
          }),
        ],
      },
    });
    template.hasResourceProperties('AWS::EC2::Volume', {
      Tags: Match.arrayWith([{ Key: 'enshrouded-snapshot', Value: 'world' }]),
    });
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'enshrouded-dlm-snapshots' });
  });

  test('changing instanceType leaves the volume byte-identical (offline stand-in for cdk diff)', () => {
    const a = synthWithType(ec2.InstanceType.of(ec2.InstanceClass.R6I, ec2.InstanceSize.LARGE));
    const b = synthWithType(ec2.InstanceType.of(ec2.InstanceClass.M6I, ec2.InstanceSize.XLARGE));
    const va = a.findResources('AWS::EC2::Volume');
    const vb = b.findResources('AWS::EC2::Volume');
    expect(Object.keys(va)).toHaveLength(1);
    expect(Object.keys(va)).toEqual(Object.keys(vb)); // same logical id
    expect(JSON.stringify(va)).toBe(JSON.stringify(vb)); // same properties and policies
    // Sanity: the instance type really did differ between the two templates.
    const types = [a, b].map((t) => Object.values(t.findResources('AWS::EC2::Instance'))[0].Properties.InstanceType);
    expect(types).toEqual(['r6i.large', 'm6i.xlarge']);
  });
});
