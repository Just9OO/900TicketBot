// /panel: create, list, delete, export, import and tune panels, and manage their topics.
// For a guided, visual way to do the same, use /setup.
const {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
} = require('discord.js');
const { q } = require('../db');
const { colors } = require('../config');
const ui = require('../ui');
const topicsLib = require('../topics');
const panels = require('../panels');
const setup = require('../setup');
const autocomplete = require('../autocomplete');
const topicCommands = require('../topicCommands');

const EPH = MessageFlags.Ephemeral;
const DEFAULT_CATEGORIES = ['General Support', 'Billing', 'Report a Member', 'Other'];
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const IMPORT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
const IMPORT_MAX_BYTES = 100_000;

const panelOption = (o) =>
  o.setName('panel').setDescription('Which panel').setRequired(true).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Create, list, delete, export and import ticket panels (Manage Server)')
  .setDefaultMemberPermissions(P.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Post a ticket panel with its first topics (or use /setup for a guided screen)')
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('How members open a ticket')
          .setRequired(true)
          .addChoices(
            { name: 'Click only - a button opens a ticket', value: 'click' },
            { name: 'Form - a button that opens a form to fill in', value: 'form' },
            { name: 'Sidebar - a dropdown menu of categories', value: 'sidebar' },
          ),
      )
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Channel to post the panel in').addChannelTypes(...TEXT_TYPES).setRequired(true),
      )
      .addRoleOption((o) => o.setName('staff_role').setDescription('Role that can see and manage tickets').setRequired(true))
      .addStringOption((o) =>
        o.setName('message').setDescription('Text of the panel embed (type \\n for a new line)').setRequired(true).setMaxLength(3500),
      )
      .addStringOption((o) =>
        o.setName('ticket_message').setDescription('Embed text shown inside every new ticket (type \\n for a new line)').setMaxLength(3500),
      )
      .addBooleanOption((o) => o.setName('claim_button').setDescription('Show a Claim button for staff inside tickets (default: on)'))
      .addChannelOption((o) =>
        o.setName('transcript_channel').setDescription('Send a transcript (and ratings) here when a ticket is closed').addChannelTypes(...TEXT_TYPES),
      )
      .addChannelOption((o) =>
        o.setName('category').setDescription('One shared category to create ticket channels in').addChannelTypes(ChannelType.GuildCategory),
      )
      .addBooleanOption((o) =>
        o.setName('create_categories').setDescription('Create a private Discord category for each button or dropdown option'),
      )
      .addStringOption((o) => o.setName('title').setDescription('Panel embed title').setMaxLength(256))
      .addStringOption((o) => o.setName('color').setDescription('Panel embed color as hex, e.g. #5865F2').setMaxLength(7))
      .addStringOption((o) => o.setName('image').setDescription('Banner image link for the panel').setMaxLength(500))
      .addStringOption((o) => o.setName('footer').setDescription('Small text under the panel, e.g. "We reply within 1 hour"').setMaxLength(200))
      .addStringOption((o) => o.setName('label').setDescription('Button text for the first topic (default: Open a Ticket)').setMaxLength(80))
      .addStringOption((o) =>
        o.setName('categories').setDescription('Sidebar type: comma-separated dropdown options (max 25)').setMaxLength(1000),
      )
      .addIntegerOption((o) =>
        o.setName('max_tickets').setDescription('Open tickets allowed per member in each topic (default: 1)').setMinValue(1).setMaxValue(10),
      )
      .addBooleanOption((o) => o.setName('survey').setDescription('DM members a star rating after close; needs a transcript channel (default: on)'))
      .addBooleanOption((o) => o.setName('form').setDescription('Open a form before the ticket is created, even on click or sidebar panels'))
      .addStringOption((o) =>
        o
          .setName('questions')
          .setDescription('Form questions separated by | (max 5). Add [A, B, C] after one to make it a dropdown')
          .setMaxLength(400),
      )
      .addStringOption((o) =>
        o
          .setName('help_articles')
          .setDescription('When to show knowledge-base articles (default: inside the ticket)')
          .addChoices(
            { name: 'Inside the new ticket', value: 'inside' },
            { name: 'Before the ticket is created', value: 'before' },
            { name: 'Never', value: 'off' },
          ),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show every panel in this server'))
  .addSubcommand((sub) => sub.setName('delete').setDescription('Delete a panel and its message').addIntegerOption(panelOption))
  .addSubcommand((sub) =>
    sub
      .setName('questions')
      .setDescription('Turn a panel\'s form on or off and set its questions')
      .addIntegerOption(panelOption)
      .addBooleanOption((o) => o.setName('enabled').setDescription('Open a form when members click'))
      .addStringOption((o) =>
        o
          .setName('questions')
          .setDescription('Questions separated by | (max 5). [A, B] after one makes a dropdown. "none" resets')
          .setMaxLength(400),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('export').setDescription('Download a panel as a template file you can import anywhere').addIntegerOption(panelOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('import')
      .setDescription('Create a panel from a template file made with /panel export')
      .addAttachmentOption((o) => o.setName('file').setDescription('The .json template').setRequired(true))
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Channel to post the panel in').addChannelTypes(...TEXT_TYPES).setRequired(true),
      )
      .addRoleOption((o) => o.setName('staff_role').setDescription('Role that can see and manage tickets').setRequired(true))
      .addChannelOption((o) =>
        o.setName('transcript_channel').setDescription('Where transcripts and ratings go').addChannelTypes(...TEXT_TYPES),
      )
      .addChannelOption((o) =>
        o.setName('category').setDescription('One shared category for ticket channels').addChannelTypes(ChannelType.GuildCategory),
      )
      .addBooleanOption((o) => o.setName('create_categories').setDescription('Create a private category per topic')),
  )
  .addSubcommandGroup((group) =>
    topicCommands.addSubcommands(group.setName('topic').setDescription('Manage the buttons or dropdown entries of a panel')),
  );

const newlines = (text) => text.replace(/\\n/g, '\n');
const reply = (i, embed) => i.editReply({ embeds: [embed] });
const loadPanel = (i, raw) => {
  const panel = q.getPanel.get(raw);
  return panel?.guild_id === i.guildId ? panel : null;
};

function parseColor(raw) {
  if (!raw) return { color: null };
  if (!/^#?[0-9a-f]{6}$/i.test(raw)) return { error: 'Color must be a hex code like `#5865F2`.' };
  return { color: parseInt(raw.replace('#', ''), 16) };
}

// ---------- create ----------
async function create(i) {
  const type = i.options.getString('type', true);
  const channel = i.options.getChannel('channel', true);
  const staffRole = i.options.getRole('staff_role', true);
  const transcriptChannel = i.options.getChannel('transcript_channel');
  const category = i.options.getChannel('category');

  const { color, error: colorError } = parseColor(i.options.getString('color'));
  if (colorError) return reply(i, ui.fail(colorError));

  let labels;
  if (type === 'sidebar') {
    const raw = i.options.getString('categories');
    labels = (raw ? raw.split(',') : DEFAULT_CATEGORIES).map((s) => s.trim()).filter(Boolean).slice(0, topicsLib.MAX_TOPICS);
    if (!labels.length) return reply(i, ui.fail('Give at least one dropdown option.'));
  } else {
    labels = [i.options.getString('label')?.trim() || 'Open a Ticket'];
  }

  let questions = null;
  const rawQuestions = i.options.getString('questions');
  if (rawQuestions) {
    const parsed = topicsLib.parseQuestions(rawQuestions);
    if (parsed.error) return reply(i, ui.fail(parsed.error));
    questions = parsed.questions.length ? parsed.questions : null;
  }

  const createCategories = Boolean(i.options.getBoolean('create_categories'));
  if (createCategories && category) {
    return reply(i, ui.fail('Pick either `category` (one shared category) or `create_categories` (one per option), not both.'));
  }

  const result = await panels.createPanel(
    i.client,
    i.guild,
    channel,
    {
      type,
      staffRoleId: staffRole.id,
      claim: i.options.getBoolean('claim_button') ?? true,
      transcriptChannelId: transcriptChannel?.id ?? null,
      categoryId: category?.id ?? null,
      createCategories,
      ticketMessage: newlines(i.options.getString('ticket_message') ?? ''),
      maxTickets: i.options.getInteger('max_tickets') ?? 1,
      survey: i.options.getBoolean('survey') ?? true,
      kbMode: i.options.getString('help_articles') ?? 'inside',
      formEnabled: Boolean(i.options.getBoolean('form')),
      questions,
      title: i.options.getString('title'),
      description: newlines(i.options.getString('message', true)),
      color,
      imageUrl: i.options.getString('image'),
      footer: i.options.getString('footer'),
      showList: true,
      topics: labels.map((label) => ({ label, kind: 'ticket' })),
    },
    i.user.id,
  );
  if (result.error) return reply(i, ui.fail(result.error));
  return reply(
    i,
    ui.ok(
      `Panel **#${result.panelId}** posted in <#${channel.id}>.\n` +
        (result.categories ? `Created ${result.categories} private categor${result.categories === 1 ? 'y' : 'ies'}.\n` : '') +
        'Change anything later with `/setup`, or add buttons with `/panel topic add`.',
    ),
  );
}

// ---------- list / delete ----------
async function list(i) {
  const rows = q.panelsByGuild.all(i.guildId);
  if (!rows.length) return reply(i, ui.info('No panels yet. Create one with `/setup` or `/panel create`.'));
  const lines = rows.map((p) => {
    const topics = topicsLib.forPanel(p.id);
    const form = p.type === 'form' || p.form_enabled ? ' · 📝 form' : '';
    return `**#${p.id}** ${ui.trunc(p.title || 'Untitled panel', 40)}  ·  <#${p.channel_id}>  ·  ${p.type}${form}\n└ ${topics.length} topic${topics.length === 1 ? '' : 's'}: ${ui.trunc(topics.map((t) => t.label).join(', '), 120)}`;
  });
  return i.editReply({
    embeds: [
      new EmbedBuilder().setColor(colors.primary).setTitle(`🎫 Panels (${rows.length})`).setDescription(ui.trunc(lines.join('\n\n'), 4000)).setFooter({ text: 'Edit any of them with /setup' }),
    ],
  });
}

async function remove(i) {
  const panel = loadPanel(i, i.options.getInteger('panel', true));
  if (!panel) return reply(i, ui.fail('I could not find that panel in this server.'));
  return i.editReply({
    embeds: [
      ui.warn(
        `Delete panel **#${panel.id}** in <#${panel.channel_id}>? Its message and topics are removed. ` +
          'Tickets that are already open keep working.',
      ),
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: 'Delete', custom_id: ui.id('pdel', 'yes', i.user.id, panel.id) },
          { type: 2, style: 2, label: 'Cancel', custom_id: ui.id('pdel', 'no', i.user.id, panel.id) },
        ],
      },
    ],
  });
}

