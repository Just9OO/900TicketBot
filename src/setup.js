// The /setup dashboard: build or edit a panel from one private screen with pickers, toggles and
// forms, and a live preview of the panel message. State lives in memory (session.js) until Save.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits: P,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { q } = require('./db');
const { colors } = require('./config');
const ui = require('./ui');
const session = require('./session');
const topicsLib = require('./topics');
const panels = require('./panels');

const EPH = MessageFlags.Ephemeral;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const DEFAULT_SIDEBAR = ['General Support', 'Billing', 'Report a Member', 'Other'];
const id = (...parts) => ui.id('su', ...parts);

const TYPE_INFO = {
  click: ['Click', 'A button per topic. Opens a ticket straight away'],
  form: ['Form', 'A button per topic that asks questions first'],
  sidebar: ['Sidebar', 'One dropdown menu listing the topics'],
};

// ---------- drafts ----------
const newTopic = (label, extra = {}) => ({
  label, emoji: null, description: null, kind: 'ticket', questions: null, button_style: null,
  ticket_message: null, max_tickets: null, ...extra,
});

function blankDraft(userId, guildId) {
  return {
    userId, guildId, mode: 'new', panelId: null, page: 'main', selected: 0,
    channelId: null, type: 'click', staffRoleId: null, transcriptChannelId: null, categoryId: null,
    createCategories: false, title: '', description: '', ticketMessage: '', color: null, imageUrl: '',
    footer: '', showList: true, claim: true, survey: true, kbMode: 'inside', formEnabled: false,
    questions: null, maxTickets: 1, topics: [newTopic('Open a Ticket')],
  };
}

/** A draft holding what an existing panel looks like now. */
async function draftFromPanel(client, userId, panel) {
  let { title, description, color, image_url: imageUrl, footer } = panel;
  if (!description && panel.message_id) {
    // Panels posted by v1.x did not store their text; read it back from the message itself.
    try {
      const channel = await client.channels.fetch(panel.channel_id);
      const embed = (await channel.messages.fetch(panel.message_id)).embeds[0];
      title = embed?.title ?? title;
      description = embed?.description ?? description;
      color = embed?.color ?? color;
      imageUrl = embed?.image?.url ?? imageUrl;
      footer = embed?.footer?.text ?? footer;
    } catch {
      /* the message is gone; the owner can write new text */
    }
  }
  return {
    userId, guildId: panel.guild_id, mode: 'edit', panelId: panel.id, page: 'main', selected: 0,
    channelId: panel.channel_id, type: panel.type, staffRoleId: panel.staff_role_id,
    transcriptChannelId: panel.transcript_channel_id, categoryId: panel.category_id, createCategories: false,
    title: title ?? '', description: description ?? '', ticketMessage: panel.ticket_message ?? '',
    color: color ?? null, imageUrl: imageUrl ?? '', footer: footer ?? '', showList: panel.show_list !== 0,
    claim: Boolean(panel.claim_enabled), survey: Boolean(panel.survey_enabled), kbMode: panel.kb_mode,
    formEnabled: Boolean(panel.form_enabled), questions: panels.asList(panel.questions), maxTickets: panel.max_tickets,
    topics: topicsLib.forPanel(panel.id),
  };
}

const toSpec = (d) => ({
  type: d.type, staffRoleId: d.staffRoleId, claim: d.claim, transcriptChannelId: d.transcriptChannelId,
  categoryId: d.categoryId, createCategories: d.createCategories, ticketMessage: d.ticketMessage,
  maxTickets: d.maxTickets, survey: d.survey, kbMode: d.kbMode, formEnabled: d.formEnabled,
  questions: d.questions, title: d.title, description: d.description, color: d.color,
  imageUrl: d.imageUrl, footer: d.footer, showList: d.showList, topics: d.topics,
});

