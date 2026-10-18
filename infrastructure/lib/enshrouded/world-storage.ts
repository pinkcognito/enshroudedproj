import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ENSHROUDED_AZ } from './constants';

/** Tag used by DLM to select the data volume. */
export const SNAPSHOT_TAG_KEY = 'enshrouded-snapshot';
export const SNAPSHOT_TAG_VALUE = 'world';

/** Device name for the data volume (mounted at /srv/enshrouded by provisioning, WP-05). */
export const DATA_DEVICE_NAME = '/dev/sdf';

export interface WorldStorageProps {
  /** The game server instance the data volume attaches to. */
  readonly instance: ec2.Instance;
  /** The instance role, granted access to the savegame/* prefix only. */
  readonly role: iam.IRole;
  /** Data volume size in GiB. Defaults to 40 (ARCHITECTURE §8). */
  readonly dataVolumeSizeGiB?: number;
}

/**
 * World storage: the one asset that must never be lost (ARCHITECTURE §8).
 * Three layers: retained gp3 data volume, daily DLM snapshots, versioned S3 backups.
 */
export class WorldStorage extends Construct {
  public readonly volume: ec2.Volume;
  public readonly attachment: ec2.CfnVolumeAttachment;
  public readonly bucket: s3.Bucket;
  public readonly snapshotPolicy: dlm.CfnLifecyclePolicy;

  constructor(scope: Construct, id: string, props: WorldStorageProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // Layer 1: retained data volume. AZ comes from the same constant as the instance.
    this.volume = new ec2.Volume(this, 'DataVolume', {
      availabilityZone: ENSHROUDED_AZ,
      size: cdk.Size.gibibytes(props.dataVolumeSizeGiB ?? 40),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Tags.of(this.volume).add(SNAPSHOT_TAG_KEY, SNAPSHOT_TAG_VALUE);

    this.attachment = new ec2.CfnVolumeAttachment(this, 'DataVolumeAttachment', {
      instanceId: props.instance.instanceId,
      volumeId: this.volume.volumeId,
      device: DATA_DEVICE_NAME,
    });

    // Layer 3: S3 object backups (the only AZ-independent layer).
    this.bucket = new s3.Bucket(this, 'WorldBackups', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          noncurrentVersionTransitions: [
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(30) },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(180),
        },
      ],
    });
    // Prefix-scoped: objects under savegame/* only; ListBucket limited to that prefix.
    // (No delete rights: versioned backups should not be erasable by the instance.)
    props.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [this.bucket.arnForObjects('savegame/*')],
      }),
    );
    props.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [this.bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['savegame/*'] } },
      }),
    );

    // Layer 2: daily EBS snapshots via DLM, 7-day retention.
    const dlmRole = new iam.Role(this, 'DlmRole', {
      roleName: 'enshrouded-dlm-snapshots',
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      inlinePolicies: {
        snapshots: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ec2:CreateSnapshot', 'ec2:CreateSnapshots', 'ec2:DeleteSnapshot', 'ec2:DescribeVolumes', 'ec2:DescribeSnapshots'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: ['ec2:CreateTags'],
              resources: [`arn:${stack.partition}:ec2:*::snapshot/*`],
            }),
          ],
        }),
      },
    });
    this.snapshotPolicy = new dlm.CfnLifecyclePolicy(this, 'DailySnapshots', {
      description: 'Enshrouded world volume daily snapshot 7 day retention',
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: SNAPSHOT_TAG_KEY, value: SNAPSHOT_TAG_VALUE }],
        schedules: [
          {
            name: 'daily',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['07:00'] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    });
  }
}
