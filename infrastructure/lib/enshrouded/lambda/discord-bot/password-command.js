// Deferred half of /enshrouded pw (ARCHITECTURE §7.4.4). Order matters:
//   1. authorize (live member fetch)   - a caller with no tier role learns nothing else
//   2. check instance state            - so pw is never a server-state oracle
//   3. read the live SSM values        - never values carried in an event payload
//   4. DM the caller's tier cascade
// Invariant §1.15: a password that reached a DM is always the live one.

const { editOriginalResponse, getBotToken } = require('../shared/discord');
const { ACCESS_PREFIX, authorizePasswordAccess, sendPasswordDm } = require('./password-access');
const { readParameter, readPasswords, desyncActive } = require('./rotation');

const DENIED = 'You do not have access to server passwords.';
const FAILED = 'Unable to fetch the server passwords right now. Try again shortly.';
const DOWN = 'The server is down, so there are no live passwords to give you. Start it with `/enshrouded start`.';
const DESYNC = "I can't confirm the server is using the current passwords - tell an admin; a stop/start resyncs.";
const STARTING = ' The server is still starting; these are the passwords it will come up with.';

async function finishPw(event, { describeInstance }) {
  const reply = (content) =>
    editOriginalResponse(process.env.DISCORD_APPLICATION_ID, event.interactionToken, content);
  try {
    const request = { guildId: event.guildId, userId: event.userId, roleIds: event.roleIds };
    let mapping;
    try {
      mapping = JSON.parse(await readParameter(`${ACCESS_PREFIX}/${request.guildId}`));
    } catch {
      mapping = null;
    }
    const botToken = await getBotToken();
    const access = await authorizePasswordAccess(request, mapping, { botToken });
    if (!access) return await reply(DENIED);

    const state = (await describeInstance())?.State?.Name;
    if (state !== 'running' && state !== 'pending') return await reply(DOWN);
    if (state === 'running' && (await desyncActive())) return await reply(DESYNC);

    const passwords = await readPasswords(access.groups);
    const result = await sendPasswordDm(request, access, passwords, { botToken });
    return await reply(result.ok && state === 'pending' ? result.content + STARTING : result.content);
  } catch (err) {
    // Name only: never the error object, which could carry request detail.
    console.error(`finishPw failed: ${err?.name ?? 'error'}`);
    try { await reply(FAILED); } catch { /* nothing further to do */ }
  }
}

module.exports = { finishPw };
