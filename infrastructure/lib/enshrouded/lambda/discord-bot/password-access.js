const { DISCORD_API, DISCORD_USER_AGENT } = require('../shared/discord');
const { isSnowflake } = require('../shared/status-channel-config');

const ACCESS_PREFIX = '/enshroudedproj/discord/password-access';
const GROUPS = ['admin', 'friend', 'guest', 'visitor'];
const COMMAND_ACTIONS = ['start', 'stop', 'update', 'backup'];

/** Operator-owned String parameter; this module never writes mappings or reads secrets.
 * Uniqueness is enforced within `roles` only (7.5.1): commandRoles may deliberately reuse a tier
 * role's id or each other's. Unknown keys in either object reject the whole mapping.
 */
function parseAccessMapping(parameterName, value) {
  try {
    const mapping = JSON.parse(value);
    if (!mapping || !isSnowflake(mapping.guildId) || parameterName !== `${ACCESS_PREFIX}/${mapping.guildId}` ||
        Object.keys(mapping).some((key) => !['guildId', 'roles', 'commandRoles'].includes(key)) ||
        !mapping.roles || typeof mapping.roles !== 'object' || Array.isArray(mapping.roles)) return null;
    const entries = Object.entries(mapping.roles);
    if (entries.some(([group, id]) => !GROUPS.includes(group) || !isSnowflake(id)) ||
        new Set(entries.map(([, id]) => id)).size !== entries.length) return null;
    const result = { guildId: mapping.guildId, roles: Object.fromEntries(entries) };
    if (mapping.commandRoles !== undefined) {
      if (!mapping.commandRoles || typeof mapping.commandRoles !== 'object' || Array.isArray(mapping.commandRoles)) return null;
      const commandEntries = Object.entries(mapping.commandRoles);
      if (commandEntries.some(([action, id]) => !COMMAND_ACTIONS.includes(action) || !isSnowflake(id))) return null;
      result.commandRoles = Object.fromEntries(commandEntries);
    }
    return result;
  } catch {
    return null;
  }
}

function validRoles(roles) {
  return Array.isArray(roles) && roles.every(isSnowflake);
}

function validCaller(request) {
  return request && isSnowflake(request.guildId) && isSnowflake(request.userId) && validRoles(request.roleIds);
}

