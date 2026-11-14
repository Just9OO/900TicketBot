// Posts ticket events to the server's log channel (set with /admin log). Never throws.
const { EmbedBuilder } = require('discord.js');
const { q } = require('./db');
const { colors } = require('./config');

const warned = new Set(); // channels we already complained about, so a broken setup logs once

/**
 * event(client, guildId, { title, description, color, fields: [{ name, value }] })
 * Does nothing when no log channel is set.
 */
async function event(client, guildId, { title, description, color = colors.neutral, fields = [] }) {
  try {
    const channelId = q.getSettings.get(guildId)?.log_channel_id;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
    if (description) embed.setDescription(description);
    if (fields.length) embed.addFields(fields.map((f) => ({ name: f.name, value: String(f.value).slice(0, 1024), inline: f.inline ?? true })));
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    if (!warned.has(guildId)) {
      warned.add(guildId);
      console.error(`[log] could not post to the log channel of ${guildId}:`, err.message);
    }
  }
}

module.exports = { event };
