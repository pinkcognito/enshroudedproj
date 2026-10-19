import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

export interface IdleShutdownProps {
  /** The Enshrouded game server instance to watch. */
  readonly instance: ec2.IInstance;
  /**
   * WP-09 graceful-stop. The ONLY way this construct ever stops the instance; it is invoked
   * with `{ reason: 'idle' }`. This Lambda is deliberately granted no ec2:StopInstances.
   */
  readonly stopFunction: lambda.IFunction;
}

/** 1-minute idle detector (ARCHITECTURE 3.2, 5.6). Decides; never stops anything itself. */
export class IdleShutdown extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: IdleShutdownProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    const role = new iam.Role(this, 'Role', {
      roleName: 'enshrouded-idle-shutdown',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // ARN form: parameter/enshroudedproj/... (the path's leading slash is the separator).
    const param = (suffix: string) =>
      `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/enshroudedproj/${suffix}`;

    this.function = new lambda.Function(this, 'Function', {
      functionName: 'enshrouded-idle-shutdown',
      role,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'idle-shutdown/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), { exclude: ['**/*.d.ts'] }),
      // Probe window is ~10 s plus SSM dispatch latency; polling is bounded well inside this.
      timeout: cdk.Duration.seconds(90),
      environment: {
        INSTANCE_ID: props.instance.instanceId,
        STOP_FUNCTION_ARN: props.stopFunction.functionArn,
        IDLE_MINUTES: '10',
        // Must exceed IDLE_MINUTES, or a fresh boot could be stopped by an inherited clock.
        LAUNCH_GRACE_MINUTES: '15',
        MAX_UPTIME_HOURS: '12',
        LAST_ACTIVE_PARAM: '/enshroudedproj/state/last-active',
        MAINTENANCE_MODE_PARAM: '/enshroudedproj/state/maintenance-mode',
        RUN_STATE_PARAM: '/enshroudedproj/state/run-state',
        LAST_PLAYER_SEEN_PARAM: '/enshroudedproj/state/last-player-seen',
      },
    });

    // state/* ONLY (ARCHITECTURE 6.6.2): no server/*, no discord/*.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [param('state/*')],
      }),
    );

    // Run the probe: our instance only, and only the shell-script document.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          stack.formatArn({ service: 'ec2', resource: 'instance', resourceName: props.instance.instanceId }),
          `arn:${stack.partition}:ssm:${stack.region}::document/AWS-RunShellScript`,
        ],
      }),
    );
    // GetCommandInvocation has no useful resource scoping (the command id is unknowable
    // ahead of time); it is read-only and the handler only queries its own command.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation'], resources: ['*'] }));
    // DescribeInstances does not support resource-level permissions (AWS limitation), so
    // '*' is unavoidable. Read-only; the handler only ever passes INSTANCE_ID.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));

    // graceful-stop only. There is intentionally NO ec2:StopInstances anywhere on this role.
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [props.stopFunction.functionArn] }),
    );

    new events.Rule(this, 'Schedule', {
      ruleName: 'enshrouded-idle-shutdown',
      description: 'Idle check for the Enshrouded server, every minute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.function)],
    });
  }
}
