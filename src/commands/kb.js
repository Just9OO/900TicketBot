// /articles: the server's help articles. They are suggested to members while they open a ticket.
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
const knowledge = require('../knowledge');
const autocomplete = require('../autocomplete');

const EPH = MessageFlags.Ephemeral;

const articleOption = (o) =>
  o.setName('article').setDescription('Which article').setRequired(true).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('articles')
  .setDescription('Manage the help articles suggested to members opening tickets')
  .setDefaultMemberPermissions(P.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName('add').setDescription('Write a new help article'))
  .addSubcommand((sub) =>
    sub.setName('remove').setDescription('Delete a help article').addIntegerOption(articleOption),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show every help article'))
  .addSubcommand((sub) =>
    sub
      .setName('link')
      .setDescription('Always suggest an article for one topic')
      .addIntegerOption(articleOption)
      .addIntegerOption((o) =>
        o.setName('topic').setDescription('Which topic').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('unlink').setDescription('Stop tying an article to a topic').addIntegerOption(articleOption),
  );

const reply = (i, embed) => i.editReply({ embeds: [embed] });
const isManager = (i) => i.memberPermissions.has(P.ManageGuild);
const denyManager = (i) =>
  i.reply({ embeds: [ui.fail('You need the **Manage Server** permission.')], flags: EPH });
const limitReached = (i) => q.kbCount.get(i.guildId).n >= knowledge.MAX_ARTICLES;
const limitMessage = `A server can have at most ${knowledge.MAX_ARTICLES} help articles. Remove one first.`;

/** The modal from /articles add arrived. */
async function submitArticle(i) {
  if (!isManager(i)) return denyManager(i);
  if (limitReached(i)) return i.reply({ embeds: [ui.fail(limitMessage)], flags: EPH });

  const inserted = q.insertKb.run({
    guild_id: i.guildId,
    topic_id: null,
    title: i.fields.getTextInputValue('title').trim(),
    keywords: i.fields
      .getTextInputValue('keywords')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', '),
    body: i.fields.getTextInputValue('body').trim(),
    created_at: Math.floor(Date.now() / 1000),
  });
  knowledge.invalidate(i.guildId);
  return i.reply({
    embeds: [
      ui.ok(
        `Saved article **#${Number(inserted.lastInsertRowid)}**. Members whose question matches its ` +
          'keywords will be shown it. Use `/articles link` to always show it for one topic.',
      ),
    ],
    flags: EPH,
  });
}

const handlers = {
  async remove(i) {
    const removed = q.kbDelete.run(i.options.getInteger('article', true), i.guildId);
    knowledge.invalidate(i.guildId);
    return reply(i, removed.changes ? ui.ok('Article deleted.') : ui.fail('I could not find that article.'));
  },

  async list(i) {
    const rows = q.kbByGuild.all(i.guildId);
    if (!rows.length) return reply(i, ui.info('No help articles yet. Write one with `/articles add`.'));
    const lines = rows.map(
      (a) =>
        `**#${a.id}** ${ui.trunc(a.title, 80)}` +
        (a.keywords ? `\n└ 🔎 ${ui.trunc(a.keywords, 80)}` : '') +
        (a.topic_id ? `${a.keywords ? ' · ' : '\n└ '}🔗 topic #${a.topic_id}` : ''),
    );
    return i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(colors.primary)
          .setTitle(`📚 Help articles (${rows.length}/${knowledge.MAX_ARTICLES})`)
          .setDescription(ui.trunc(lines.join('\n'), 4000)),
      ],
    });
  },

  async link(i) {
    const article = q.kbGet.get(i.options.getInteger('article', true), i.guildId);
    const topic = q.getTopic.get(i.options.getInteger('topic', true));
    const panel = topic ? q.getPanel.get(topic.panel_id) : null;
    if (!article) return reply(i, ui.fail('I could not find that article.'));
    if (panel?.guild_id !== i.guildId) return reply(i, ui.fail('I could not find that topic in this server.'));

    q.kbLink.run(topic.id, article.id, i.guildId);
    knowledge.invalidate(i.guildId);
    return reply(i, ui.ok(`**${article.title}** will now always be suggested for **${topic.label}**.`));
  },

  async unlink(i) {
    const article = q.kbGet.get(i.options.getInteger('article', true), i.guildId);
    if (!article) return reply(i, ui.fail('I could not find that article.'));
    q.kbLink.run(null, article.id, i.guildId);
    knowledge.invalidate(i.guildId);
    return reply(i, ui.ok(`**${article.title}** is no longer tied to a topic. It can still match by keywords.`));
  },
};

module.exports = {
  data,
  submitArticle,
  async execute(i) {
    if (!isManager(i)) return denyManager(i);
    const sub = i.options.getSubcommand();

    // A modal has to be the very first response, so /articles add must not defer.
    if (sub === 'add') {
      if (limitReached(i)) return i.reply({ embeds: [ui.fail(limitMessage)], flags: EPH });
      return i.showModal(ui.kbAddModal());
    }
    await i.deferReply({ flags: EPH });
    return handlers[sub](i);
  },
  autocomplete(i) {
    return i.options.getFocused(true).name === 'topic'
      ? autocomplete.topics(i)
      : autocomplete.articles(i);
  },
};
