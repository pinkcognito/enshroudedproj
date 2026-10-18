const {
  INTERACTION_TYPE,
  CALLBACK_TYPE,
  verifySignature,
  jsonResponse,
  editOriginalResponse,
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
    lambdaClient = new LambdaClient({});
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
// returned a deferred (type 5) response; we edit it via the interaction token.
async function finishStart(event) {
  const reply = (content) =>
    editOriginalResponse(process.env.DISCORD_APPLICATION_ID, event.interactionToken, content);
  try {
    const instance = await describeInstance();
    const state = instance?.State?.Name;
    if (state === 'running') {
      await reply('The server is already running.');
    } else if (state === 'pending') {
      await reply('The server is already starting up.');
    } else if (state === 'stopping' || state === 'shutting-down') {
      await reply('The server is shutting down. Try again in a minute.');
    } else if (state === 'stopped') {
      const { StartInstancesCommand } = require('@aws-sdk/client-ec2');
      await ec2().send(new StartInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }));
      await reply('Booting the world - this takes a few minutes.');
    } else {
      await reply(`The server is in an unexpected state (${state ?? 'unknown'}).`);
    }
  } catch (err) {
    console.error('finishStart failed:', err);
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

// Self-invoke asynchronously, then ack with a deferred response.
async function deferAndInvoke(internal, interaction, failureMessage) {
  const { InvokeCommand } = require('@aws-sdk/client-lambda');
  try {
    await lambda().send(
      new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: JSON.stringify({ _internal: internal, interactionToken: interaction.token }),
      }),
    );
  } catch (err) {
    // Must not throw: no response at all looks like a timeout to Discord.
    console.error(`Failed to kick off ${internal}:`, err);
    return jsonResponse({ type: CALLBACK_TYPE.CHANNEL_MESSAGE, data: { content: failureMessage } });
  }
  return jsonResponse({ type: CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE });
}

exports.handler = async (event) => {
  // Internal self-invocations are not Discord requests: no signature to verify.
  if (event && event._internal === 'finish-start') {
    return finishStart(event);
  }
  if (event && event._internal === 'finish-status') {
    return finishStatus(event);
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
      // WP-13 adds stop/password/update/backup as further branches here (and in commands.js).
      if (subcommand === 'start') {
        return deferAndInvoke('finish-start', interaction, 'Failed to start the server, check CloudWatch logs.');
      }
      if (subcommand === 'status') {
        return deferAndInvoke('finish-status', interaction, 'Failed to check server status, check CloudWatch logs.');
      }
    }

    return jsonResponse({
      type: CALLBACK_TYPE.CHANNEL_MESSAGE,
      data: { content: 'Unknown command.' },
    });
  }

  return { statusCode: 400, body: 'unsupported interaction type' };
};
