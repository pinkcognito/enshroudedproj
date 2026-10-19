import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { DiscordBot } from '../lib/enshrouded/discord-bot';

test('bot config write scope is exactly discord/status-channels/*; credentials and server remain read-only', () => {
  const app = new cdk.App();
  cdk.Tags.of(app).add('project', 'enshroudedproj');
  cdk.Tags.of(app).add('repo', 'pinkcognito/enshroudedproj');
  const stack = new cdk.Stack(app, 'EnshroudedChannelRegistrationTest', {
    stackName: 'EnshroudedChannelRegistrationTest', env: { account: '123456789012', region: 'us-east-2' },
  });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 1, natGateways: 0 });
  const imageId = new cdk.CfnParameter(stack, 'ImageId', { type: 'AWS::EC2::Image::Id' });
  const instance = new ec2.Instance(stack, 'Server', { vpc,
    instanceType: new ec2.InstanceType('r6i.large'), machineImage: ec2.MachineImage.genericLinux({ 'us-east-2': imageId.valueAsString }),
  });
  new DiscordBot(stack, 'Bot', { instance });
  const policies = Template.fromStack(stack).findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement) as {
    Action: string | string[]; Resource: unknown; Effect: string;
  }[];
  const writes = statements.filter((s) => s.Effect === 'Allow' &&
    [s.Action].flat().includes('ssm:PutParameter'));
  const discordWrites = writes.filter((s) => JSON.stringify(s.Resource).includes('/discord/'));
  expect(discordWrites).toHaveLength(1);
  expect(discordWrites[0].Action).toBe('ssm:PutParameter');
  expect(discordWrites[0].Resource).toEqual({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' },
    ':ssm:us-east-2:123456789012:parameter/enshroudedproj/discord/status-channels/*']] });
  for (const statement of writes) {
    expect(JSON.stringify(statement.Resource)).not.toMatch(/server\/|bot-token|parameter\/enshroudedproj\/\*/);
  }
});
