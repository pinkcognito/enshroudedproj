// Shared Discord helpers for the Enshrouded Lambdas (discord-bot now; boot-watcher,
// status-channel later). Plain CommonJS, bundled as-is into the Lambda zip.
const crypto = require('crypto');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_USER_AGENT = 'DiscordBot (https://github.com/pinkcognito/enshroudedproj, 1.0)';

// Discord interaction types / callback types / option types (subset we use).
const INTERACTION_TYPE = { PING: 1, APPLICATION_COMMAND: 2 };
const CALLBACK_TYPE = { PONG: 1, CHANNEL_MESSAGE: 4, DEFERRED_CHANNEL_MESSAGE: 5 };
const OPTION_TYPE = { SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4 };

// Node's crypto needs an Ed25519 public key wrapped in SPKI/DER, but Discord hands us
// the raw 32-byte key as hex. This is the fixed ASN.1 prefix for a raw Ed25519 SPKI
// key - avoids an external crypto dependency for this one check.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify Discord's Ed25519 signature over `timestamp + rawBody`. Never throws: any
 * malformed key/signature (including the all-zero placeholder key) yields false.
 */
function verifySignature(publicKeyHex, rawBody, signatureHex, timestamp) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(timestamp + rawBody),
      publicKey,
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

function jsonResponse(body) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Cached across warm invocations so most invocations skip the SSM round-trip.
// The value is never logged.
let cachedBotToken = null;

async function getBotToken() {
  if (cachedBotToken) {
    return cachedBotToken;
  }
  const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
  const ssm = new SSMClient({});
  const result = await ssm.send(
    new GetParameterCommand({ Name: process.env.BOT_TOKEN_PARAM, WithDecryption: true }),
  );
  cachedBotToken = result.Parameter.Value;
  return cachedBotToken;
}

/** Edit the deferred reply. Interaction-token webhooks need no bot-token auth. */
async function editOriginalResponse(applicationId, interactionToken, content) {
  const res = await fetch(
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'User-Agent': DISCORD_USER_AGENT },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) {
    // Status only: the URL contains the interaction token, so never log it.
    console.error(`Discord PATCH @original failed: ${res.status}`);
  }
  return res.ok;
}

/** The invoked subcommand (type 1 option directly under the command), or null. */
function getSubcommand(interaction) {
  return interaction.data?.options?.find((o) => o.type === OPTION_TYPE.SUB_COMMAND) ?? null;
}

/** Read a value option, looking inside the invoked subcommand first. */
function getOption(interaction, name) {
  const sub = getSubcommand(interaction);
  const options = sub ? sub.options : interaction.data?.options;
  return options?.find((o) => o.name === name)?.value;
}

module.exports = {
  DISCORD_API,
  DISCORD_USER_AGENT,
  INTERACTION_TYPE,
  CALLBACK_TYPE,
  OPTION_TYPE,
  verifySignature,
  jsonResponse,
  getBotToken,
  editOriginalResponse,
  getSubcommand,
  getOption,
};
