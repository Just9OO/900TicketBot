const { InteractionContextType, SlashCommandBuilder } = require('discord.js');
const actions = require('../actions');

const data = new SlashCommandBuilder()
  .setName('claim')
  .setDescription('Claim this ticket (run it again to release it)')
  .setContexts(InteractionContextType.Guild);

module.exports = { data, execute: actions.claim };