// ---------- screens ----------
function homeScreen(guildId) {
  const rows = q.panelsByGuild.all(guildId).slice(-25).reverse();
  const lines = rows.map((p) => {
    const n = topicsLib.forPanel(p.id).length;
    return `**#${p.id}** ${ui.trunc(p.title || 'Untitled panel', 40)}  ·  ${TYPE_INFO[p.type]?.[0] ?? p.type}  ·  <#${p.channel_id}>  ·  ${n} topic${n === 1 ? '' : 's'}`;
  });
  const embed = new EmbedBuilder()
    .setColor(colors.primary)
    .setTitle('🎛️ Ticket setup')
    .setDescription(
      rows.length
        ? `${ui.trunc(lines.join('\n'), 3000)}\n\n➕ **New panel** builds another one.\n📂 The menu below edits the look, questions and topics of an existing panel.`
        : 'No panels yet.\n\nPress **New panel** to build your first one. You pick the channel and staff role, write the text, and see a live preview before anything is posted.',
    )
    .setFooter({ text: 'Only you can see this screen. It closes itself after 30 minutes of no activity.' });
  const components = [];
  if (rows.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(id('pick'))
          .setPlaceholder('📂 Edit an existing panel…')
          .addOptions(
            rows.map((p) => ({
              label: ui.trunc(`Panel #${p.id} - ${p.type}${p.title ? ` - ${p.title}` : ''}`, 100),
              description: ui.trunc(
                topicsLib.forPanel(p.id).map((t) => t.label).join(', '), 100),
              value: String(p.id),
            })),
          ),
      ),
    );
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(id('new')).setLabel('New panel').setEmoji('➕').setStyle(ButtonStyle.Success),
    ),
  );
  return { embeds: [embed], components };
}

const yes = (v) => (v ? 'on' : 'off');

function summaryEmbed(d) {
  const questions = panels.asList(d.questions) ?? [];
  const crumbs = [['main', 'Main'], ['settings', 'Settings'], ['topics', 'Topics']]
    .map(([page, label]) => (page === d.page ? `**${label}**` : label))
    .join('  ›  ');
  const missing = [!d.staffRoleId && 'a staff role', d.mode === 'new' && !d.channelId && 'a channel to post in'].filter(Boolean);
  const embed = new EmbedBuilder()
    .setColor(missing.length ? colors.warn : colors.neutral)
    .setTitle(d.mode === 'new' ? '🆕 New panel' : `✏️ Editing panel #${d.panelId}`)
    .setDescription(`${crumbs}${missing.length ? `\n⚠️ Still needed: ${missing.join(' and ')}.` : '\n✅ Ready. Press the green button when you are happy with the preview.'}`)
    .addFields(
      { name: '🏷️ Type', value: TYPE_INFO[d.type][0], inline: true },
      { name: '🛡️ Staff role', value: d.staffRoleId ? `<@&${d.staffRoleId}>` : '*not set*', inline: true },
      { name: '📣 Posts in', value: d.channelId ? `<#${d.channelId}>` : '*not set*', inline: true },
      { name: '📄 Transcripts', value: d.transcriptChannelId ? `<#${d.transcriptChannelId}>` : 'none', inline: true },
      {
        name: '📁 Tickets go in',
        value: d.categoryId ? `<#${d.categoryId}>` : d.createCategories ? 'a new category per topic' : 'next to the panel',
        inline: true,
      },
      { name: '🙋 Claim · ⭐ Ratings', value: `${yes(d.claim)} · ${yes(d.survey)}`, inline: true },
      { name: '📚 Help articles', value: d.kbMode, inline: true },
      {
        name: '📝 Form',
        value: d.type === 'form' || d.formEnabled || questions.length ? `on${questions.length ? `, ${questions.length} question(s)` : ''}` : 'off',
        inline: true,
      },
      { name: '🔢 Ticket limit', value: `${d.maxTickets} per member`, inline: true },
    );
  const lines = d.topics.map((t, n) => {
    const own = panels.asList(t.questions)?.length;
    return `${n === d.selected && d.page === 'topics' ? '▶ ' : '• '}${t.emoji ?? ''} **${ui.trunc(t.label, 60)}**${t.kind === 'application' ? ' (application)' : ''}${own ? ` · ${own} question(s)` : ''}`;
  });
  embed.addFields({ name: `📑 Topics (${d.topics.length})`, value: ui.trunc(lines.join('\n'), 1000) });
  return embed;
}

