import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

/** SSM SecureString holding the Discord bot token. Stored by the operator, never by CDK/CI. */
export const BOT_TOKEN_PARAM = '/enshroudedproj/discord/bot-token';

export interface DiscordBotProps {
  /** The Enshrouded game server instance this bot controls. */
  readonly instance: ec2.Instance;
  /**
   * Discord application Ed25519 public key (hex). Not known until the Discord app exists:
   * defaults to a placeholder that rejects every request until set for real.
   */
  readonly discordPublicKey?: string;
  /** Discord application ID, needed to edit the deferred reply. */
  readonly discordApplicationId?: string;
}

/**
 * HTTP endpoint Discord calls for `/enshrouded` slash commands. Ed25519-verified,
 * deferred ack, slow work in an async self-invocation.
 */
export class DiscordBot extends Construct {
  public readonly function: lambda.Function;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: DiscordBotProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // Explicit name so the self-invoke permission can use a formatted ARN: referencing
    // fn.functionArn from its own role policy would create a role<->function cycle.
    const functionName = 'enshrouded-discord-bot';

    const role = new iam.Role(this, 'Role', {
      roleName: 'enshrouded-discord-bot',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    this.function = new lambda.Function(this, 'Function', {
      functionName,
      role,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'discord-bot/index.handler',
      // Parent lambda/ dir so the zip also carries lambda/shared/.
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda'), { exclude: ['**/*.d.ts'] }),
      timeout: cdk.Duration.seconds(15),
      environment: {
        INSTANCE_ID: props.instance.instanceId,
        DISCORD_PUBLIC_KEY: props.discordPublicKey || '0'.repeat(64),
        DISCORD_APPLICATION_ID: props.discordApplicationId ?? '',
        BOT_TOKEN_PARAM,
      },
    });

    // Async self-invoke (finish-start / finish-status).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          stack.formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: functionName,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // SSM scoping (ARCHITECTURE §6.6.2). ARN form: parameter/enshroudedproj/... (the path's
    // leading slash is the separator; `parameter//...` silently matches nothing).
    const ssmParamArn = (suffix: string) =>
      `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/enshroudedproj/${suffix}`;
    // discord/*: read (bot token, SecureString, aws/ssm key).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [ssmParamArn('discord/*'), ssmParamArn('discord')],
      }),
    );
    // state/*: runtime coordination (maintenance-mode, last-active, run-state), read/write.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:PutParameter'],
        resources: [ssmParamArn('state/*'), ssmParamArn('state')],
      }),
    );
    // NAMED CROSS-BOUNDARY EXCEPTION (§6.6.2): `/enshrouded password` must return a group
    // password, so the bot needs exactly one server/ value. Granted on this SINGLE parameter
    // ARN, never the server/ prefix. Do not widen it "because the bot needs a password".
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [ssmParamArn('server/user-groups/admin-password')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
      }),
    );

    // Start: scoped to OUR instance only.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances'],
        resources: [
          stack.formatArn({ service: 'ec2', resource: 'instance', resourceName: props.instance.instanceId }),
        ],
      }),
    );
    // DescribeInstances does not support resource-level permissions (AWS limitation), so
    // '*' is unavoidable here. It is read-only, and the handler only ever passes INSTANCE_ID.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));

    const api = new apigwv2.HttpApi(this, 'Api', {
      description: 'Discord interactions endpoint for the Enshrouded server',
    });
    api.addRoutes({
      path: '/interactions',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('DiscordIntegration', this.function),
    });

    this.apiUrl = `${api.apiEndpoint}/interactions`;
    new cdk.CfnOutput(this, 'InteractionsUrl', { value: this.apiUrl });
  }
}
