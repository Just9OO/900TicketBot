const crypto = require('node:crypto');
const config = require('./config');
const { q } = require('./db');
const commands = require('./commands');

/**
 * Registers slash commands only when their definitions changed since the last run.
 * Skipping the API call on normal restarts avoids Discord's command-registration rate limits.
 * Returns true when it registered, false when nothing changed.
 */
async function syncCommands(client) {
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  const key = `commands:${client.application.id}:${config.guildId ?? 'global'}`;

  if (q.getMeta.get(key)?.value === hash) return false;

  await client.application.commands.set(body, config.guildId ?? undefined);
  q.setMeta.run(key, hash);
  return true;
}

module.exports = { syncCommands };
