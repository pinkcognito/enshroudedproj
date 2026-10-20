// Source-of-truth definitions for the bot's Discord slash commands.
//
// Lives *beside* the handler (index.js) on purpose: the registered subcommands/options
// MUST match what the handler dispatches on and reads. test/discord-commands.test.ts
// is the anti-drift guard. `scripts/register-discord-commands.js` PUTs this exact
// array to Discord as a BULK OVERWRITE.
//
// IMPORTANT: registration replaces the whole command set. Every command/subcommand the
// handler dispatches on must appear here, or running the registration silently deletes
// it from Discord.

const { OPTION_TYPE } = require('../shared/discord');

// One top-level command with subcommands (type 1 options). WP-13 adds stop,
// update and backup by appending entries to `options` and branches in index.js.
const commands = [
  {
    name: 'enshrouded',
    description: 'Control the Enshrouded server',
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: 'channel',
        description: 'Use this text channel for server status posts and its green/red name',
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: 'help',
        description: 'Show commands, permissions, and how server status works',
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: 'pw',
        description: 'DM you the server passwords for your role (only while the server is up)',
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: 'start',
        description: 'Start the Enshrouded server',
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: 'status',
        description: 'Show whether the Enshrouded server is up',
      },
    ],
  },
];

module.exports = { commands, OPTION_TYPE };