function mainRows(d) {
  const rows = [];
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(id('type', d.token))
        .setPlaceholder('🏷️ Panel type')
        .addOptions(
          Object.entries(TYPE_INFO).map(([value, [label, description]]) =>
            new StringSelectMenuOptionBuilder().setLabel(label).setValue(value).setDescription(description).setDefault(d.type === value),
          ),
        ),
    ),
  );
  const role = new RoleSelectMenuBuilder().setCustomId(id('role', d.token)).setPlaceholder('🛡️ Staff role (who can see tickets)').setMinValues(1).setMaxValues(1);
  if (d.staffRoleId) role.setDefaultRoles(d.staffRoleId);
  rows.push(new ActionRowBuilder().addComponents(role));

  if (d.mode === 'new') {
    const channel = new ChannelSelectMenuBuilder()
      .setCustomId(id('chan', d.token)).setPlaceholder('📣 Channel to post the panel in')
      .setChannelTypes(TEXT_TYPES).setMinValues(1).setMaxValues(1);
    if (d.channelId) channel.setDefaultChannels(d.channelId);
    rows.push(new ActionRowBuilder().addComponents(channel));
  }
  const transcript = new ChannelSelectMenuBuilder()
    .setCustomId(id('tr', d.token)).setPlaceholder('📄 Transcript channel (optional)')
    .setChannelTypes(TEXT_TYPES).setMinValues(0).setMaxValues(1);
  if (d.transcriptChannelId) transcript.setDefaultChannels(d.transcriptChannelId);
  rows.push(new ActionRowBuilder().addComponents(transcript));

  rows.push(
    new ActionRowBuilder().addComponents(
      button('mo', d.token, 'text', 'Text & look', '✏️', ButtonStyle.Primary),
      button('nav', d.token, 'settings', 'Settings', '⚙️', ButtonStyle.Secondary),
      button('nav', d.token, 'topics', 'Topics', '📑', ButtonStyle.Secondary),
      saveButton(d),
      button('close', d.token, null, 'Close', '✖️', ButtonStyle.Secondary),
    ),
  );
  return rows;
}

function button(action, token, arg, label, emoji, style) {
  const b = new ButtonBuilder().setCustomId(arg ? id(action, token, arg) : id(action, token)).setLabel(label).setStyle(style);
  return emoji ? b.setEmoji(emoji) : b;
}
const saveButton = (d) => button('save', d.token, null, d.mode === 'new' ? 'Post panel' : 'Save changes', '✅', ButtonStyle.Success);

function toggle(d, key, label, value) {
  return button('tog', d.token, key, `${label}: ${yes(value)}`, null, value ? ButtonStyle.Success : ButtonStyle.Secondary);
}

function settingsRows(d) {
  const kb = new StringSelectMenuBuilder()
    .setCustomId(id('kb', d.token)).setPlaceholder('📚 When to show help articles')
    .addOptions(
      [['inside', 'Inside the new ticket'], ['before', 'Before the ticket is created'], ['off', 'Never']].map(([value, label]) =>
        new StringSelectMenuOptionBuilder().setLabel(label).setValue(value).setDefault(d.kbMode === value),
      ),
    );
  const category = new ChannelSelectMenuBuilder()
    .setCustomId(id('cat', d.token)).setPlaceholder('📁 One shared category for tickets (optional)')
    .setChannelTypes([ChannelType.GuildCategory]).setMinValues(0).setMaxValues(1);
  if (d.categoryId) category.setDefaultChannels(d.categoryId);

  return [
    new ActionRowBuilder().addComponents(
      toggle(d, 'claim', 'Claim button', d.claim),
      toggle(d, 'survey', 'Ratings', d.survey),
      toggle(d, 'form', 'Form', d.formEnabled || d.type === 'form'),
      toggle(d, 'cats', d.mode === 'new' ? 'Category per topic' : 'Make missing categories', d.createCategories),
      toggle(d, 'list', 'Topic list on panel', d.showList),
    ),
    new ActionRowBuilder().addComponents(kb),
    new ActionRowBuilder().addComponents(category),
    new ActionRowBuilder().addComponents(
      button('mo', d.token, 'limits', 'Form & limits', '📝', ButtonStyle.Primary),
      button('nav', d.token, 'main', 'Back', '⬅️', ButtonStyle.Secondary),
      saveButton(d),
    ),
  ];
}

