const {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const { colors } = require('../config');

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show every ticket command')
  .setContexts(InteractionContextType.Guild);

// One block per area. Each line is "command - what it does", in a code block so the commands line up.
const block = (lines) => `\`\`\`\n${lines.join('\n')}\n\`\`\``;

const embed = new EmbedBuilder()
  .setColor(colors.primary)
  .setTitle('🎫 Ticket Bot')
  .setDescription('Everything you can do, grouped by job. **New here? Run `/setup`.**')
  .addFields(
    {
      name: '🎛️ Build panels  ·  Manage Server',
      value: block([
        '/setup                  guided editor with live preview',
        '/panel create          post a panel from options',
        '/panel list | delete   see or remove panels',
        '/panel questions       form on or off, set questions',
        '/panel topic ...       add, edit, remove, list buttons',
        '/panel export | import share a panel as a .json file',
      ]),
    },
    {
      name: '🎟️ Inside a ticket  ·  staff',
      value: block([
        '/claim  /close         the two everyday shortcuts',
        '/ticket info           details of this ticket',
        '/ticket claim          take or release the ticket',
        '/ticket transfer       hand it to another staff member',
        '/ticket priority       low, normal, high or urgent',
        '/ticket close          close it, with a reason',
        '/ticket request-close  ask the opener to confirm',
        '/ticket add | remove   change who can see it',
        '/ticket rename | reopen | delete',
        '/ticket open           open one for a member',
      ]),
    },
    {
      name: '🛡️ Moderation  ·  Manage Server',
      value: block([
        '/admin log             record ticket activity',
        '/admin ban | unban     stop a member opening tickets',
        '/admin banlist         who is blocked right now',
        '/admin purge           bulk delete (Administrator)',
      ]),
    },
    {
      name: '📚 Help articles & numbers',
      value: block([
        '/articles add | list | remove | link | unlink',
        '/stats                 counts, ratings, top staff',
        '/mytickets             your own open tickets',
        '/faq                   anyone can search articles',
      ]),
    },
    {
      name: '📝 Form questions',
      value:
        'Separate questions with `|` or a new line, 5 at most. Put options in brackets for a dropdown: ' +
        '`Platform? [PC, Console, Mobile]`',
    },
  )
  .setFooter({ text: '/ping checks latency · /help shows this again' });

module.exports = {
  data,
  execute: (i) => i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }),
};
