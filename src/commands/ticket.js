// /ticket: everything you do to a ticket, in one place. /close and /claim also exist as shortcuts.
const {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const actions = require('../actions');
const { q } = require('../db');
const ui = require('../ui');
const topicsLib = require('../topics');
const tickets = require('../tickets');
const autocomplete = require('../autocomplete');

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Manage the ticket you are in')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName('claim').setDescription('Claim this ticket, or release it if it is yours (staff)'))
  .addSubcommand((sub) => sub.setName('info').setDescription('Show the details of this ticket'))
  .addSubcommand((sub) =>
    sub
      .setName('priority')
      .setDescription('Mark how urgent this ticket is (staff)')
      .addStringOption((o) =>
        o
          .setName('level')
          .setDescription('How urgent it is')
          .setRequired(true)
          .addChoices(
            { name: '🟢 Low', value: 'low' },
            { name: '⚪ Normal', value: 'normal' },
            { name: '🟠 High', value: 'high' },
            { name: '🔴 Urgent', value: 'urgent' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('transfer')
      .setDescription('Hand this ticket to another staff member (staff)')
      .addUserOption((o) => o.setName('user').setDescription('Staff member who takes over').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close this ticket (works even if the Close button does not)')
      .addStringOption((o) => o.setName('reason').setDescription('Why the ticket is being closed').setMaxLength(512)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('request-close')
      .setDescription('Ask the opener to confirm the issue is resolved (staff)')
      .addStringOption((o) => o.setName('message').setDescription('A note for the opener').setMaxLength(1000)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a member to this ticket (staff)')
      .addUserOption((o) => o.setName('user').setDescription('Member to add').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a member you added to this ticket (staff)')
      .addUserOption((o) => o.setName('user').setDescription('Member to remove').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Rename this ticket channel (staff)')
      .addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true).setMinLength(1).setMaxLength(90)),
  )
  .addSubcommand((sub) => sub.setName('reopen').setDescription('Reopen this closed ticket (staff)'))
  .addSubcommand((sub) => sub.setName('delete').setDescription('Delete this ticket channel (staff)'))
  .addSubcommand((sub) =>
    sub
      .setName('open')
      .setDescription('Open a ticket for a member (staff)')
      .addUserOption((o) => o.setName('user').setDescription('Member the ticket is for').setRequired(true))
      .addIntegerOption((o) => o.setName('panel').setDescription('Which panel').setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName('topic').setDescription('Which topic').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why you are opening it (shown in the ticket)').setMaxLength(500)),
  );

/** /ticket open: staff open a ticket on behalf of a member. */
async function open(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = (embed) => i.editReply({ embeds: [embed] });

  const panel = q.getPanel.get(i.options.getInteger('panel', true));
  const topic = panel?.guild_id === i.guildId ? q.getTopic.get(i.options.getInteger('topic', true)) : null;
  if (!panel || topic?.panel_id !== panel.id) return reply(ui.fail('I could not find that topic on that panel.'));

  const settings = topicsLib.resolve(panel, topic);
  if (!tickets.isStaff(i, settings.staffRoleId)) return reply(ui.fail('Only staff for this topic can open tickets for members.'));
  if (settings.kind === 'application') return reply(ui.fail('Applications have to be submitted by the member themselves.'));

  const user = i.options.getUser('user', true);
  if (user.bot) return reply(ui.fail('You cannot open a ticket for a bot.'));
  if (!i.options.getMember('user')) return reply(ui.fail('That user is not in this server.'));

  const reason = i.options.getString('reason')?.trim();
  const result = await tickets.openTicket({ guild: i.guild, user, client: i.client }, panel, topic, {
    subject: topic.label,
    fields: [
      { name: 'Opened by staff', value: `<@${i.user.id}>` },
      ...(reason ? [{ name: 'Reason', value: reason }] : []),
    ],
  });
  return reply(result.error ? ui.fail(result.error) : ui.ok(`Opened <#${result.channel.id}> for <@${user.id}>.`));
}

const handlers = {
  info: actions.info,
  priority: actions.priority,
  transfer: actions.transfer,
  claim: actions.claim,
  close: (i) => actions.close(i, i.options.getString('reason')?.trim() || null),
  'request-close': actions.closeRequest,
  add: actions.addUser,
  remove: actions.removeUser,
  rename: actions.rename,
  reopen: actions.reopen,
  delete: actions.remove,
  open,
};

module.exports = {
  data,
  execute: (i) => handlers[i.options.getSubcommand()](i),
  autocomplete(i) {
    return i.options.getFocused(true).name === 'panel' ? autocomplete.panels(i) : autocomplete.topics(i);
  },
};
