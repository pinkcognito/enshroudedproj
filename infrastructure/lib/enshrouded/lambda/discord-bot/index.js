const {
  INTERACTION_TYPE,
  CALLBACK_TYPE,
  verifySignature,
  jsonResponse,
  editOriginalResponse,
  deferInteraction,
  getSubcommand,
} = require('../shared/discord');

// AWS SDK v3 ships in the Node 22 Lambda runtime. Clients are created lazily so
// verification/PING never pays for them (and unit tests can mock them).
let ec2Client = null;
let lambdaClient = null;
function ec2() {
  if (!ec2Client) {
    const { EC2Client } = require('@aws-sdk/client-ec2');
    ec2Client = new EC2Client({});
  }
  return ec2Client;
}
function lambda() {
  if (!lambdaClient) {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    lambdaClient = new LambdaClient({ maxAttempts: 1 });
  }
  return lambdaClient;
}

async function describeInstance() {
  const { DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
  const res = await ec2().send(new DescribeInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }));
  return res.Reservations?.[0]?.Instances?.[0];
}

// Runs as a separate async invocation so the slow part never blocks Discord's 3s ack
// deadline (EC2 start alone regularly took 3.5-4s). The initial invocation already
// delivered a deferred (type 5) callback; we edit it via the interaction token.
async function finishStart(event, context) {
  const reply = (content) =>
    editOriginalResponse(process.env.DISCORD_APPLICATION_ID, event.interactionToken, content);
  try {
    const instance = await describeInstance();
    // Interlock (b) clock starts when the state observation returns; the kill-switch read
    // below deliberately counts against the 5 s bound.
    const observedAt = performance.now();
    const state = instance?.State?.Name;
    if (state === 'running') {
      await reply('The server is already running.');
    } else if (state === 'pending') {
      await reply('The server is already starting up.');
    } else if (state === 'stopping' || state === 'shutting-down') {
      await reply('The server is shutting down. Try again in a minute.');
    } else if (state === 'stopped') {
      const rotation = require('./rotation');
      let rotated = false;
      let unrotatedNote = '';
      if (await rotation.rotationEnabled()) {
        let outcome;
        try {
          outcome = await rotation.rotatePasswords(observedAt);
        } catch (err) {
          // A caught write failure must NOT block the start (7.4.3): SSM, the box and pw all
          // derive from SSM, so they agree whatever was written. It must also NOT set
          // password-desync - a failed rotation cannot make SSM and the game disagree.
          console.error(`Password rotation failed: ${err?.name ?? 'error'}`);
          rotation.emitMetric('PasswordRotationWriteFailed');
          outcome = 'failed';
        }
        if (outcome === 'stale') {
          // Freshness abort: start UNROTATED (7.4.3). No re-Describe loop - the StartInstances
          // response is the authority. rotated stays false, so interlock (c) cannot fire.
          rotation.emitMetric('PasswordRotationStale');
        }
        rotated = outcome === 'rotated';
        if (outcome === 'failed' || outcome === 'stale') unrotatedNote = ' WARNING: the passwords were NOT rotated for this session - the previous passwords are still in force. Tell an admin.';
      }
      const { StartInstancesCommand } = require('@aws-sdk/client-ec2');
      const result = await ec2().send(new StartInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }));
      const ours = result.StartingInstances?.find((item) => item.InstanceId === process.env.INSTANCE_ID);
      const previous = ours?.PreviousState?.Name;
      // Interlock (c): we rotated into somebody else's boot.
      if (rotated && previous !== 'stopped') {
        try { await rotation.recordDesync(previous); } catch { console.error('Recording password desync failed'); }
        await reply('The server was already starting. Run `/enshrouded pw` to see whether the credentials can be confirmed.');
        return;
      }
      if (previous === 'stopped') {
        try { await rotation.clearDesyncIfSet(); } catch { console.error('Clearing password desync failed'); }
      }
      // A successful EC2 start must not become a failed start because Discord failed.
      try {
        await editOriginalResponse(process.env.DISCORD_APPLICATION_ID, event.interactionToken,
          `Booting the world - this takes a few minutes.${unrotatedNote}`, 2000);
      } catch {
        console.error('Server start reply failed: network-or-timeout');
      }
      const started = previous === 'stopped' && ours?.CurrentState?.Name === 'pending';
      if (started) {
        try {
          const budgetMs = Math.min(3500, (context?.getRemainingTimeInMillis?.() ?? 4000) - 500);
          if (budgetMs > 0) await require('./starter-announcement').announceStarter(event, budgetMs);
        } catch {
          console.error('Starter announcement failed: delivery-failed');
        }
      }
    } else {
      await reply(`The server is in an unexpected state (${state ?? 'unknown'}).`);
    }
  } catch (err) {
    // Name only: this path can follow a SecureString write, so never log the error object.
    console.error(`finishStart failed: ${err?.name ?? 'error'}`);
    await reply('Failed to start the server, check CloudWatch logs.');
  }
}

