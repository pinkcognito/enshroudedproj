#!/usr/bin/env node
// Registers the bot's slash commands with Discord from the version-controlled
// definitions in lib/enshrouded/lambda/discord-bot/commands.js.
//
// MANUAL OPERATOR STEP - not part of `cdk deploy`. This is a BULK OVERWRITE (HTTP PUT):
// the command set Discord serves is replaced wholesale with commands.js, so any command
// missing from commands.js is deleted from Discord. Idempotent.
//
// Usage (from infrastructure/):
//   DISCORD_APPLICATION_ID=<app id> node scripts/register-discord-commands.js
//   # near-instant propagation while testing, scope to a guild:
//   DISCORD_APPLICATION_ID=<app id> DISCORD_GUILD_ID=<guild id> node scripts/register-discord-commands.js
//
// Global and guild command sets STACK (a guild sees the union); clear one by PUTting an
// empty array to it.
//
// Token: DISCORD_BOT_TOKEN env var if set, else `aws ssm get-parameter` on
// /enshroudedproj/discord/bot-token (SecureString). Never logged.

const { execFileSync } = require('node:child_process');
const { commands } = require('../lib/enshrouded/lambda/discord-bot/commands');

const BOT_TOKEN_PARAM = process.env.BOT_TOKEN_PARAM || '/enshroudedproj/discord/bot-token';
const DISCORD_USER_AGENT = 'DiscordBot (https://github.com/pinkcognito/enshroudedproj, 1.0)';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function getBotToken() {
  if (process.env.DISCORD_BOT_TOKEN) {
    return process.env.DISCORD_BOT_TOKEN.trim();
  }
  let out;
  try {
    out = execFileSync(
      'aws',
      ['ssm', 'get-parameter', '--name', BOT_TOKEN_PARAM, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'],
      { encoding: 'utf-8' },
    );
  } catch {
    return fail(
      `could not read the bot token from SSM (${BOT_TOKEN_PARAM}). Set DISCORD_BOT_TOKEN, ` +
        `or ensure the AWS CLI is installed and your credentials can ssm:GetParameter it.`,
    );
  }
  const token = out.trim();
  if (!token) {
    fail(`SSM parameter ${BOT_TOKEN_PARAM} resolved to an empty value.`);
  }
  return token;
}

async function main() {
  const appId = process.env.DISCORD_APPLICATION_ID;
  if (!appId) {
    fail('DISCORD_APPLICATION_ID is required (Developer Portal -> General Information -> App ID).');
  }
  const guildId = process.env.DISCORD_GUILD_ID;
  const token = getBotToken();

  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  console.log(
    `Registering ${commands.length} command(s) (${commands.map((c) => c.name).join(', ')}) ` +
      `${guildId ? `to guild ${guildId}` : 'globally'} - this OVERWRITES the existing set...`,
  );

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': DISCORD_USER_AGENT,
    },
    body: JSON.stringify(commands),
  });

  const text = await res.text();
  if (!res.ok) {
    fail(`Discord returned ${res.status}: ${text}`);
  }
  let registered = [];
  try {
    registered = JSON.parse(text);
  } catch {
    // ignore
  }
  console.log(
    `Registered ${Array.isArray(registered) ? registered.length : '?'} command(s). ` +
      `${guildId ? 'Guild commands propagate near-instantly.' : 'Global commands can take up to ~1 hour to propagate.'}`,
  );
}

main().catch((err) => fail(err.message));