/** Delete / Cancel button: tk:pdel:<yes|no>:<userId>:<panelId> */
async function confirmDelete(i, [answer, userId, panelId]) {
  if (i.user.id !== userId) return i.reply({ embeds: [ui.fail('Only the person who ran this command can confirm it.')], flags: EPH });
  if (!i.memberPermissions.has(P.ManageGuild)) return i.reply({ embeds: [ui.fail('You need the **Manage Server** permission.')], flags: EPH });
  if (answer !== 'yes') return i.update({ embeds: [ui.info('Cancelled. The panel was not deleted.')], components: [] });

  const panel = loadPanel(i, Number(panelId));
  if (!panel) return i.update({ embeds: [ui.fail('That panel no longer exists.')], components: [] });
  await i.deferUpdate();
  const { messageDeleted } = await panels.deletePanel(i.client, panel, i.user.id);
  return i.editReply({
    embeds: [ui.ok(`Panel **#${panel.id}** deleted.${messageDeleted ? '' : ' I could not remove its message, so you may want to delete it by hand.'}`)],
    components: [],
  });
}

// ---------- form ----------
async function form(i) {
  const panel = loadPanel(i, i.options.getInteger('panel', true));
  if (!panel) return reply(i, ui.fail('I could not find that panel in this server.'));

  let enabled = Boolean(panel.form_enabled);
  let questions = panel.questions;
  const given = i.options.getBoolean('enabled');
  if (given !== null) enabled = given;

  const raw = i.options.getString('questions')?.trim();
  if (raw) {
    if (raw.toLowerCase() === 'none') questions = null;
    else {
      const parsed = topicsLib.parseQuestions(raw);
      if (parsed.error) return reply(i, ui.fail(parsed.error));
      questions = parsed.questions.length ? JSON.stringify(parsed.questions) : null;
      enabled = given ?? true; // writing questions means you want the form
    }
  }
  q.setPanelForm.run(enabled ? 1 : 0, questions, panel.id);

  const list = topicsLib.questionsOf(null, { questions }).map(topicsLib.parseQuestion);
  const always = panel.type === 'form' ? '\nThis is a `form` panel, so it always opens a form.' : '';
  return reply(
    i,
    ui.ok(
      `Panel **#${panel.id}**: form ${enabled || panel.type === 'form' ? '**on**' : '**off**'}.\n` +
        (list.length
          ? `Questions:\n${list.map((x, n) => `${n + 1}. ${x.label}${x.options ? ` (dropdown: ${x.options.join(', ')})` : ''}`).join('\n')}`
          : 'Questions: the default form (Subject and How can we help?).') +
        '\nTopics with their own questions keep them.' + always,
    ),
  );
}

