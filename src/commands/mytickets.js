const { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { q } = require('../db');
const { colors } = require('../config');
const ui = require('../ui');

const data = new SlashCommandBuilder()
  .setName('mytickets')
  .setDescription('See your open tickets in this server')
  .setContexts(InteractionContextType.Guild);

async function execute(i) {
  const rows = q.openByOwner.all(i.guildId, i.user.id);
  const lines = rows.map(
    (t) =>
      `${t.kind === 'application' ? '📋' : '🎫'} <#${t.channel_id}>  ·  ${ui.trunc(t.subject ?? 'Ticket', 40)}\n└ ${ui.statusText(t)}  ·  opened <t:${t.created_at}:R>`,
  );
  const embed = new EmbedBuilder()
    .setColor(colors.primary)
    .setTitle(`🎫 Your open tickets (${rows.length})`)
    .setDescription(
      rows.length ? ui.trunc(lines.join('\n\n'), 4000) : 'You have no open tickets here. Use a panel in the server to open one.',
    );
  return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute };
