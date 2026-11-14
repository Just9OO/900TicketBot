const { InteractionContextType, PermissionFlagsBits: P, SlashCommandBuilder } = require('discord.js');
const setup = require('../setup');

const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Build or edit ticket panels from one screen (Manage Server)')
  .setDefaultMemberPermissions(P.ManageGuild)
  .setContexts(InteractionContextType.Guild);

module.exports = { data, execute: setup.start };
