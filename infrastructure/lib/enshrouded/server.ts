import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { ENSHROUDED_AZ, ENSHROUDED_SUBNET_ID } from './constants';

/**
 * SSM Agent bootstrap for the instance user data (WP-05, ARCHITECTURE 6.1.4). There is no SSH and
 * no key pair, so a missing agent means an unrecoverable host, and provision-host.sh itself
 * arrives over SSM. The user data is therefore DERIVED at synth time from the marked block in
 * scripts/provision-host.sh, so the two copies cannot drift; test/host-scripts.test.ts asserts
 * the equality against the synthesised template.
 */
export const PROVISION_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'provision-host.sh');
export function ssmAgentBootstrapLines(): string[] {
  const text = fs.readFileSync(PROVISION_SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n');
  const m = /^# BEGIN SSM-AGENT-BOOTSTRAP\n([\s\S]*?)\n# END SSM-AGENT-BOOTSTRAP$/m.exec(text);
  if (!m) throw new Error('SSM-AGENT-BOOTSTRAP markers not found in provision-host.sh');
  return m[1].split('\n');
}

/** Canonical's public SSM parameter for the latest Ubuntu 24.04 LTS (amd64, gp3 EBS) AMI. */
export const UBUNTU_2404_AMI_PARAM =
  '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';

/** Enshrouded dedicated-server UDP ports (game + query). */
export const ENSHROUDED_UDP_PORTS = [15636, 15637] as const;

export interface EnshroudedServerProps {
  /** EC2 instance type. Defaults to r6i.large; change here to resize (WP-07). */
  readonly instanceType?: ec2.InstanceType;
  /** Root volume size in GiB. Defaults to 30. */
  readonly rootVolumeSizeGiB?: number;
}

/**
 * Core Enshrouded game server host: security group (UDP 15636/15637 only),
 * SSM-only instance role, Ubuntu 24.04 instance in the default VPC, and an Elastic IP.
 * No key pair and no SSH: admin access is via SSM Session Manager.
 */
export class EnshroudedServer extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly role: iam.Role;
  public readonly instance: ec2.Instance;
  public readonly elasticIp: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: EnshroudedServerProps = {}) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Read-only lookup of the account's default VPC (writes cdk.context.json).
    this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: this.vpc,
      description: 'Enshrouded server: UDP 15636/15637 only',
      allowAllOutbound: true,
    });
    for (const port of ENSHROUDED_UDP_PORTS) {
      this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(port), `Enshrouded UDP ${port}`);
    }

    this.role = new iam.Role(this, 'InstanceRole', {
      roleName: 'enshrouded-server-instance',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    // SSM scoping (ARCHITECTURE §6.6): the box is the most exposed component, so it reads
    // ONLY the server/ prefix and has NO SSM write at all. ARN form is
    // parameter/enshroudedproj/server/... (the path's leading slash is the separator;
    // `parameter//...` silently matches nothing).
    const ssmParamArn = (suffix: string) =>
      `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/enshroudedproj/${suffix}`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [ssmParamArn('server/*'), ssmParamArn('server')],
      }),
    );
    // Explicit Deny on the discord/ prefix: survives any future careless widening of the Allow.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['ssm:GetParameter*'],
        resources: [ssmParamArn('discord/*'), ssmParamArn('discord')],
      }),
    );
    // SecureString reads: decrypt only when the call is made through SSM.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(...ssmAgentBootstrapLines());

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: this.vpc,
      userData,
      // Explicit subnet/AZ pin (ARCHITECTURE §6.3.1): never rely on default subnet selection.
      vpcSubnets: {
        subnets: [
          ec2.Subnet.fromSubnetAttributes(this, 'PinnedSubnet', {
            subnetId: ENSHROUDED_SUBNET_ID,
            availabilityZone: ENSHROUDED_AZ,
          }),
        ],
      },
      instanceType: props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.R6I, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.fromSsmParameter(UBUNTU_2404_AMI_PARAM, {
        os: ec2.OperatingSystemType.LINUX,
      }),
      securityGroup: this.securityGroup,
      role: this.role,
      requireImdsv2: true,
      // keyName deliberately never set: no SSH, admin via SSM Session Manager.
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(props.rootVolumeSizeGiB ?? 30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    this.elasticIp = new ec2.CfnEIP(this, 'ElasticIp', {
      domain: 'vpc',
      instanceId: this.instance.instanceId,
    });
  }
}