function topicsRows(d) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(id('tsel', d.token)).setPlaceholder('📑 Pick a topic to edit')
    .addOptions(
      d.topics.map((t, n) => {
        const option = new StringSelectMenuOptionBuilder().setLabel(ui.trunc(t.label, 100)).setValue(String(n)).setDefault(n === d.selected);
        if (t.description) option.setDescription(ui.trunc(t.description, 100));
        return option;
      }),
    );
  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      button('mo', d.token, 'topic', 'Edit', '✏️', ButtonStyle.Primary),
      button('mo', d.token, 'add', 'Add topic', '➕', ButtonStyle.Success),
      button('tdel', d.token, null, 'Remove', '🗑️', ButtonStyle.Danger),
      button('tup', d.token, null, 'Up', '⬆️', ButtonStyle.Secondary),
      button('tdn', d.token, null, 'Down', '⬇️', ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      button('tkind', d.token, null, `Kind: ${d.topics[d.selected]?.kind ?? 'ticket'}`, '📋', ButtonStyle.Secondary),
      button('nav', d.token, 'main', 'Back', '⬅️', ButtonStyle.Secondary),
      saveButton(d),
    ),
  ];
}

/** The editor: the panel preview, a summary of the settings, and the controls of the current page. */
function editorScreen(d, notice = null) {
  const preview = ui.panelEmbed(
    {
      title: d.title, color: d.color, image_url: d.imageUrl, footer: d.footer,
      description: ui.trunc(d.description, 1200) || '*No text yet. Press Text & look to write what members will read.*',
      show_list: d.showList ? 1 : 0,
    },
    d.topics,
    2800, // the preview, the summary and a notice must fit one message (6000 characters)
  );
  const components = d.page === 'settings' ? settingsRows(d) : d.page === 'topics' ? topicsRows(d) : mainRows(d);
  return { embeds: [...(notice ? [notice] : []), preview, summaryEmbed(d)], components, content: null };
}

// ---------- modals ----------
function input(customId, label, style, { value, required = false, max = 100, placeholder } = {}) {
  const field = new TextInputBuilder().setCustomId(customId).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
  if (value) field.setValue(String(value).slice(0, max));
  if (placeholder) field.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(field);
}
const Short = TextInputStyle.Short;
const Long = TextInputStyle.Paragraph;

function textModal(d) {
  return new ModalBuilder().setCustomId(id('ms', d.token, 'text')).setTitle('Text & look').addComponents(
    input('title', 'Title', Short, { value: d.title, max: 256, placeholder: 'Open a Ticket' }),
    input('description', 'Panel text (what members read)', Long, { value: d.description, required: true, max: 3500 }),
    input('ticket_message', 'Message shown inside each new ticket', Long, { value: d.ticketMessage, max: 3500 }),
    input('image', 'Banner image link (optional)', Short, { value: d.imageUrl, max: 500, placeholder: 'https://...' }),
    input('footer', 'Footer, e.g. "We reply within 1 hour"', Short, { value: d.footer, max: 200 }),
  );
}

function limitsModal(d) {
  return new ModalBuilder().setCustomId(id('ms', d.token, 'limits')).setTitle('Form & limits').addComponents(
    input('questions', 'Form questions (one per line)', Long, {
      value: (panels.asList(d.questions) ?? []).join('\n'), max: 400,
      placeholder: 'What do you need help with?\nPlatform? [PC, Console, Mobile]',
    }),
    input('max', 'Open tickets per member (1-10)', Short, { value: d.maxTickets, max: 2, required: true }),
    input('color', 'Panel color, hex like #5865F2', Short, { value: d.color === null ? '' : `#${d.color.toString(16).padStart(6, '0')}`, max: 7 }),
  );
}

function topicModal(d, token, topic, isNew) {
  const styleName = { primary: 'blue', secondary: 'gray', success: 'green', danger: 'red' }[topic?.button_style] ?? '';
  return new ModalBuilder().setCustomId(id('ms', token, isNew ? 'add' : 'topic')).setTitle(isNew ? 'Add a topic' : 'Edit topic').addComponents(
    input('label', 'Button or dropdown text', Short, { value: topic?.label, required: true, max: 80 }),
    input('emoji', 'Emoji (optional)', Short, { value: topic?.emoji, max: 64 }),
    input('description', 'Short description (shown on the panel)', Short, { value: topic?.description, max: 100 }),
    input('questions', 'Questions (one per line, own form)', Long, {
      value: (panels.asList(topic?.questions) ?? []).join('\n'), max: 400,
      placeholder: 'Order number?\nWhat went wrong?',
    }),
    input('style', 'Button color: blue, gray, green or red', Short, { value: styleName, max: 8 }),
  );
}

// ---------- handlers ----------
const fail = (text) => ui.fail(text);

