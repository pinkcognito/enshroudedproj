#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { EnshroudedServerStack } from '../lib/enshrouded-server-stack';

const app = new cdk.App();

// Applied to every stack/resource in this app - do not remove. All AWS
// resources we deploy must be tagged with project + repo for cost tracking
// and ownership attribution.
cdk.Tags.of(app).add('project', 'enshroudedproj');
cdk.Tags.of(app).add('repo', 'pinkcognito/enshroudedproj');

// stackName MUST be explicit and start with "Enshrouded". The account also
// hosts a live UO server in InfrastructureStack / AdminUiStack / GithubOidcStack.
new EnshroudedServerStack(app, 'EnshroudedServerStack', {
  stackName: 'EnshroudedServerStack',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
