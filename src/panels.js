// Creating, updating, deleting, exporting and importing panels. The slash commands, the /setup
// dashboard and the JSON import all go through here, so they behave the same.
const { PermissionFlagsBits: P } = require('discord.js');
const { db, q } = require('./db');
const ui = require('./ui');
const topicsLib = require('./topics');
const tickets = require('./tickets');
const log = require('./log');

const nowSec = () => Math.floor(Date.now() / 1000);
const KB_MODES = ['inside', 'before', 'off'];
const PANEL_TYPES = ['click', 'form', 'sidebar'];

/** Template banners must be hosted by Discord, so a shared template cannot make your panel load a stranger's server. */
const onDiscordCdn = (url) => {
  try {
    return ['cdn.discordapp.com', 'media.discordapp.net'].includes(new URL(String(url)).hostname);
  } catch {
    return false;
  }
};

/**
 * A panel described in plain values:
 *   { type, staffRoleId, claim, transcriptChannelId, categoryId, createCategories,
 *     ticketMessage, maxTickets, survey, kbMode, formEnabled, questions (array|null),
 *     title, description, color (int|null), imageUrl, footer, showList,
 *     topics: [{ id?, label, emoji, description, kind, questions (array|null), button_style, ... }] }
 */
function validate(spec) {
  if (!PANEL_TYPES.includes(spec.type)) return 'The panel type must be click, form or sidebar.';
  if (!spec.description?.trim()) return 'The panel needs some text. Use **Text & look** to write it.';
  if (spec.description.length > 3500) return 'The panel text is too long (3500 characters at most).';
  if ((spec.title?.length ?? 0) > 256) return 'The panel title is too long (256 characters at most).';
  if ((spec.footer?.length ?? 0) > 200) return 'The panel footer is too long (200 characters at most).';
  if (spec.imageUrl && !ui.isHttpUrl(spec.imageUrl)) return 'The banner image must be a link starting with http:// or https://.';
  if (!spec.staffRoleId) return 'Pick a staff role first.';
  if (!KB_MODES.includes(spec.kbMode)) return 'Help articles must be inside, before or off.';
  if (!Array.isArray(spec.topics) || !spec.topics.length) return 'A panel needs at least one topic.';
  if (spec.topics.length > topicsLib.MAX_TOPICS) return `A panel can have at most ${topicsLib.MAX_TOPICS} topics.`;

  const check = (value) => {
    const list = asList(value);
    return list?.length ? topicsLib.parseQuestions(list.join('|')).error ?? null : null;
  };
  const panelError = check(spec.questions);
  if (panelError) return panelError;
  for (const topic of spec.topics) {
    if (!topic.label?.trim()) return 'Every topic needs a label.';
    if (topic.label.length > 80) return `The topic label "${topic.label.slice(0, 30)}..." is too long (80 characters at most).`;
    if (topic.emoji && !topicsLib.isEmoji(topic.emoji)) return `"${topic.emoji}" is not an emoji (topic ${topic.label}).`;
    const error = check(topic.questions);
    if (error) return `${topic.label}: ${error}`;
    if (topic.kind === 'application' && !asList(topic.questions)?.length) {
      return `The application topic "${topic.label}" needs at least one question.`;
    }
  }
  return null;
}

/** @everyone as the staff role would show every ticket to the whole server. */
const everyoneProblem = (guild, spec) =>
  spec.staffRoleId === guild.id || spec.topics.some((t) => t.staff_role_id === guild.id)
    ? 'The staff role cannot be @everyone. Pick the role your staff have.'
    : null;

const json = (list) => (list?.length ? JSON.stringify(list) : null);

function panelRow(spec) {
  return {
    type: spec.type,
    staff_role_id: spec.staffRoleId,
    claim_enabled: spec.claim ? 1 : 0,
    transcript_channel_id: spec.transcriptChannelId ?? null,
    category_id: spec.categoryId ?? null,
    ticket_message: spec.ticketMessage?.trim() || null,
    max_tickets: spec.maxTickets ?? 1,
    survey_enabled: spec.survey ? 1 : 0,
    kb_mode: spec.kbMode,
    form_enabled: spec.formEnabled || asList(spec.questions)?.length ? 1 : 0,
    questions: typeof spec.questions === 'string' ? spec.questions : json(spec.questions),
    title: spec.title?.trim() || null,
    description: spec.description.trim(),
    color: spec.color ?? null,
    image_url: spec.imageUrl?.trim() || null,
    footer: spec.footer?.trim() || null,
    show_list: spec.showList ? 1 : 0,
  };
}

