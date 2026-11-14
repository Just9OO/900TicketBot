const { InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { q } = require('../db');
const ui = require('../ui');
const knowledge = require('../knowledge');
const autocomplete = require('../autocomplete');

const data = new SlashCommandBuilder()
  .setName('faq')
  .setDescription('Look up a help article')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o
      .setName('article')
      .setDescription('Pick an article, or type a few words to search')
      .setRequired(true)
      .setAutocomplete(true)
      .setMaxLength(200),
  )
  .addBooleanOption((o) =>
    o.setName('show').setDescription('Post the answer for everyone in this channel (default: only you)'),
  );

module.exports = {
  data,
  async execute(i) {
    const input = i.options.getString('article', true).trim();
    // Picking from the list sends the article's id; anything else is searched as text.
    const article = /^\d+$/.test(input)
      ? q.kbGet.get(Number(input), i.guildId)
      : knowledge.search(i.guildId, input, 1)[0];

    if (!article) {
      return i.reply({
        embeds: [ui.fail('I could not find a matching article. Try different words, or open a ticket.')],
        flags: MessageFlags.Ephemeral,
      });
    }
    return i.reply({
      embeds: [ui.kbEmbed(article)],
      flags: i.options.getBoolean('show') ? undefined : MessageFlags.Ephemeral,
    });
  },
  autocomplete: (i) => autocomplete.articles(i, { asText: true }),
};
