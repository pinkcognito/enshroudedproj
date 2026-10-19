const { SSMClient, GetParametersByPathCommand, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { CONFIG_PREFIX, DELIVERY_PREFIX, parseConfig } = require('../shared/status-channel-config');
const { getBotToken, DISCORD_API, DISCORD_USER_AGENT } = require('../shared/discord');
const { queryInfo } = require('../shared/a2s');

const log = (outcome, status) => console.log(JSON.stringify({ event: 'status-channel', outcome, ...(status ? { status } : {}) }));
const deadline = (value) => Number.isFinite(value) && value > Date.now();

exports.handler = async (_event, context) => {
  // Events are wakeups, never evidence: old and foreign event payloads cannot select a host.
  const ssm = new SSMClient({ maxAttempts: 2 });
  const ec2 = new EC2Client({ maxAttempts: 2 });
  const send = (command) => ssm.send(command, { abortSignal: AbortSignal.timeout(3000) });
  const read = async (name) => {
    try {
      return (await send(new GetParameterCommand({ Name: name, WithDecryption: false }))).Parameter?.Value;
    } catch (error) {
      if (error.name === 'ParameterNotFound') return undefined;
      throw error;
    }
  };
  const readState = async (name) => {
    const value = await read(name);
    return value === undefined ? {} : JSON.parse(value);
  };
  const write = (name, state) => send(new PutParameterCommand({
    Name: name, Value: JSON.stringify(state), Type: 'String', Overwrite: true,
  }));
  try {
    const configs = [];
    let next;
    do {
      const page = await send(new GetParametersByPathCommand({
        Path: CONFIG_PREFIX, Recursive: true, WithDecryption: false, ...(next ? { NextToken: next } : {}),
      }));
      for (const p of page.Parameters || []) {
        const config = parseConfig(p.Name, p.Value);
        if (config) configs.push({ ...config, parameterName: p.Name });
      }
      next = page.NextToken;
    } while (next);
    if (!configs.length) return;

    const globalName = `${DELIVERY_PREFIX}/global-rate-limit`;
    let globalState = await readState(globalName);
    if (deadline(globalState.retryAt)) return;
    let semantic = 'unknown';
    let bootId = '';
    try {
      const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }),
        { abortSignal: AbortSignal.timeout(3000) });
      const instance = result.Reservations?.flatMap(r => r.Instances || [])
        .find(i => i.InstanceId === process.env.INSTANCE_ID);
      if (instance) {
        const launch = new Date(instance.LaunchTime).getTime();
        bootId = Number.isFinite(launch) ? String(launch) : '';
        const state = instance.State?.Name;
        if (state === 'stopped' || state === 'terminated') semantic = 'offline';
        else if (state === 'pending') semantic = 'starting';
        else if (state === 'stopping') semantic = 'stopping';
        else if (state === 'running') {
          let ok = false;
          if (instance.PublicIpAddress) {
            try {
              ok = (await queryInfo({ host: instance.PublicIpAddress,
                port: Number(process.env.QUERY_PORT || '15637'), timeoutMs: 2500 })).ok === true;
            } catch { log('query-failed'); }
          }
          semantic = ok ? 'online' : (Date.now() >= launch && Date.now() - launch < 15 * 60 * 1000 ? 'starting' : 'unknown');
        }
      }
    } catch { log('lookup-failed'); }

    const messageKey = `${semantic}:${bootId}`;
    const content = semantic === 'online'
      ? '🟢 Server online (query responding). Join via the dedicated server list.'
      : `🔴 Server ${semantic}.`;
    let token;
    // A failure never exposes response bodies, exception messages, tokens, or URLs.
    const route = async (method, suffix, body) => {
      if (deadline(globalState.retryAt)) return { ok: false, retryAt: globalState.retryAt };
      token ||= await getBotToken();
      try {
        const response = await fetch(`${DISCORD_API}${suffix}`, {
          method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': DISCORD_USER_AGENT },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000),
        });
        if (response.status === 429) {
          const data = await response.json();
          const seconds = Number(data.retry_after);
          const retryAt = Date.now() + Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 60000);
          if (data.global === true) {
            globalState = { retryAt };
            await write(globalName, globalState);
          }
          log('rate-limited', 429);
          return { ok: false, retryAt };
        }
        if (!response.ok) { log('http-failed', response.status); return { ok: false }; }
        return { ok: true, data: method === 'GET' ? await response.json() : undefined };
      } catch { log('request-failed'); return { ok: false }; }
    };

    // SSM pagination order is not a fairness guarantee. This worker-owned CONTROL
    // cursor names the next candidate, including when an invocation times out.
    configs.sort((a, b) => a.guildId.localeCompare(b.guildId));
    const cursorName = `${DELIVERY_PREFIX}/cursor`;
    const cursor = await readState(cursorName);
    const start = Math.max(0, typeof cursor.nextGuildId === 'string'
      ? configs.findIndex(c => c.guildId >= cursor.nextGuildId) : 0);
    for (let offset = 0; offset < configs.length; offset++) {
      if (deadline(globalState.retryAt)) break;
      if (context?.getRemainingTimeInMillis && context.getRemainingTimeInMillis() < 15000) break;
      const index = (start + offset) % configs.length;
      const config = configs[index];
      // Advance only after the time guard, but before any work for this guild.
      // Failure to persist aborts this tick rather than processing without progress.
      await write(cursorName, { nextGuildId: configs[(index + 1) % configs.length].guildId });
      try {
        const { guildId, channelId, baseName, parameterName } = config;
        const current = async () => {
          const value = await read(parameterName);
          const fresh = parseConfig(parameterName, value);
          return fresh && fresh.guildId === guildId && fresh.channelId === channelId && fresh.baseName === baseName;
        };
        if (!await current()) continue;
        const name = `${DELIVERY_PREFIX}/${guildId}/${channelId}`;
        const state = await readState(name);
        if (deadline(state.lookupRetryAt)) continue;
        const channelRoute = `/channels/${channelId}`;
        const channel = await route('GET', channelRoute);
        if (!channel.ok) {
          state.lookupRetryAt = channel.retryAt || Date.now() + 1000;
          await write(name, state);
          continue;
        }
        // Match registration: only ordinary guild text channels are supported.
        if (channel.data?.id !== channelId || channel.data.guild_id !== guildId ||
            channel.data.type !== 0 || typeof channel.data.name !== 'string') {
          log('invalid-channel'); continue;
        }
        state.lookupRetryAt = 0;
        const desiredName = `${semantic === 'online' ? '🟢' : '🔴'}-${baseName}`;
        if (channel.data.name === desiredName) {
          state.rename = desiredName;
          state.renameRetryAt = 0;
          await write(name, state);
        } else if (!deadline(state.renameRetryAt) && await current()) {
          const renamed = await route('PATCH', channelRoute, { name: desiredName });
          if (renamed.ok) { state.rename = desiredName; state.renameRetryAt = 0; }
          else state.renameRetryAt = renamed.retryAt || Date.now() + 1000;
          await write(name, state);
        }
        if (state.messageKey !== messageKey && !deadline(state.messageRetryAt) && await current()) {
          const message = await route('POST', `${channelRoute}/messages`, { content, allowed_mentions: { parse: [] } });
          if (message.ok) { state.messageKey = messageKey; state.messageRetryAt = 0; }
          else state.messageRetryAt = message.retryAt || Date.now() + 1000;
          // Persist each success immediately. A crash between HTTP success and this write
          // can still duplicate a message; Discord and SSM do not share a transaction.
          await write(name, state);
        }
      } catch { log('destination-failed'); }
    }
  } catch { log('reconcile-failed'); }
};