function topicRow(topic, extra) {
  return topicsLib.newTopic({
    ...topic,
    label: topic.label.trim(),
    emoji: topic.emoji?.trim() || null,
    description: topic.description?.trim() || null,
    questions: typeof topic.questions === 'string' ? topic.questions : json(topic.questions),
    ...extra,
  });
}

/** Questions on a topic row are stored as JSON text; accept either form when copying a row. */
const asList = (value) => (typeof value === 'string' ? JSON.parse(value) : value ?? null);

async function permissionProblem(guild, me, { channel, transcriptChannelId }) {
  if (!me.permissions.has(P.ManageChannels)) return 'I need the **Manage Channels** permission to create ticket channels.';
  const needs = [P.ViewChannel, P.SendMessages, P.EmbedLinks];
  if (channel && !channel.permissionsFor(me).has(needs)) {
    return `I cannot send embeds in <#${channel.id}>. I need View Channel, Send Messages and Embed Links there.`;
  }
  if (transcriptChannelId) {
    const transcript = guild.channels.cache.get(transcriptChannelId);
    if (transcript && !transcript.permissionsFor(me).has([...needs, P.AttachFiles])) {
      return `I cannot send files in <#${transcript.id}>. I need View Channel, Send Messages, Embed Links and Attach Files there.`;
    }
  }
  return null;
}

/** Private categories for the topics that do not have one yet. Returns the categories it made. */
async function makeCategories(guild, me, spec) {
  const made = [];
  try {
    for (const topic of spec.topics) {
      if (topic.category_id) continue;
      const category = await tickets.createTopicCategory(guild, topic.label, topic.staff_role_id ?? spec.staffRoleId, me.id);
      topic.category_id = category.id;
      made.push(category);
    }
  } catch (err) {
    console.error('[panels] could not create categories:', err.message);
    await Promise.all(made.map((c) => c.delete('Panel setup failed').catch(() => {})));
    for (const topic of spec.topics) if (made.some((c) => c.id === topic.category_id)) topic.category_id = null;
    return {
      error:
        'I could not create the categories. The server may be at its channel limit (50 categories), or I am ' +
        'missing **Manage Channels**. Nothing was created.',
    };
  }
  return { made };
}

/** Posts a new panel. Returns { panelId, categories } or { error }. */
async function createPanel(client, guild, channel, spec, byUserId) {
  const error = validate(spec) ?? everyoneProblem(guild, spec);
  if (error) return { error };
  const me = await guild.members.fetchMe();
  const problem = await permissionProblem(guild, me, { channel, transcriptChannelId: spec.transcriptChannelId });
  if (problem) return { error: problem };

  let made = [];
  if (spec.createCategories && !spec.categoryId) {
    const result = await makeCategories(guild, me, spec);
    if (result.error) return result;
    made = result.made;
  }

  const create = db.transaction(() => {
    const inserted = q.insertPanel.run({
      ...panelRow(spec),
      guild_id: guild.id,
      channel_id: channel.id,
      options: null,
      created_at: nowSec(),
    });
    const id = Number(inserted.lastInsertRowid);
    spec.topics.forEach((topic, position) =>
      q.insertTopic.run(topicRow(topic, { panel_id: id, position, id: undefined })),
    );
    return id;
  });
  const panelId = create();
  const panel = q.getPanel.get(panelId);

  try {
    const message = await channel.send(ui.panelMessage(panel, topicsLib.forPanel(panelId)));
    q.setPanelMessage.run(message.id, panelId);
  } catch (err) {
    console.error('[panels] could not post the panel:', err);
    db.transaction(() => {
      q.deleteTopicsByPanel.run(panelId);
      q.deletePanel.run(panelId);
    })();
    await Promise.all(made.map((c) => c.delete('Panel setup failed').catch(() => {})));
    return { error: `I could not post the panel in <#${channel.id}>.` };
  }

  log.event(client, guild.id, {
    title: `Panel #${panelId} created`,
    color: 0x57f287,
    fields: [{ name: 'By', value: `<@${byUserId}>` }, { name: 'Channel', value: `<#${channel.id}>` }, { name: 'Type', value: spec.type }],
  });
  return { panelId, categories: made.length };
}

