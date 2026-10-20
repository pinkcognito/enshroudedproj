import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';
import { BOT_TOKEN_PARAM } from './discord-bot';

export interface BootWatcherProps {
  readonly instance: ec2.Instance;
  /** Public Discord application ID used to edit the deferred reply. */
  readonly discordApplicationId?: string;
}

/** Observe boot readiness and deliver the starter's password DM; never control EC2 lifecycle. */
export class BootWatcher extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: BootWatcherProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const ssmParamArn = (suffix: string) =>
      `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/enshroudedproj/${suffix}`;
    const passwordArns = ['admin', 'friend', 'guest', 'visitor'].map((g) =>
      ssmParamArn(`server/user-groups/${g}-password`));
    const botTokenArn = ssmParamArn('discord/bot-token');
    const role = new iam.Role(this, 'Role', {
      roleName: 'enshrouded-boot-watcher',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // These read-only APIs do not support resource-level permissions. The worker passes INSTANCE_ID.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ssm:DescribeInstanceInformation', 'ssm:GetCommandInvocation'],
      resources: ['*'],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [
        stack.formatArn({ service: 'ec2', resource: 'instance', resourceName: props.instance.instanceId }),
        stack.formatArn({ service: 'ssm', account: '', resource: 'document', resourceName: 'AWS-RunShellScript' }),
      ],
    }));
    // Exactly four server/ reads; no server/name or prefix grant. All coordination is read-only.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        ...passwordArns, botTokenArn, ssmParamArn('discord/password-access/*'),
        ssmParamArn('state/password-desync'),
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'], resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': `ssm.${stack.region}.amazonaws.com`,
          'kms:EncryptionContext:PARAMETER_ARN': [botTokenArn, ...passwordArns],
        },
      },
    }));

    this.function = new lambda.Function(this, 'Function', {
      functionName: 'enshrouded-boot-watcher', role,
      runtime: lambda.Runtime.NODEJS_22_X, memorySize: 256,
      // One invocation polls for at most eight minutes, with time left for the failure PATCH.
      timeout: cdk.Duration.seconds(510),
      retryAttempts: 0, maxEventAge: cdk.Duration.minutes(10),
      handler: 'boot-watcher/index.handler',
      // Same parent bundle as the bot, including shared/ and password-access helpers.
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), { exclude: ['**/*.d.ts'] }),
      environment: {
        INSTANCE_ID: props.instance.instanceId,
        DISCORD_APPLICATION_ID: props.discordApplicationId ?? '',
        BOT_TOKEN_PARAM,
      },
    });

    new cloudwatch.Alarm(this, 'BootReadinessFailed', {
      alarmName: 'enshrouded-boot-readiness-failed',
      metric: new cloudwatch.Metric({
        namespace: 'Enshrouded', metricName: 'BootReadinessFailed',
        statistic: 'Sum', period: cdk.Duration.minutes(5),
      }),
      threshold: 1, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
