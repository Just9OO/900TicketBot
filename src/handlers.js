const { MessageFlags } = require('discord.js');
const { q } = require('./db');
const ui = require('./ui');
const tickets = require('./tickets');
const actions = require('./actions');
const topicsLib = require('./topics');
const knowledge = require('./knowledge');
const survey = require('./survey');
const session = require('./session');
const bans = require('./bans');
const setup = require('./setup');
const commands = require('./commands');

const EPH = MessageFlags.Ephemeral;

const gone = (i) =>
  i.reply({
    embeds: [ui.fail('This panel is no longer active. Ask staff to create a new one.')],
    flags: EPH,
  });

/** Creates the ticket and tells the member. `update` edits the message the button was on. */
async function open(i, panel, topic, details, update = false) {
  if (update) await i.deferUpdate();
  else await i.deferReply({ flags: EPH });

  const result = await tickets.openTicket(i, panel, topic, details);
  const done = topic.kind === 'application' ? 'Your application has been submitted' : 'Your ticket has been created';
  await i.editReply({
    content: null,
    embeds: [result.error ? ui.fail(result.error) : ui.ok(`${done}: <#${result.channel.id}>`)],
    components: result.error
      ? []
      : [ui.ticketLink(i.guildId, result.channel.id, topic.kind === 'application' ? 'Go to your application' : 'Go to your ticket')],
  });
}

/**
 * Before creating anything, optionally show help articles that may already answer the question
 * (panel setting "before"). Otherwise go straight to creating the ticket.
 */
async function begin(i, panel, topic, details, update = false) {
  if (panel.kb_mode === 'before' && topic.kind !== 'application') {
    const text = [details.subject, ...(details.fields ?? []).map((f) => f.value)]
      .filter(Boolean)
      .join(' ');
    const articles = knowledge.suggest(i.guildId, topic, text, 2);
    if (articles.length) {
      const token = knowledge.stash({ userId: i.user.id, topicId: topic.id, details });
      const gate = {
        content: '📚 These articles may already answer your question:',
        embeds: articles.map((a) => ui.kbEmbed(a, 1200)),
        components: ui.kbGateButtons(token),
      };
      return update ? i.update(gate) : i.reply({ ...gate, flags: EPH });
    }
  }
  return open(i, panel, topic, details, update);
}

/**
 * A topic was picked. Blocked members are turned away; dropdown questions come first (as a
 * private message with one menu each), then the text form, then the ticket is created.
 */
function choose(i, panel, topic) {
  const ban = bans.activeBan(i.guildId, i.user.id);
  if (ban) return i.reply({ embeds: [ui.fail(bans.banMessage(ban))], flags: EPH });

  const { choices, texts } = topicsLib.splitQuestions(topic, panel);
  if (choices.length) {
    const token = session.create(i.user.id, { topicId: topic.id, answers: {} });
    return i.reply({
      embeds: [ui.questionEmbed(topic.label, choices, {})],
      components: ui.questionSelects(token, choices, {}),
      flags: EPH,
    });
  }
  if (topicsLib.needsForm(panel, topic)) {
    return i.showModal(ui.topicModal(topic, texts.map((t) => t.label)));
  }
  return begin(i, panel, topic, {});
}

/** Combines dropdown answers and the text form into the fields shown in the ticket, in question order. */
function buildDetails(i, topic, panel, answers = {}) {
  const { all } = topicsLib.splitQuestions(topic, panel);
  if (!all.length) {
    return {
      subject: i.fields.getTextInputValue('subject').trim(),
      fields: [{ name: 'Details', value: i.fields.getTextInputValue('details').trim() }],
    };
  }
  let choice = 0;
  let text = 0;
  return {
    subject: topic.label,
    fields: all.map((question) =>
      question.options
        ? { name: question.label, value: question.options[answers[choice++]] ?? '-' }
        : { name: question.label, value: i.fields.getTextInputValue(`q${text++}`).trim() },
    ),
  };
}

/** Loads a topic and its panel, making sure the panel belongs to the server of this interaction. */
function loadTopic(rawId) {
  const topic = q.getTopic.get(Number(rawId));
  const panel = topic ? q.getPanel.get(topic.panel_id) : null;
  return panel ? { topic, panel } : null;
}