/** Saves changes to a posted panel and refreshes its message. Returns { categories, refreshed } or { error }. */
async function updatePanel(client, guild, panel, spec, byUserId) {
  const error = validate(spec) ?? everyoneProblem(guild, spec);
  if (error) return { error };
  const me = await guild.members.fetchMe();
  const problem = await permissionProblem(guild, me, { channel: null, transcriptChannelId: spec.transcriptChannelId });
  if (problem) return { error: problem };

  let made = [];
  if (spec.createCategories) {
    const result = await makeCategories(guild, me, spec);
    if (result.error) return result;
    made = result.made;
  }

  const save = db.transaction(() => {
    q.updatePanel.run({ ...panelRow(spec), id: panel.id });
    const keep = new Set(spec.topics.filter((t) => t.id).map((t) => t.id));
    for (const old of q.topicsByPanel.all(panel.id)) {
      if (keep.has(old.id)) continue;
      q.deleteTopic.run(old.id);
      q.kbUnlinkTopic.run(old.id);
    }
    spec.topics.forEach((topic, position) => {
      if (topic.id) {
        const existing = q.getTopic.get(topic.id);
        q.updateTopic.run({ ...existing, ...topicRow(topic), id: topic.id, position, panel_id: panel.id });
      } else {
        q.insertTopic.run(topicRow(topic, { panel_id: panel.id, position }));
      }
    });
  });
  save();

  const refreshed = await tickets.refreshPanel(client, q.getPanel.get(panel.id));
  log.event(client, guild.id, {
    title: `Panel #${panel.id} edited`,
    color: 0x5865f2,
    fields: [{ name: 'By', value: `<@${byUserId}>` }, { name: 'Channel', value: `<#${panel.channel_id}>` }],
  });
  return { categories: made.length, refreshed };
}

/** Removes a panel, its topics and (when it still exists) the panel message. Tickets are untouched. */
async function deletePanel(client, panel, byUserId) {
  const topics = q.topicsByPanel.all(panel.id);
  db.transaction(() => {
    for (const t of topics) q.kbUnlinkTopic.run(t.id);
    q.deleteTopicsByPanel.run(panel.id);
    q.deletePanel.run(panel.id);
  })();

  let messageDeleted = false;
  if (panel.message_id) {
    try {
      const channel = await client.channels.fetch(panel.channel_id);
      await channel.messages.delete(panel.message_id);
      messageDeleted = true;
    } catch {
      /* the message or channel is already gone */
    }
  }
  log.event(client, panel.guild_id, {
    title: `Panel #${panel.id} deleted`,
    color: 0xed4245,
    fields: [{ name: 'By', value: `<@${byUserId}>` }, { name: 'Topics removed', value: String(topics.length) }],
  });
  return { messageDeleted };
}

/** A panel as a portable template: nothing that only makes sense in one server (roles, channels, ids). */
function exportPanel(panel, topics) {
  const list = (text) => {
    const parsed = topicsLib.questionsOf({ questions: text });
    return parsed.length ? parsed : null;
  };
  return {
    format: 'ticket-panel',
    version: 1,
    type: panel.type,
    title: panel.title,
    description: panel.description,
    ticket_message: panel.ticket_message,
    color: panel.color === null || panel.color === undefined ? null : `#${panel.color.toString(16).padStart(6, '0')}`,
    image_url: panel.image_url,
    footer: panel.footer,
    claim_button: Boolean(panel.claim_enabled),
    survey: Boolean(panel.survey_enabled),
    help_articles: panel.kb_mode,
    form: Boolean(panel.form_enabled),
    questions: list(panel.questions),
    max_tickets: panel.max_tickets,
    show_topic_list: panel.show_list !== 0,
    topics: topics.map((t) => ({
      label: t.label,
      emoji: t.emoji && !t.emoji.startsWith('<') ? t.emoji : null,
      description: t.description,
      kind: t.kind,
      questions: list(t.questions),
      ticket_message: t.ticket_message,
      max_tickets: t.max_tickets,
      button_style: t.button_style,
    })),
  };
}