function headers(botToken) {
  return { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json', 'User-Agent': DISCORD_USER_AGENT };
}

/** The single implementation of the intersect-both-observations rule: the signature-verified
 * roles carried in the request, intersected with a live GET of the member. Returns the role ids
 * present in BOTH, or null on any failure. Shared by the knowledge path and the action path.
 */
async function liveMemberRoles(request, botToken, fetchRequest) {
  const response = await fetchRequest(`${DISCORD_API}/guilds/${request.guildId}/members/${request.userId}`, {
    method: 'GET', headers: headers(botToken), signal: AbortSignal.timeout(2000), redirect: 'error',
  });
  if (!response.ok) return null;
  const member = await response.json();
  if (member?.user?.id !== request.userId || !validRoles(member.roles) ||
      (member.guild_id !== undefined && member.guild_id !== request.guildId)) return null;
  return request.roleIds.filter((id) => member.roles.includes(id));
}

/** Authorization for an ACTION (7.5.2): one membership test against the single role id
 * commandRoles[action]. No cascade, no admin implication, no fallback, nothing shared with the
 * tier cascade except the live-member intersection. An absent mapping/commandRoles/key denies.
 * On success `groups` is the caller's tier cascade (possibly empty) - information for the reply
 * only; it never influences the decision.
 */
async function authorizeCommand(request, mapping, action, { botToken, fetch: fetchRequest = globalThis.fetch } = {}) {
  try {
    if (!COMMAND_ACTIONS.includes(action) || !validCaller(request) || typeof botToken !== 'string' || !botToken) return null;
    const config = parseAccessMapping(`${ACCESS_PREFIX}/${request.guildId}`, JSON.stringify(mapping));
    const roleId = config?.commandRoles?.[action];
    if (!roleId || !request.roleIds.includes(roleId)) return null;
    const live = await liveMemberRoles(request, botToken, fetchRequest);
    if (!live || !live.includes(roleId)) return null;
    const highest = GROUPS.findIndex((group) => live.includes(config.roles[group]));
    return { guildId: request.guildId, userId: request.userId, groups: highest < 0 ? [] : GROUPS.slice(highest) };
  } catch {
    return null;
  }
}

/** request identifiers/roleIds must come from an already signature-verified guild interaction.
 * No Administrator/ManageGuild bypass. A removed role cannot survive a stale signed request.
 * GET one member requires no privileged member-list intent; any lookup failure denies access.
 */
async function authorizePasswordAccess(request, mapping, { botToken, fetch: fetchRequest = globalThis.fetch } = {}) {
  try {
    if (!validCaller(request) || typeof botToken !== 'string' || !botToken) return null;
    const config = parseAccessMapping(`${ACCESS_PREFIX}/${request.guildId}`, JSON.stringify(mapping));
    if (!config || !GROUPS.some((group) => request.roleIds.includes(config.roles[group]))) return null;
    const live = await liveMemberRoles(request, botToken, fetchRequest);
    if (!live) return null;
    // `live` is the intersection of both observations: newly granted roles require a fresh
    // interaction; signed roles alone never grant access after removal from the live member.
    const highest = GROUPS.findIndex((group) =>
      live.includes(config.roles[group]));
    return highest < 0 ? null : { guildId: request.guildId, userId: request.userId, groups: GROUPS.slice(highest) };
  } catch {
    // Never propagate raw fetch exceptions, response bodies, bot tokens, or passwords.
    return null;
  }
}

// Returns plain text for the caller's ephemeral deferred reply (editOriginalResponse). This
// used to be a synchronous interaction response, which cannot work on a deferred path.
function privateReply(content, ok) {
  return { ok, content };
}

/** Supply the authorization result above and only passwords allowed by the eventual
 * generation/readiness guard. No public-channel or interaction-token secret fallback.
 */
async function sendPasswordDm(request, access, passwords, { botToken, fetch: fetchRequest = globalThis.fetch } = {}) {
  const failure = () => privateReply('Unable to send passwords by direct message. Check your privacy settings and try again.', false);
  try {
    if (!validCaller(request) || !access || access.guildId !== request.guildId || access.userId !== request.userId ||
        typeof botToken !== 'string' || !botToken || !Array.isArray(access.groups) || !access.groups.length) return failure();
    const highest = GROUPS.indexOf(access.groups[0]);
    if (highest < 0 || JSON.stringify(access.groups) !== JSON.stringify(GROUPS.slice(highest))) return failure();
    const lines = access.groups.map((group) => {
      const password = passwords?.[group];
      if (typeof password !== 'string' || !password.length) throw new Error('missing-authorized-password');
      return `${group}: ${password}`;
    });
    const content = ['Enshrouded passwords', ...lines].join('\n');
    if (content.length > 2000) return failure();
    const dmResponse = await fetchRequest(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST', headers: headers(botToken), body: JSON.stringify({ recipient_id: request.userId }),
      signal: AbortSignal.timeout(2000), redirect: 'error',
    });
    if (!dmResponse.ok) return failure();
    const dm = await dmResponse.json();
    if (!isSnowflake(dm?.id) || dm.type !== 1 || dm.guild_id !== undefined ||
        !Array.isArray(dm.recipients) || dm.recipients.length !== 1 || dm.recipients[0]?.id !== request.userId) return failure();
    const message = await fetchRequest(`${DISCORD_API}/channels/${dm.id}/messages`, {
      method: 'POST', headers: headers(botToken), body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(2000), redirect: 'error',
    });
    return message.ok ? privateReply('Sent your passwords in a direct message.', true) : failure();
  } catch {
    return failure();
  }
}

module.exports = { ACCESS_PREFIX, GROUPS, COMMAND_ACTIONS, parseAccessMapping, authorizePasswordAccess, authorizeCommand, sendPasswordDm };
