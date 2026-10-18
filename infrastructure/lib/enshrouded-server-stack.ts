import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { EnshroudedServer } from './enshrouded/server';
import { WorldStorage } from './enshrouded/world-storage';
import { DiscordBot } from './enshrouded/discord-bot';
import { GameDeploy } from './enshrouded/game-deploy';

export class EnshroudedServerStack extends cdk.Stack {
  public readonly server: EnshroudedServer;
  public readonly worldStorage: WorldStorage;
  public readonly discordBot: DiscordBot;
  public readonly gameDeploy: GameDeploy;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.server = new EnshroudedServer(this, 'Server');
    this.worldStorage = new WorldStorage(this, 'WorldStorage', {
      instance: this.server.instance,
      role: this.server.role,
    });
    // Deploy-time config (env var or `-c key=value`); absent values fall back to placeholders.
    this.discordBot = new DiscordBot(this, 'DiscordBot', {
      instance: this.server.instance,
      discordPublicKey: process.env.DISCORD_PUBLIC_KEY ?? this.node.tryGetContext('discordPublicKey'),
      discordApplicationId: process.env.DISCORD_APPLICATION_ID ?? this.node.tryGetContext('discordApplicationId'),
    });
    this.gameDeploy = new GameDeploy(this, 'GameDeploy', {
      instance: this.server.instance,
      bucket: this.worldStorage.bucket,
      // Existing account-level GitHub OIDC provider, by ARN (env var or `-c githubOidcProviderArn=...`).
      githubOidcProviderArn: process.env.GITHUB_OIDC_PROVIDER_ARN ?? this.node.tryGetContext('githubOidcProviderArn'),
    });
  }
}