const isText = (v, max) => typeof v === 'string' && v.length <= max;
const optText = (v, max) => v === undefined || v === null || isText(v, max);

/**
 * Turns an imported template into the plain values createPanel wants, checking every field
 * (the file comes from outside, so nothing is trusted). Returns { spec } or { error }.
 */
function importTemplate(data) {
  const bad = (text) => ({ error: `This is not a valid panel template: ${text}` });
  if (!data || typeof data !== 'object' || data.format !== 'ticket-panel') return bad('it is not a ticket panel export.');
  if (data.version !== 1) return bad(`unsupported version ${data.version}.`);
  if (!PANEL_TYPES.includes(data.type)) return bad('unknown panel type.');
  if (!isText(data.description, 3500)) return bad('missing panel text.');
  if (!optText(data.title, 256) || !optText(data.ticket_message, 3500) || !optText(data.footer, 200) || !optText(data.image_url, 500)) {
    return bad('a text field is too long.');
  }
  if (!Array.isArray(data.topics) || !data.topics.length || data.topics.length > topicsLib.MAX_TOPICS) return bad('it needs 1 to 25 topics.');

  let color = null;
  if (data.color !== null && data.color !== undefined) {
    if (typeof data.color !== 'string' || !/^#?[0-9a-f]{6}$/i.test(data.color)) return bad('the color must be a hex code.');
    color = parseInt(data.color.replace('#', ''), 16);
  }
  const questionList = (value) => {
    if (value === null || value === undefined) return { list: null };
    if (!Array.isArray(value) || value.length > topicsLib.MAX_QUESTIONS || value.some((x) => !isText(x, 400))) return { error: true };
    return { list: value.map((x) => x.trim()).filter(Boolean) };
  };

  const questions = questionList(data.questions);
  if (questions.error) return bad('the form questions are invalid.');

  const topics = [];
  for (const t of data.topics) {
    if (!t || typeof t !== 'object' || !isText(t.label, 80) || !t.label.trim()) return bad('a topic has no label.');
    if (!optText(t.emoji, 64) || !optText(t.description, 100) || !optText(t.ticket_message, 3500)) return bad(`topic "${t.label}" has a field that is too long.`);
    if (t.kind !== undefined && !['ticket', 'application'].includes(t.kind)) return bad(`topic "${t.label}" has an unknown kind.`);
    const qs = questionList(t.questions);
    if (qs.error) return bad(`topic "${t.label}" has invalid questions.`);
    const style = topicsLib.normalizeStyle(t.button_style);
    if (style === undefined) return bad(`topic "${t.label}" has an unknown button color.`);
    const max = Number.isInteger(t.max_tickets) && t.max_tickets >= 1 && t.max_tickets <= 10 ? t.max_tickets : null;
    topics.push({
      label: t.label,
      emoji: t.emoji && topicsLib.isEmoji(t.emoji) && !t.emoji.startsWith('<') ? t.emoji : null,
      description: t.description ?? null,
      kind: t.kind ?? 'ticket',
      questions: qs.list,
      ticket_message: t.ticket_message ?? null,
      max_tickets: max,
      button_style: style,
    });
  }

  return {
    spec: {
      type: data.type,
      title: data.title ?? null,
      description: data.description,
      ticketMessage: data.ticket_message ?? null,
      color,
      imageUrl: onDiscordCdn(data.image_url) ? data.image_url : null,
      droppedImage: Boolean(data.image_url) && !onDiscordCdn(data.image_url),
      footer: data.footer ?? null,
      claim: data.claim_button !== false,
      survey: data.survey !== false,
      kbMode: KB_MODES.includes(data.help_articles) ? data.help_articles : 'inside',
      formEnabled: data.form === true,
      questions: questions.list,
      maxTickets: Number.isInteger(data.max_tickets) && data.max_tickets >= 1 && data.max_tickets <= 10 ? data.max_tickets : 1,
      showList: data.show_topic_list !== false,
      topics,
    },
  };
}

module.exports = {
  validate,
  createPanel,
  updatePanel,
  deletePanel,
  exportPanel,
  importTemplate,
  asList,
  PANEL_TYPES,
  KB_MODES,
};
