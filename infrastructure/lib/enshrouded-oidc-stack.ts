import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** GitHub repo allowed to assume the CI roles (matches the project-wide `repo` tag). */
export const OIDC_GITHUB_REPO = 'pinkcognito/enshroudedproj';
/**
 * The account's EXISTING GitHub OIDC provider (created by the UO project's GithubOidcStack).
 * Imported by ARN only. A second provider for the same URL fails with EntityAlreadyExists.
 */
export const EXISTING_GITHUB_OIDC_PROVIDER_ARN =
  'arn:aws:iam::334953720182:oidc-provider/token.actions.githubusercontent.com';
/** Our own CDK bootstrap qualifier. NEVER the default (hnb659fds), which is the UO project's toolkit. */
export const BOOTSTRAP_QUALIFIER = 'enshrd1';
/** `enshrouded-` prefix: UO owns the un-prefixed github-actions-* names. */
export const CDK_DEPLOY_CI_ROLE_NAME = 'enshrouded-github-actions-cdk-deploy';
export const CDK_DIFF_CI_ROLE_NAME = 'enshrouded-github-actions-cdk-diff';

const OIDC_HOST = 'token.actions.githubusercontent.com';

/**
 * WP-02: the identities GitHub Actions uses to run CDK. Both roles ONLY `sts:AssumeRole` onto our
 * own `cdk-enshrd1-*` bootstrap roles (6.2.1a); they never call CloudFormation/EC2/IAM themselves.
 * What those bootstrap roles may reach is constrained by the hand-made EnshroudedUoGuardrail
 * policy (6.2.1) - deliberately NOT created or referenced here.
 */
export class EnshroudedOidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;
  public readonly diffRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidc',
      EXISTING_GITHUB_OIDC_PROVIDER_ARN,
    );

    const bootstrapRole = (kind: string): string =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-${BOOTSTRAP_QUALIFIER}-${kind}-role-${this.account}-${this.region}`;

    // Deploy: main branch of this repo only (a push to main carries this exact sub).
    this.deployRole = new iam.Role(this, 'CdkDeployRole', {
      roleName: CDK_DEPLOY_CI_ROLE_NAME,
      description: 'GitHub Actions (main only): assume the enshrd1 CDK bootstrap roles to deploy Enshrouded* stacks',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${OIDC_HOST}:sub`]: `repo:${OIDC_GITHUB_REPO}:ref:refs/heads/main`,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(bootstrapRole),
      }),
    );

    // Diff: any branch / pull_request of this repo (subs: repo:<r>:pull_request, repo:<r>:ref:refs/heads/*).
    // Read-only: lookup role only (`cdk diff --method template` never creates a change set).
    this.diffRole = new iam.Role(this, 'CdkDiffRole', {
      roleName: CDK_DIFF_CI_ROLE_NAME,
      description: 'GitHub Actions (any branch/PR): read-only cdk diff via the enshrd1 lookup role',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { [`${OIDC_HOST}:aud`]: 'sts.amazonaws.com' },
        StringLike: { [`${OIDC_HOST}:sub`]: `repo:${OIDC_GITHUB_REPO}:*` },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.diffRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [bootstrapRole('lookup')] }),
    );

    new cdk.CfnOutput(this, 'CdkDeployRoleArn', { value: this.deployRole.roleArn });
    new cdk.CfnOutput(this, 'CdkDiffRoleArn', { value: this.diffRole.roleArn });
  }
}
