const { DISCORD_API, DISCORD_USER_AGENT, getBotToken } = require('../shared/discord');
const { CONFIG_PREFIX, DELIVERY_PREFIX, isSnowflake, parseConfig } = require('../shared/status-channel-config');

// One budget for all reads and Discord calls, including the cached token lookup.
async function announceStarter({ guildId, userId }, budgetMs) {
  if (!isSnowflake(guildId) || !isSnowflake(userId) || budgetMs <= 0) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const signal = controller.signal;
  // getBotToken is shared and has no cancellation argument. Stop waiting at our
  // deadline; its read-only cache fill cannot trigger a late announcement.
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const abort = () => rejectDeadline(new Error('announcement-budget-exhausted'));
  signal.addEventListener('abort', abort, { once: true });
  const bounded = (operation) => Promise.race([operation, deadline]);
  try {
    const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
    const ssm = new SSMClient({ maxAttempts: 1 });
    const send = (command) => {
      signal.throwIfAborted();
      return bounded(ssm.send(command, { abortSignal: signal }));
    };
    const read = async (Name) => {
      try { return (await send(new GetParameterCommand({ Name }))).Parameter?.Value; }
      catch (error) {
        if (error.name !== 'ParameterNotFound') throw error;
        return undefined;
      }
    };
    const globalName = `${DELIVERY_PREFIX}/global-rate-limit`;
    const Name = `${CONFIG_PREFIX}/${guildId}`;
    const config = parseConfig(Name, await read(Name));
    if (!config) return;
    const cooldown = await read(globalName);
    let retryAt;
    try { retryAt = JSON.parse(cooldown)?.retryAt; } catch { /* No valid cooldown. */ }
    if (typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > Date.now()) return;
    const token = await bounded(getBotToken());
    const request = async (suffix, options = {}) => {
      signal.throwIfAborted();
      const response = await bounded(fetch(`${DISCORD_API}/channels/${config.channelId}${suffix}`, {
        ...options, signal,
        headers: { Authorization: `Bot ${token}`, 'User-Agent': DISCORD_USER_AGENT, 'Content-Type': 'application/json' },
      }));
      if (response.status === 429) {
        let limit;
        try { limit = await bounded(response.json()); } catch { /* Never retry. */ }
        if (limit?.global === true) {
          const seconds = typeof limit.retry_after === 'number' && Number.isFinite(limit.retry_after)
            ? Math.max(1, limit.retry_after) : 60;
          await send(new PutParameterCommand({ Name: globalName, Type: 'String', Overwrite: true,
            Value: JSON.stringify({ retryAt: Date.now() + Math.ceil(seconds * 1000) }) }));
        }
      }
      if (!response.ok) {
        console.error(`Starter announcement failed: Discord status ${response.status}`);
        return null;
      }
      return response;
    };
    const response = await request('');
    if (!response) return;
    const channel = await bounded(response.json());
    if (channel.id !== config.channelId || channel.guild_id !== guildId || channel.type !== 0) return;
    await request('/messages', { method: 'POST', body: JSON.stringify({
      content: `🚀 Server start requested by <@${userId}>.`, allowed_mentions: { parse: [] },
    }) });
  } catch {
    console.error('Starter announcement failed: lookup-or-delivery-failed');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

module.exports = { announceStarter };
