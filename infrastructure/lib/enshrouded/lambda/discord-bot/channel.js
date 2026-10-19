const { DISCORD_API, DISCORD_USER_AGENT, getBotToken, editOriginalResponse } = require('../shared/discord');
const { CONFIG_PREFIX, DELIVERY_PREFIX, isSnowflake, parseConfig } = require('../shared/status-channel-config');

const RATE_LIMIT_MESSAGE = 'Discord is rate-limiting bot requests; try again later';
const GLOBAL_COOLDOWN = `${DELIVERY_PREFIX}/global-rate-limit`;

function hasPermissions(value, required) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.trim() !== value) return false;
  const bits = BigInt(value);
  return (bits & 8n) !== 0n || (bits & required) === required;
}

// Both the signed front door and async helper must pass this before loading SDKs.
function validateChannelRequest(request) {
  if (!hasPermissions(request.memberPermissions, 32n)) {
    return 'You need Manage Server or Administrator permission to configure the status channel.';
  }
  if (!isSnowflake(request.guildId) || !isSnowflake(request.channelId) || request.channelType !== 0) {
    return 'Run this command in an ordinary server text channel.';
  }
  if (!hasPermissions(request.appPermissions, 1024n | 2048n | 16n)) {
    return 'The bot needs View Channel, Send Messages, and Manage Channels permissions here.';
  }
  return null;
}

async function registerChannel(request) {
  const invalid = validateChannelRequest(request);
  if (invalid) return invalid;
  const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ maxAttempts: 1 });
  const send = (command) => ssm.send(command, { abortSignal: AbortSignal.timeout(1000) });
  const read = async (Name) => {
    try {
      const result = await send(new GetParameterCommand({ Name }));
      return result.Parameter?.Value;
    } catch (error) {
      if (error.name !== 'ParameterNotFound') throw error;
      return undefined;
    }
  };
  const coolingDown = async (Name) => {
    const value = await read(Name);
    try {
      const retryAt = JSON.parse(value)?.retryAt;
      return typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > Date.now();
    } catch {
      return false;
    }
  };
  const routeCooldown = `${DELIVERY_PREFIX}/registration/${request.guildId}`;
  // The global observation is shared with the worker; only bot-authenticated REST
  // requests observe it. Interaction acknowledgements and webhook edits are separate.
  if (await coolingDown(GLOBAL_COOLDOWN) || await coolingDown(routeCooldown)) return RATE_LIMIT_MESSAGE;
  const token = await getBotToken();
  const response = await fetch(`${DISCORD_API}/channels/${request.channelId}`, {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': DISCORD_USER_AGENT },
    signal: AbortSignal.timeout(3000),
  });
  if (response.status === 429) {
    let limit;
    try { limit = await response.json(); } catch { /* Missing/malformed body: conservative default. */ }
    // Discord specifies seconds (including fractions). Never shorten its deadline;
    // default to a minute only when no finite number is supplied.
    const seconds = typeof limit?.retry_after === 'number' && Number.isFinite(limit.retry_after)
      ? Math.max(1, limit.retry_after) : 60;
    const Value = JSON.stringify({ retryAt: Date.now() + Math.ceil(seconds * 1000) });
    const persist = (Name) => send(new PutParameterCommand({ Name, Type: 'String', Value, Overwrite: true }));
    if (limit?.global === true) await persist(GLOBAL_COOLDOWN);
    await persist(routeCooldown);
    return RATE_LIMIT_MESSAGE;
  }
  if (!response.ok) throw new Error('channel-lookup-failed');
  const channel = await response.json();
  if (channel.id !== request.channelId || channel.guild_id !== request.guildId || channel.type !== 0) {
    return 'The selected channel must be an ordinary text channel in this server.';
  }
  const Name = `${CONFIG_PREFIX}/${request.guildId}`;
  const previous = parseConfig(Name, await read(Name));
  const baseName = previous?.channelId === request.channelId
    ? previous.baseName
    : typeof channel.name === 'string' ? channel.name.replace(/^[🟢🔴]-/u, '') : '';
  const config = parseConfig(Name, JSON.stringify({ guildId: request.guildId, channelId: request.channelId, baseName }));
  if (!config) return 'The channel name must contain between 1 and 98 characters before its status prefix.';
  await send(new PutParameterCommand({ Name, Type: 'String', Value: JSON.stringify(config), Overwrite: true }));
  return `Saved <#${request.channelId}> as the status channel. Status posts and the green/red channel name will update within the next minute.`;
}

async function finishChannel(event) {
  let content;
  try {
    content = await registerChannel(event);
  } catch {
    // Fetch/SDK errors can include credentials or token-bearing URLs. Never log them.
    console.error('Status channel configuration failed: lookup-or-write-failed');
    content = 'Unable to save the status channel. Check the bot permissions and try again.';
  }
  try {
    await editOriginalResponse(process.env.DISCORD_APPLICATION_ID, event.interactionToken, content, 2000);
  } catch {
    console.error('Status channel reply failed: network-or-timeout');
  }
}

module.exports = { validateChannelRequest, registerChannel, finishChannel };