function expired(i) {
  const payload = { embeds: [fail('This editor expired. Run `/setup` again.')], components: [], flags: EPH };
  return i.isModalSubmit() && !i.isFromMessage() ? i.reply(payload) : i.update({ ...payload, flags: undefined });
}

async function start(i) {
  if (!i.memberPermissions.has(P.ManageGuild)) {
    return i.reply({ embeds: [fail('You need the **Manage Server** permission.')], flags: EPH });
  }
  return i.reply({ ...homeScreen(i.guildId), flags: EPH });
}

/** Applies a modal's text to the draft. Returns an error string, or null when it worked. */
function applyModal(d, which, i, index) {
  const get = (name) => i.fields.getTextInputValue(name).trim();

  if (which === 'text') {
    const image = get('image');
    if (image && !ui.isHttpUrl(image)) return 'The banner image must be a link starting with http:// or https://.';
    Object.assign(d, { title: get('title'), description: get('description'), ticketMessage: get('ticket_message'), imageUrl: image, footer: get('footer') });
    return null;
  }

  if (which === 'limits') {
    const max = Number(get('max'));
    if (!Number.isInteger(max) || max < 1 || max > 10) return 'The ticket limit must be a whole number from 1 to 10.';
    const rawColor = get('color');
    if (rawColor && !/^#?[0-9a-f]{6}$/i.test(rawColor)) return 'The color must be a hex code like `#5865F2`.';
    const parsed = topicsLib.parseQuestions(get('questions'));
    if (parsed.error) return parsed.error;
    d.maxTickets = max;
    d.color = rawColor ? parseInt(rawColor.replace('#', ''), 16) : null;
    d.questions = parsed.questions.length ? parsed.questions : null;
    if (d.questions) d.formEnabled = true;
    return null;
  }

  // a topic: 'add' or 'topic' (edit the selected one)
  const label = get('label');
  if (!label) return 'The topic needs a label.';
  const emoji = get('emoji');
  if (emoji && !topicsLib.isEmoji(emoji)) return 'That is not an emoji. Use a normal emoji like 🎫.';
  const style = topicsLib.normalizeStyle(get('style'));
  if (style === undefined) return 'The button color must be blue, gray, green or red.';
  const parsed = topicsLib.parseQuestions(get('questions'));
  if (parsed.error) return parsed.error;

  const target = which === 'add' ? newTopic(label) : d.topics[index];
  if (!target) return 'That topic no longer exists.';
  if (target.kind === 'application' && !parsed.questions.length) return 'An application needs at least one question.';
  Object.assign(target, {
    label, emoji: emoji || null, description: get('description') || null, button_style: style,
    questions: parsed.questions.length ? JSON.stringify(parsed.questions) : null,
  });
  if (which === 'add') {
    if (d.topics.length >= topicsLib.MAX_TOPICS) return `A panel can have at most ${topicsLib.MAX_TOPICS} topics.`;
    d.topics.push(target);
    d.selected = d.topics.length - 1;
  }
  return null;
}

async function save(i, d, token) {
  await i.deferUpdate();
  const spec = toSpec(d);
  let result;
  if (d.mode === 'new') {
    const channel = d.channelId ? i.guild.channels.cache.get(d.channelId) : null;
    if (!channel) return i.editReply(editorScreen(d, fail('Pick the channel to post the panel in first.')));
    result = await panels.createPanel(i.client, i.guild, channel, spec, i.user.id);
  } else {
    const panel = q.getPanel.get(d.panelId);
    if (panel?.guild_id !== i.guildId) return i.editReply({ embeds: [fail('That panel no longer exists.')], components: [] });
    result = await panels.updatePanel(i.client, i.guild, panel, spec, i.user.id);
  }
  if (result.error) return i.editReply(editorScreen(d, fail(result.error)));

  session.remove(token);
  const made = result.categories ? `\nCreated ${result.categories} private categor${result.categories === 1 ? 'y' : 'ies'}.` : '';
  const text =
    d.mode === 'new'
      ? `Panel **#${result.panelId}** posted in <#${d.channelId}>.${made}\nRun \`/setup\` any time to change it.`
      : `Panel **#${d.panelId}** saved.${made}${result.refreshed ? '' : '\n⚠️ I could not update the panel message. Check that it still exists.'}`;
  return i.editReply({ embeds: [ui.ok(text)], components: [] });
}

async function route(i, [action, token, ...rest]) {
  if (!i.memberPermissions?.has(P.ManageGuild)) {
    return i.reply({ embeds: [fail('You need the **Manage Server** permission.')], flags: EPH });
  }

  // Home screen: no draft yet.
  if (action === 'new' || action === 'pick') {
    let draft;
    if (action === 'new') draft = blankDraft(i.user.id, i.guildId);
    else {
      const panel = q.getPanel.get(Number(i.values[0]));
      if (panel?.guild_id !== i.guildId) return i.update({ embeds: [fail('That panel no longer exists.')], components: [] });
      await i.deferUpdate();
      draft = await draftFromPanel(i.client, i.user.id, panel);
      draft.token = session.create(i.user.id, draft);
      return i.editReply(editorScreen(draft));
    }
    draft.token = session.create(i.user.id, draft);
    return i.update(editorScreen(draft));
  }

  const d = session.get(token, i.user.id);
  if (!d || d.guildId !== i.guildId) return expired(i);
  d.token = token;

  const redraw = (notice) => i.update(editorScreen(d, notice));

  switch (action) {
    case 'type': {
      d.type = i.values[0];
      const onlyDefault = d.mode === 'new' && d.topics.length === 1 && d.topics[0].label === 'Open a Ticket';
      if (d.type === 'sidebar' && onlyDefault) d.topics = DEFAULT_SIDEBAR.map((label) => newTopic(label));
      return redraw();
    }
    case 'role':
      if (i.values[0] === i.guildId) return redraw(fail('The staff role cannot be @everyone. Pick the role your staff have.'));
      d.staffRoleId = i.values[0];
      return redraw();
    case 'chan': d.channelId = i.values[0]; return redraw();
    case 'tr': d.transcriptChannelId = i.values[0] ?? null; return redraw();
    case 'cat': d.categoryId = i.values[0] ?? null; if (d.categoryId) d.createCategories = false; return redraw();
    case 'kb': d.kbMode = i.values[0]; return redraw();
    case 'nav': d.page = rest[0]; return redraw();
    case 'tog': {
      const key = rest[0];
      if (key === 'claim') d.claim = !d.claim;
      else if (key === 'survey') d.survey = !d.survey;
      else if (key === 'list') d.showList = !d.showList;
      else if (key === 'form') d.formEnabled = !(d.formEnabled || d.type === 'form') ;
      else if (key === 'cats') {
        d.createCategories = !d.createCategories;
        if (d.createCategories) d.categoryId = null;
      }
      return redraw();
    }
    case 'tsel': d.selected = Number(i.values[0]); return redraw();
    case 'tup':
    case 'tdn': {
      const to = d.selected + (action === 'tup' ? -1 : 1);
      if (to >= 0 && to < d.topics.length) {
        [d.topics[d.selected], d.topics[to]] = [d.topics[to], d.topics[d.selected]];
        d.selected = to;
      }
      return redraw();
    }
    case 'tkind': {
      // A topic is either a normal ticket or an application that staff accept or deny.
      const topic = d.topics[d.selected];
      if (!topic) return redraw();
      if (topic.kind === 'application') topic.kind = 'ticket';
      else if (!panels.asList(topic.questions)?.length) {
        return redraw(fail('An application needs at least one question. Press Edit and add some first.'));
      } else topic.kind = 'application';
      return redraw();
    }
    case 'tdel': {
      if (d.topics.length <= 1) return redraw(fail('A panel needs at least one topic.'));
      d.topics.splice(d.selected, 1);
      d.selected = Math.min(d.selected, d.topics.length - 1);
      return redraw();
    }
    case 'mo': {
      const which = rest[0];
      if (which === 'text') return i.showModal(textModal(d));
      if (which === 'limits') return i.showModal(limitsModal(d));
      if (which === 'add') return i.showModal(topicModal(d, token, null, true));
      return i.showModal(topicModal(d, token, d.topics[d.selected], false));
    }
    case 'ms': {
      const error = applyModal(d, rest[0], i, d.selected);
      if (error) return i.reply({ embeds: [fail(error)], flags: EPH });
      return redraw();
    }
    case 'save': return save(i, d, token);
    case 'close':
      session.remove(token);
      return i.update({ embeds: [ui.info('Closed. Nothing was changed.')], components: [] });
    default: return null;
  }
}

module.exports = { start, route, homeScreen, draftFromPanel };
