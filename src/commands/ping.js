const { InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const ui = require('../ui');

const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check the bot latency')
  .setContexts(InteractionContextType.Guild);

module.exports = {
  data,
  async execute(i) {
    // One API call: the gap between Discord creating the interaction and us seeing it.
    const api = Math.max(0, Date.now() - i.createdTimestamp);
    const ws = i.client.ws.ping;
    await i.reply({
      embeds: [ui.info(`🏓 **Pong!**\nAPI: \`${api}ms\`\nGateway: \`${ws < 0 ? '—' : `${Math.round(ws)}ms`}\``)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
