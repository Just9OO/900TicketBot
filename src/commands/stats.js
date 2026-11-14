// /stats: a quick look at how the ticket system is doing in this server.
const {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
} = require('discord.js');
const { q } = require('../db');
const { colors } = require('../config');
const ui = require('../ui');

const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Ticket and rating statistics for this server (Manage Server)')
  .setDefaultMemberPermissions(P.ManageGuild)
  .setContexts(InteractionContextType.Guild);

module.exports = {
  data,
  async execute(i) {
    if (!i.memberPermissions.has(P.ManageGuild)) {
      return i.reply({ embeds: [ui.fail('You need the **Manage Server** permission.')], flags: MessageFlags.Ephemeral });
    }

    const count = { ticket: { open: 0, closed: 0 }, application: { open: 0, closed: 0 } };
    for (const row of q.countByStatus.all(i.guildId)) {
      (count[row.kind] ?? count.ticket)[row.status] += row.n;
    }
    const week = q.closedSince.get(i.guildId, Math.floor(Date.now() / 1000) - 7 * 86400).n;
    const ratings = q.ratingStats.get(i.guildId);
    const staff = q.topStaff.all(i.guildId);

    const totalOpen = count.ticket.open + count.application.open;
    const totalClosed = count.ticket.closed + count.application.closed;
    const medals = ['🥇', '🥈', '🥉'];
    const bar = (avg) => `${ui.stars(Math.round(avg))}\n${ui.meter(avg, 5)}  **${avg.toFixed(2)}** / 5`;

    const embed = new EmbedBuilder()
      .setColor(colors.primary)
      .setTitle(`📊 Ticket stats · ${ui.trunc(i.guild.name, 200)}`)
      .setDescription(`**${totalOpen}** open · **${totalClosed}** closed · **${week}** closed in the last 7 days`)
      .addFields(
        { name: '🎫 Tickets', value: `🟢 ${count.ticket.open} open\n🔴 ${count.ticket.closed} closed\n${ui.meter(count.ticket.closed, count.ticket.open + count.ticket.closed)}`, inline: true },
        { name: '📋 Applications', value: `🟢 ${count.application.open} open\n🔴 ${count.application.closed} closed\n${ui.meter(count.application.closed, count.application.open + count.application.closed)}`, inline: true },
        {
          name: '⭐ Rating',
          value: ratings.n ? `${bar(ratings.avg)}\nfrom ${ratings.n} rating${ratings.n === 1 ? '' : 's'}` : 'No ratings yet',
          inline: true,
        },
      );
    if (staff.length) {
      embed.addFields({
        name: '🏆 Top rated staff',
        value: staff.map((s, n) => `${medals[n] ?? `${n + 1}.`} <@${s.claimed_by}> · ${s.avg.toFixed(2)} / 5 (${s.n})`).join('\n'),
      });
    }
    return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