const routes = {
  // ---- panels ----
  async t(i, [topicId]) {
    const found = loadTopic(topicId);
    return found ? choose(i, found.panel, found.topic) : gone(i);
  },
  async tsel(i, [panelId]) {
    const found = loadTopic(i.values[0]);
    if (!found || found.panel.id !== Number(panelId)) return gone(i);
    // Re-rendering the menu clears the selection so the same entry can be picked again.
    if (!i.message.flags?.has(EPH)) {
      i.message
        .edit({ components: ui.panelComponents(found.panel, topicsLib.forPanel(found.panel.id)) })
        .catch(() => {});
    }
    return choose(i, found.panel, found.topic);
  },
  async tf(i, [topicId, token]) {
    const found = loadTopic(topicId);
    if (!found) return gone(i);
    const { topic, panel } = found;

    let answers = {};
    if (token) {
      const data = session.get(token, i.user.id);
      if (!data) return i.reply({ embeds: [ui.fail('This form expired. Please open the panel again.')], flags: EPH });
      answers = data.answers;
      session.remove(token);
    }
    // After dropdown questions the form was opened from that private message, so update it in place.
    return begin(i, panel, topic, buildDetails(i, topic, panel, answers), Boolean(token) && i.isFromMessage());
  },

  // ---- dropdown questions: one menu per question, then Continue ----
  async qsel(i, [token, n]) {
    const data = session.get(token, i.user.id);
    const found = data ? loadTopic(data.topicId) : null;
    if (!found) return i.update({ content: 'This form expired. Please open the panel again.', embeds: [], components: [] });
    const { choices } = topicsLib.splitQuestions(found.topic, found.panel);
    data.answers[n] = Number(i.values[0]);
    return i.update({
      embeds: [ui.questionEmbed(found.topic.label, choices, data.answers)],
      components: ui.questionSelects(token, choices, data.answers),
    });
  },
  async qgo(i, [token]) {
    const data = session.get(token, i.user.id);
    const found = data ? loadTopic(data.topicId) : null;
    if (!found) return i.update({ content: 'This form expired. Please open the panel again.', embeds: [], components: [] });
    const { topic, panel } = found;
    const { choices, texts } = topicsLib.splitQuestions(topic, panel);
    if (!choices.every((_, n) => data.answers[n] !== undefined)) {
      return i.reply({ embeds: [ui.fail('Please answer every question first.')], flags: EPH });
    }
    if (texts.length) return i.showModal(ui.topicModal(topic, texts.map((t) => t.label), token));
    session.remove(token);
    return begin(i, panel, topic, buildDetails(i, topic, panel, data.answers), true);
  },

  // Panels posted by v1.0 use these older ids; they keep working after the upgrade.
  async open(i, [panelId]) {
    const panel = q.getPanel.get(Number(panelId));
    const topic = panel ? topicsLib.forPanel(panel.id)[0] : null;
    return topic ? choose(i, panel, topic) : gone(i);
  },
  async form(i, [panelId]) {
    return routes.open(i, [panelId]);
  },
  async select(i, [panelId]) {
    const panel = q.getPanel.get(Number(panelId));
    const topic = panel ? topicsLib.forPanel(panel.id)[Number(i.values[0])] : null;
    return topic ? choose(i, panel, topic) : gone(i);
  },

  // ---- knowledge base prompt shown before a ticket is created ----
  async kbgo(i, [token]) {
    const data = knowledge.take(token, i.user.id);
    const found = data ? loadTopic(data.topicId) : null;
    if (!found) {
      return i.update({
        content: 'This prompt expired. Please open the panel again.',
        embeds: [],
        components: [],
      });
    }
    return open(i, found.panel, found.topic, data.details, true);
  },
  async kbdone(i, [token]) {
    knowledge.take(token, i.user.id);
    return i.update({ content: 'Glad we could help! 🎉', embeds: [], components: [] });
  },
  kbadd: (i) => commands.get('articles').submitArticle(i),

  // ---- inside a ticket ----
  claim: (i) => actions.claim(i),
  async close(i) {
    const ticket = q.ticketByChannel.get(i.channelId);
    if (!ticket) return i.reply({ embeds: [ui.fail('This ticket no longer exists.')], flags: EPH });
    if (ticket.status === 'closed') {
      return i.reply({ embeds: [ui.fail('This ticket is already closed.')], flags: EPH });
    }
    if (i.user.id !== ticket.owner_id && !tickets.isStaff(i, ticket.staff_role_id)) {
      return i.reply({
        embeds: [ui.fail('Only the ticket owner or staff can close this ticket.')],
        flags: EPH,
      });
    }
    return i.showModal(ui.closeModal());
  },
  closesub: (i) => actions.close(i, i.fields.getTextInputValue('reason').trim()),
  reopen: (i) => actions.reopen(i),
  delete: (i) => actions.remove(i),
  crq: (i, [answer]) => actions.closeRequestAnswer(i, answer),

  // ---- applications ----
  app: (i, [decision]) => (decision === 'accept' ? actions.appAccept(i) : actions.appDenyPrompt(i)),
  appdeny: (i) => actions.appDenySubmit(i),

  // ---- ratings (these arrive in DMs, so there is no server on the interaction) ----
  rate: (i, args) => survey.rate(i, args),
  ratesub: (i, args) => survey.rateSubmit(i, args),

  // ---- /setup dashboard ----
  su: (i, args) => setup.route(i, args),

  // ---- /panel delete confirmation: tk:pdel:<yes|no>:<userId>:<panelId> ----
  pdel: (i, args) => commands.get('panel').confirmDelete(i, args),

  // ---- /purge confirmation: tk:purge:<yes|no>:<userId>:<scope> ----
  purge: (i, [answer, userId, scope]) => actions.purgeConfirm(i, answer, userId, scope),
};

async function reportError(i, err) {
  console.error(`[interaction ${i.commandName ?? i.customId}]`, err);
  if (i.isAutocomplete()) return;
  const embeds = [ui.fail('Something went wrong. Please try again.')];
  try {
    if (i.deferred && !i.replied) await i.editReply({ embeds, components: [] });
    else if (i.replied) await i.followUp({ embeds, flags: EPH });
    else await i.reply({ embeds, flags: EPH });
  } catch {
    /* the interaction expired; nothing else to do */
  }
}

async function handleInteraction(i) {
  try {
    if (i.isAutocomplete()) {
      return await commands.get(i.commandName)?.autocomplete?.(i);
    }
    if (i.isChatInputCommand()) {
      return await commands.get(i.commandName)?.execute(i);
    }
    if (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) {
      const [namespace, action, ...args] = i.customId.split(':');
      if (namespace !== 'tk') return;
      return await routes[action]?.(i, args);
    }
  } catch (err) {
    await reportError(i, err);
  }
}

module.exports = { handleInteraction };
