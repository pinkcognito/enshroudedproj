import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { githubOidcSubs } from './constants';

/** GitHub repo allowed to assume the deploy role (matches the project-wide `repo` tag). */
export { GITHUB_REPO_BY_NAME as GITHUB_REPO } from './constants';
export const GAME_DEPLOY_ROLE_NAME = 'enshrouded-github-game-deploy';
/** The ONLY parameter the deploy workflow may write (ARCHITECTURE 6.6.2). */
export const MAINTENANCE_PARAM_PATH = '/enshroudedproj/state/maintenance-mode';
/** Read ON the box by update-game.sh, so it lives in the server/ namespace (ARCHITECTURE 6.6). */
export const BACKUP_BUCKET_PARAM_PATH = '/enshroudedproj/server/backup-bucket';

export interface GameDeployProps {
  readonly instance: ec2.Instance;
  /** World-backup bucket (WP-04); its name is published for the on-box pre-update sync. */
  readonly bucket: s3.IBucket;
  /**
   * ARN of the account's existing GitHub OIDC identity provider
   * (arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com). It is
   * imported BY ARN ONLY: this stack never creates, modifies or imports any other stack's
   * resources. When absent, no deploy role is created (nothing to trust yet).
   */
  readonly githubOidcProviderArn?: string;
}

/**
 * WP-06 infrastructure: the SSM parameter that tells the box where to back up before an update,
 * and the least-privilege role the game-deploy workflow assumes via GitHub OIDC (§6.6.2 row
 * "GitHub Actions game-deploy role": write on maintenance-mode only, nothing else in SSM).
 * Secrets are NOT created here: the SecureString passwords are operator-seeded, never in CFN.
 */
export class GameDeploy extends Construct {
  public readonly deployRole?: iam.Role;

  constructor(scope: Construct, id: string, props: GameDeployProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    new ssm.StringParameter(this, 'BackupBucketParam', {
      parameterName: BACKUP_BUCKET_PARAM_PATH,
      stringValue: props.bucket.bucketName,
      description: 'World-backup bucket for the on-box pre-update savegame sync (read by update-game.sh)',
    });

    new cdk.CfnOutput(this, 'InstanceId', { value: props.instance.instanceId });

    if (!props.githubOidcProviderArn) return;

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidc',
      props.githubOidcProviderArn,
    );
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: GAME_DEPLOY_ROLE_NAME,
      // main-branch workflows of this repo only (workflow_dispatch from main carries this sub).
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        // A list is an OR. No wildcards: the branch context stays exact, so this is
        // still main-only - only the repo spelling has two accepted forms.
        StringLike: { 'token.actions.githubusercontent.com:sub': githubOidcSubs('ref:refs/heads/main') },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // The one SSM write: maintenance mode, nothing else.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [`arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${MAINTENANCE_PARAM_PATH}`],
      }),
    );
    // Run the deploy on THIS instance only, with the stock shell document only.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          `arn:${stack.partition}:ssm:${stack.region}::document/AWS-RunShellScript`,
          `arn:${stack.partition}:ec2:${stack.region}:${stack.account}:instance/${props.instance.instanceId}`,
        ],
      }),
    );
    // Reading results: these actions do not support resource-level scoping.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'],
        resources: ['*'],
      }),
    );
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn });
  }
}