// ---------- export / import ----------
async function exportCmd(i) {
  const panel = loadPanel(i, i.options.getInteger('panel', true));
  if (!panel) return reply(i, ui.fail('I could not find that panel in this server.'));
  // Panels posted by v1.x never stored their text; the template needs it, so read it from the message.
  let source = panel;
  if (!panel.description) {
    const draft = await setup.draftFromPanel(i.client, i.user.id, panel);
    source = { ...panel, title: draft.title || null, description: draft.description || null, color: draft.color, image_url: draft.imageUrl || null, footer: draft.footer || null };
  }
  if (!source.description) return reply(i, ui.fail('That panel has no text I can export. Open it with `/setup`, write its text, and try again.'));

  const body = JSON.stringify(panels.exportPanel(source, topicsLib.forPanel(panel.id)), null, 2);
  return i.editReply({
    embeds: [ui.ok(`Template for panel **#${panel.id}**. Roles, channels and categories are not included, so it works in any server. Import it with \`/panel import\`.`)],
    files: [new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: `panel-${panel.id}.json` })],
  });
}

async function importCmd(i) {
  const file = i.options.getAttachment('file', true);
  if (!file.name?.toLowerCase().endsWith('.json')) return reply(i, ui.fail('Please attach the `.json` file made by `/panel export`.'));
  if (file.size > IMPORT_MAX_BYTES) return reply(i, ui.fail('That file is too large to be a panel template.'));
  let host;
  try {
    host = new URL(file.url).hostname;
  } catch {
    host = '';
  }
  if (!IMPORT_HOSTS.includes(host)) return reply(i, ui.fail('I can only read files uploaded to Discord.'));

  let parsed;
  try {
    const response = await fetch(file.url);
    const text = await response.text();
    if (text.length > IMPORT_MAX_BYTES) throw new Error('too large');
    parsed = JSON.parse(text);
  } catch {
    return reply(i, ui.fail('I could not read that file as JSON.'));
  }

  const { spec, error } = panels.importTemplate(parsed);
  if (error) return reply(i, ui.fail(error));

  const category = i.options.getChannel('category');
  const createCategories = Boolean(i.options.getBoolean('create_categories'));
  if (createCategories && category) return reply(i, ui.fail('Pick either `category` or `create_categories`, not both.'));

  const channel = i.options.getChannel('channel', true);
  const result = await panels.createPanel(
    i.client,
    i.guild,
    channel,
    {
      ...spec,
      staffRoleId: i.options.getRole('staff_role', true).id,
      transcriptChannelId: i.options.getChannel('transcript_channel')?.id ?? null,
      categoryId: category?.id ?? null,
      createCategories,
    },
    i.user.id,
  );
  if (result.error) return reply(i, ui.fail(result.error));
  return reply(i, ui.ok(`Imported as panel **#${result.panelId}** in <#${channel.id}> with ${spec.topics.length} topic(s).${spec.droppedImage ? ' Its banner was not hosted by Discord, so it was left out.' : ''} Fine-tune it with \`/setup\`.`));
}

const handlers = { create, list, delete: remove, questions: form, export: exportCmd, import: importCmd };

module.exports = {
  data,
  confirmDelete,
  async execute(i) {
    // Server owners can change a command's default permissions, so enforce it here too.
    if (!i.memberPermissions.has(P.ManageGuild)) {
      return i.reply({ embeds: [ui.fail('You need the **Manage Server** permission.')], flags: EPH });
    }
    await i.deferReply({ flags: EPH });
    if (i.options.getSubcommandGroup(false) === 'topic') return topicCommands.execute(i);
    return handlers[i.options.getSubcommand()](i);
  },
  autocomplete(i) {
    if (i.options.getSubcommandGroup(false) === 'topic') return topicCommands.autocomplete(i);
    return autocomplete.panels(i);
  },
};
