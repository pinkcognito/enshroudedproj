const { jsonResponse, CALLBACK_TYPE } = require('../shared/discord');

// Inline interaction response: no token lookup, AWS calls, or deferred work.
function helpResponse() {
  return jsonResponse({
    type: CALLBACK_TYPE.CHANNEL_MESSAGE,
    data: {
      flags: 64,
      content: [
        '**Enshrouded commands**',
        '`/enshrouded start` — Start the server. Booting the world takes a few minutes.',
        '`/enshrouded pw` — DM you the server passwords your role allows. Only works while the server is up or starting.',
        '`/enshrouded status` — Check whether the server instance is up or down.',
        '`/enshrouded channel` — Choose the current text channel for status posts and its green/red name. Requires Manage Server or Administrator. The bot needs View Channel, Send Messages, and Manage Channels here.',
        '`/enshrouded help` — Show this help privately to you.',
        '',
        '🟢 Green means the game query is responsive. 🔴 Red means unavailable; the server may still be starting or running without responding.',
        'Status checks run every minute. Discord rename rate limits can delay the channel dot; the bot retries automatically.',
        'The starter receives their authorized passwords by DM once the game is ready. Startup password rotation must be enabled by the operator after validation.',
        'The server auto-stops after 10 minutes of confirmed inactivity, with a 15-minute startup grace period.',
      ].join('\n'),
    },
  });
}

module.exports = { helpResponse };
