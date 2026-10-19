import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

/** CloudWatch namespace for the custom metrics this Lambda emits. */
export const GRACEFUL_STOP_METRIC_NAMESPACE = 'Enshrouded';

/**
 * Invocation payload for `stopFunction` (WP-10 and the Discord /stop route both use it).
 * Every field is optional and unknown fields are ignored. The Lambda always RETURNS (never
 * throws) a `GracefulStopResult`, and async invocation retries are disabled so a drain can
 * never be re-run automatically.
 */
export interface GracefulStopPayload {
  reason?: 'idle' | 'manual' | string;
  requestedBy?: string;
}

export interface GracefulStopResult {
  outcome: 'stopped' | 'aborted-players-present' | 'aborted-indeterminate' | 'noop-not-running' | 'failed';
  stopped: boolean;
}

export interface GracefulStopProps {
  /** The Enshrouded game server instance. StopInstances is scoped to this ARN only. */
  readonly instance: ec2.Instance;
  /** Optional Discord channel for the "saving and shutting down" notice. Omitted = no post. */
  readonly statusChannelId?: string;
  /** Optional Discord channel for the loud failure message. Omitted = no post. */
  readonly opsChannelId?: string;
}

/**
 * Graceful stop (WP-09, ARCHITECTURE 3.2 steps 10-15). Re-checks players, stops the unit over SSM,
 * verifies the save, syncs to S3, and ONLY THEN calls ec2:StopInstances. Any failure sets
 * maintenance mode and raises an alarm metric instead of stopping the instance.
 */
export class GracefulStop extends Construct {
  /** Invoke with a {@link GracefulStopPayload}. */
  public readonly stopFunction: lambda.IFunction;
  public readonly role: iam.Role;
  /** Raised when save verification (or the drain command) fails. */
  public readonly saveVerificationFailedAlarm: cloudwatch.Alarm;
  /** Raised on ANY graceful-stop failure (verification, S3 sync, StopInstances call). */
  public readonly gracefulStopFailedAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: GracefulStopProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    this.role = new iam.Role(this, 'Role', {
      roleName: 'enshrouded-graceful-stop',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const instanceArn = stack.formatArn({
      service: 'ec2',
      resource: 'instance',
      resourceName: props.instance.instanceId,
    });

    // THE STOP: scoped to OUR instance only. Called by the handler only after save verification
    // and the S3 sync have both succeeded.
    this.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'StopOurInstanceOnly', actions: ['ec2:StopInstances'], resources: [instanceArn] }),
    );
    // DescribeInstances has no resource-level permissions (AWS limitation); read-only.
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));

    // Run the probe / drain scripts: our instance + the AWS-RunShellScript document only.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SendCommandToOurInstance',
        actions: ['ssm:SendCommand'],
        resources: [
          instanceArn,
          stack.formatArn({ service: 'ssm', account: '', resource: 'document', resourceName: 'AWS-RunShellScript' }),
        ],
      }),
    );
    // GetCommandInvocation has no resource-level permissions.
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation'], resources: ['*'] }));

    // SSM namespace (ARCHITECTURE 6.6.2): state/* read+write, discord/* read. NO server/* at all.
    const ssmParamArn = (suffix: string) =>
      `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/enshroudedproj/${suffix}`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [ssmParamArn('discord/*'), ssmParamArn('discord')],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:PutParameter'],
        resources: [ssmParamArn('state/*'), ssmParamArn('state')],
      }),
    );
    // The bot token is a SecureString under the AWS-managed key (no stable ARN); ViaService narrows it.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
      }),
    );
    // PutMetricData has no resource-level permissions; confine it to our namespace.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': GRACEFUL_STOP_METRIC_NAMESPACE } },
      }),
    );

    this.stopFunction = new lambda.Function(this, 'Function', {
      functionName: 'enshrouded-graceful-stop',
      role: this.role,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'graceful-stop/index.handler',
      // Parent lambda/ dir so the zip also carries lambda/shared/.
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), { exclude: ['**/*.d.ts'] }),
      // probe (<=60s) + stop (<=~125s, SSM allows 240s) + sync (<=300s) + polling slack.
      timeout: cdk.Duration.minutes(12),
      // Measured live: 116-121 MB used of the 128 MB default (three SDK clients + fetch). This is the one Lambda
      // whose job is not losing the world; an OOM kill must not be one allocation away.
      memorySize: 256,
      // A drain must never be retried automatically by the async-invoke machinery.
      retryAttempts: 0,
      environment: {
        INSTANCE_ID: props.instance.instanceId,
        BOT_TOKEN_PARAM: '/enshroudedproj/discord/bot-token',
        DISCORD_STATUS_CHANNEL_ID: props.statusChannelId ?? '',
        DISCORD_OPS_CHANNEL_ID: props.opsChannelId ?? '',
      },
    });

    const alarmFor = (id: string, metricName: string, description: string) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: `enshrouded-${metricName}`,
        alarmDescription: description,
        metric: new cloudwatch.Metric({
          namespace: GRACEFUL_STOP_METRIC_NAMESPACE,
          metricName,
          statistic: 'Sum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    this.saveVerificationFailedAlarm = alarmFor(
      'SaveVerificationFailedAlarm',
      'SaveVerificationFailed',
      'Save verification failed during a graceful stop. The instance was NOT stopped and maintenance mode is on. Inspect the world before clearing it.',
    );
    this.gracefulStopFailedAlarm = alarmFor(
      'GracefulStopFailedAlarm',
      'GracefulStopFailed',
      'A graceful stop failed (verification, S3 sync or StopInstances). The instance was NOT stopped by this path and maintenance mode is on.',
    );
  }
}
