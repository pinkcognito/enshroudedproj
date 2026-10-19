const CONFIG_PREFIX = '/enshroudedproj/discord/status-channels';
const DELIVERY_PREFIX = '/enshroudedproj/state/status-channel';

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value) && value.trim() === value;
}

function parseConfig(parameterName, value) {
  try {
    const config = JSON.parse(value);
    if (!config || !isSnowflake(config.guildId) || !isSnowflake(config.channelId) ||
        parameterName !== `${CONFIG_PREFIX}/${config.guildId}` ||
        typeof config.baseName !== 'string' || !config.baseName.trim() ||
        [...config.baseName].length > 98) return null;
    return { guildId: config.guildId, channelId: config.channelId, baseName: config.baseName };
  } catch {
    return null;
  }
}

module.exports = { CONFIG_PREFIX, DELIVERY_PREFIX, parseConfig, isSnowflake };