async function finishStatus(event) {
  const reply = (content) =>
    editOriginalResponse(process.env.DISCORD_APPLICATION_ID, event.interactionToken, content);
  try {
    const instance = await describeInstance();
    const state = instance?.State?.Name;
    let content;
    if (state === 'running') {
      content = 'The server is up.';
    } else if (state === 'stopped') {
      content = 'The server is down. Use `/enshrouded start` to start it.';
    } else {
      content = `The server is ${state ?? 'in an unknown state'}.`;
    }
    await reply(content);
  } catch (err) {
    console.error('finishStatus failed:', err);
    await reply('Failed to check server status, check CloudWatch logs.');
  }
}

// Deliver the acknowledgement before SDK loading or the awaited async invocation.
async function deferAndInvoke(internal, interaction, channelRequest, starter, ephemeral = Boolean(channelRequest)) {
  if (!(await deferInteraction(interaction.id, interaction.token, ephemeral ? { ephemeral: true } : undefined))) {
    return { statusCode: 202, body: '' };
  }
  try {
    const { InvokeCommand } = require('@aws-sdk/client-lambda');
    await lambda().send(
      new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: JSON.stringify({ _internal: internal, interactionToken: interaction.token, ...channelRequest, ...starter }),
      }),
      { abortSignal: AbortSignal.timeout(3000) },
    );
  } catch {
    console.error(`Failed to kick off ${internal}: invocation-failed`);
    try {
      await editOriginalResponse(
        process.env.DISCORD_APPLICATION_ID,
        interaction.token,
        'Unable to confirm request submission; check status before retrying.',
        2000,
      );
    } catch {
      console.error('Discord failure message PATCH failed: network-or-timeout');
    }
  }
  return { statusCode: 202, body: '' };
}

exports.handler = async (event, context) => {
  // Internal self-invocations are not Discord requests: no signature to verify.
  if (event && event._internal === 'finish-start') {
    return finishStart(event, context);
  }
  if (event && event._internal === 'finish-status') {
    return finishStatus(event);
  }
  if (event && event._internal === 'finish-pw') {
    return require('./password-command').finishPw(event, { describeInstance });
  }
  if (event && event._internal === 'finish-channel') {
    return require('./channel').finishChannel(event);
  }

  // Signature verification comes first, before any parsing or other processing.
  const headers = Object.fromEntries(
    Object.entries(event?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  let rawBody = event?.body || '';
  if (event?.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf-8');
  }

  if (
    !signature ||
    !timestamp ||
    !verifySignature(process.env.DISCORD_PUBLIC_KEY || '', rawBody, signature, timestamp)
  ) {
    return { statusCode: 401, body: 'invalid request signature' };
  }

  const interaction = JSON.parse(rawBody);

  if (interaction.type === INTERACTION_TYPE.PING) {
    return jsonResponse({ type: CALLBACK_TYPE.PONG });
  }

  if (interaction.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
    const commandName = interaction.data?.name;
    const subcommand = getSubcommand(interaction)?.name;
    const user = interaction.member?.user ?? interaction.user;

    console.log(
      JSON.stringify({
        event: 'command',
        command: commandName,
        subcommand,
        guildId: interaction.guild_id,
        userId: user?.id,
      }),
    );

    if (commandName === 'enshrouded') {
      // WP-13 adds stop/update/backup as further branches here (and in commands.js).
      if (subcommand === 'help') {
        return require('./help').helpResponse();
      }
      if (subcommand === 'start') {
        return deferAndInvoke('finish-start', interaction, undefined,
          { guildId: interaction.guild_id, userId: user?.id });
      }
      if (subcommand === 'status') {
        return deferAndInvoke('finish-status', interaction);
      }
      if (subcommand === 'pw') {
        // Ephemeral defer; the payload carries snowflakes and role ids only, never a secret.
        return deferAndInvoke('finish-pw', interaction, undefined,
          { guildId: interaction.guild_id, userId: user?.id, roleIds: interaction.member?.roles }, true);
      }
      if (subcommand === 'channel') {
        const request = {
          guildId: interaction.guild_id,
          channelId: interaction.channel_id,
          channelType: interaction.channel?.type,
          memberPermissions: interaction.member?.permissions,
          appPermissions: interaction.app_permissions,
        };
        const invalid = require('./channel').validateChannelRequest(request) ||
          (getSubcommand(interaction)?.options?.length ? 'This command takes no options; run it in the channel to configure.' : null);
        if (invalid) return jsonResponse({ type: CALLBACK_TYPE.CHANNEL_MESSAGE, data: { content: invalid, flags: 64 } });
        return deferAndInvoke('finish-channel', interaction, request);
      }
    }

    return jsonResponse({
      type: CALLBACK_TYPE.CHANNEL_MESSAGE,
      data: { content: 'Unknown command.' },
    });
  }

  return { statusCode: 400, body: 'unsupported interaction type' };
};
