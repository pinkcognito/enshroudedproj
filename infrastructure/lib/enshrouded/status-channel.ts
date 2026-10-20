import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

export interface StatusChannelProps {
  readonly instance: ec2.Instance;
}

/** WP14: observe the server and reconcile configured Discord status channels. */
export class StatusChannel extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: StatusChannelProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const parameter = (suffix: string) => stack.formatArn({
      service: 'ssm', resource: 'parameter', resourceName: `enshroudedproj/${suffix}`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const role = new iam.Role(this, 'Role', {
      roleName: 'enshrouded-status-channel',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParametersByPath'],
      resources: [parameter('discord/status-channels'), parameter('discord/status-channels/*')],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [parameter('discord/bot-token'), parameter('discord/status-channels/*')],
    }));
    // Per §6.6.0: delivery successes are FACTS; retry deadlines are CONTROL state
    // owned exclusively by this reconciler.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [parameter('state/status-channel/*')],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      // WP-26: the only SecureString this role reads is the bot token (everything else is a
      // String read with WithDecryption:false). SSM supplies PARAMETER_ARN (full parameter ARN)
      // as the sole encryption context, so the AWS-managed key's lack of a stable ARN is moot.
      actions: ['kms:Decrypt'], resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `ssm.${stack.region}.amazonaws.com`,
          'kms:EncryptionContext:PARAMETER_ARN': [parameter('discord/bot-token')],
        },
      },
    }));
    // DescribeInstances has no resource-level permission support. Always pass INSTANCE_ID.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));
    this.function = new lambda.Function(this, 'Function', {
      functionName: 'enshrouded-status-channel', role,
      runtime: lambda.Runtime.NODEJS_22_X, memorySize: 256,
      timeout: cdk.Duration.seconds(45), reservedConcurrentExecutions: 1,
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), { exclude: ['**/*.d.ts'] }),
      handler: 'status-channel/index.handler',
      environment: {
        INSTANCE_ID: props.instance.instanceId,
        BOT_TOKEN_PARAM: '/enshroudedproj/discord/bot-token', QUERY_PORT: '15637',
      },
    });
    cdk.Tags.of(this).add('project', 'enshroudedproj');
    cdk.Tags.of(this).add('repo', 'pinkcognito/enshroudedproj');
    new events.Rule(this, 'Schedule', {
      ruleName: 'enshrouded-status-channel-tick',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.function)],
    });
    new events.Rule(this, 'InstanceState', {
      ruleName: 'enshrouded-status-channel-ec2',
      eventPattern: {
        source: ['aws.ec2'], detailType: ['EC2 Instance State-change Notification'],
        detail: {
          'instance-id': [props.instance.instanceId],
          state: ['pending', 'running', 'stopping', 'stopped', 'terminated'],
        },
      },
      targets: [new targets.LambdaFunction(this.function)],
    });
  }
}
