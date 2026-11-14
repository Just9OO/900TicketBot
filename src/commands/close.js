const { InteractionContextType, SlashCommandBuilder } = require('discord.js');
const actions = require('../actions');

const data = new SlashCommandBuilder()
  .setName('close')
  .setDescription('Close this ticket (works even if the Close button does not)')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o.setName('reason').setDescription('Why the ticket is being closed').setMaxLength(512),
  );

module.exports = {
  data,
  execute: (i) => actions.close(i, i.options.getString('reason')?.trim() || null),
};
