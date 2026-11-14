// /admin: server-wide tools. Purge needs Administrator; the rest need Manage Server.
const {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
} = require('discord.js');
const actions = require('../actions');
const { q } = require('../db');
const { colors } = require('../config');
const ui = require('../ui');
const bans = require('../bans');
const log = require('../log');

const EPH = MessageFlags.Ephemeral;

const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Purge tickets, block members from opening tickets, and set the log channel')
  .setDefaultMemberPermissions(P.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('purge')
      .setDescription('Delete ticket channels in bulk (Administrator only)')
      .addStringOption((o) =>
        o
          .setName('scope')
          .setDescription('Which tickets to purge (default: closed)')
          .addChoices(
            { name: 'Closed tickets only', value: 'closed' },
            { name: 'Every ticket, including open ones', value: 'all' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('ban')
      .setDescription('Block a member from opening tickets')
      .addUserOption((o) => o.setName('user').setDescription('Member to block').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why (shown to them when they try)').setMaxLength(300))
      .addStringOption((o) =>
        o.setName('duration').setDescription('How long: 30m, 12h, 7d, 2w, or perm (default: perm)').setMaxLength(8),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unban')
      .setDescription('Let a blocked member open tickets again')
      .addUserOption((o) => o.setName('user').setDescription('Member to unblock').setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName('banlist').setDescription('Show members who are blocked from opening tickets'))
  .addSubcommand((sub) =>
    sub
      .setName('log')
      .setDescription('Choose the channel that records every ticket action')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where to post the log').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addBooleanOption((o) => o.setName('off').setDescription('Turn the log off')),
  );

const reply = (i, embed) => i.reply({ embeds: [embed], flags: EPH, allowedMentions: { parse: [] } });

const handlers = {
  async purge(i) {
    if (!i.memberPermissions.has(P.Administrator)) return reply(i, ui.fail('Only administrators can purge tickets.'));
    return actions.purge(i);
  },

  async ban(i) {
    const user = i.options.getUser('user', true);
    if (user.bot) return reply(i, ui.fail('Bots cannot open tickets, so there is nothing to block.'));
    if (user.id === i.user.id) return reply(i, ui.fail('You cannot block yourself.'));

    const seconds = bans.parseDuration(i.options.getString('duration'));
    if (seconds === undefined) return reply(i, ui.fail('Use a duration like `30m`, `12h`, `7d`, `2w`, or `perm`.'));
    const reason = i.options.getString('reason')?.trim() || null;
    const expires = seconds ? bans.nowSec() + seconds : null;

    q.upsertBan.run({ guild_id: i.guildId, user_id: user.id, reason, banned_by: i.user.id, created_at: bans.nowSec(), expires_at: expires });
    log.event(i.client, i.guildId, {
      title: 'Member blocked from tickets',
      color: 0xed4245,
      fields: [
        { name: 'Member', value: `<@${user.id}>` },
        { name: 'By', value: `<@${i.user.id}>` },
        { name: 'Until', value: expires ? `<t:${expires}:f>` : 'Permanent' },
        ...(reason ? [{ name: 'Reason', value: reason }] : []),
      ],
    });
    return reply(i, ui.ok(`<@${user.id}> can no longer open tickets${expires ? ` until <t:${expires}:f>` : ''}. Their open tickets are not affected.`));
  },

  async unban(i) {
    const user = i.options.getUser('user', true);
    const removed = q.deleteBan.run(i.guildId, user.id);
    if (!removed.changes) return reply(i, ui.fail('That member is not blocked.'));
    log.event(i.client, i.guildId, {
      title: 'Member unblocked',
      color: 0x57f287,
      fields: [{ name: 'Member', value: `<@${user.id}>` }, { name: 'By', value: `<@${i.user.id}>` }],
    });
    return reply(i, ui.ok(`<@${user.id}> can open tickets again.`));
  },

  async banlist(i) {
    const rows = q.listBans.all(i.guildId).filter((b) => !b.expires_at || b.expires_at > bans.nowSec());
    if (!rows.length) return reply(i, ui.info('Nobody is blocked from opening tickets.'));
    const lines = rows.map(
      (b) => `⛔ <@${b.user_id}>  ·  ${b.expires_at ? `ends <t:${b.expires_at}:R>` : 'permanent'}${b.reason ? `\n└ ${ui.trunc(b.reason, 80)}` : ''}`,
    );
    return i.reply({
      embeds: [new EmbedBuilder().setColor(colors.primary).setTitle(`⛔ Blocked members (${rows.length})`).setDescription(ui.trunc(lines.join('\n'), 4000)).setFooter({ text: 'Lift a block with /admin unban' })],
      flags: EPH,
      allowedMentions: { parse: [] },
    });
  },

  async log(i) {
    if (i.options.getBoolean('off')) {
      q.setLogChannel.run(i.guildId, null);
      return reply(i, ui.ok('The log is off.'));
    }
    const channel = i.options.getChannel('channel');
    if (!channel) {
      const current = q.getSettings.get(i.guildId)?.log_channel_id;
      return reply(i, ui.info(current ? `Events are logged in <#${current}>. Use \`channel\` to change it or \`off\` to stop.` : 'No log channel is set. Use the `channel` option to choose one.'));
    }
    const me = await i.guild.members.fetchMe();
    if (!channel.permissionsFor(me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
      return reply(i, ui.fail(`I cannot send embeds in <#${channel.id}>. I need View Channel, Send Messages and Embed Links there.`));
    }
    q.setLogChannel.run(i.guildId, channel.id);
    log.event(i.client, i.guildId, { title: 'Ticket log started', description: `Set by <@${i.user.id}>. Every ticket action will be recorded here.`, color: 0x57f287 });
    return reply(i, ui.ok(`Ticket events will be logged in <#${channel.id}>.`));
  },
};

module.exports = {
  data,
  async execute(i) {
    // Server owners can change a command's default permissions, so enforce it here too.
    if (!i.memberPermissions.has(P.ManageGuild)) return reply(i, ui.fail('You need the **Manage Server** permission.'));
    return handlers[i.options.getSubcommand()](i);
  },
};
