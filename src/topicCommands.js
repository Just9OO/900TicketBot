// /panel topic ...: manage the buttons or dropdown entries of a panel. Anything left empty on a topic
// uses the panel's setting, so you only fill in what differs.
const {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits: P,
} = require('discord.js');
const { db, q } = require('./db');
const { colors } = require('./config');
const ui = require('./ui');
const topicsLib = require('./topics');
const tickets = require('./tickets');
const autocomplete = require('./autocomplete');

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const EPH = MessageFlags.Ephemeral;

// Options shared by add and edit. `hint` is appended where "none" can clear a value.
function settings(sub, { clearable }) {
  const none = clearable ? ' (type none to clear)' : '';
  return sub
    .addStringOption((o) =>
      o
        .setName('kind')
        .setDescription('A normal ticket, or an application staff accept or deny')
        .addChoices(
          { name: 'Ticket', value: 'ticket' },
          { name: 'Application (form, then accept / deny)', value: 'application' },
        ),
    )
    .addStringOption((o) =>
      o.setName('emoji').setDescription(`Emoji on the button or dropdown entry${none}`).setMaxLength(64),
    )
    .addStringOption((o) =>
      o.setName('description').setDescription(`Small text under a dropdown entry${none}`).setMaxLength(100),
    )
    .addRoleOption((o) =>
      o.setName('staff_role').setDescription('Staff role for this topic (default: the panel\'s)'),
    )
    .addChannelOption((o) =>
      o
        .setName('discord_category')
        .setDescription('Discord category to create these tickets in (default: the panel\'s)')
        .addChannelTypes(ChannelType.GuildCategory),
    )
    .addChannelOption((o) =>
      o
        .setName('transcript_channel')
        .setDescription('Where transcripts and ratings go (default: the panel\'s)')
        .addChannelTypes(...TEXT_TYPES),
    )
    .addIntegerOption((o) =>
      o
        .setName('max_tickets')
        .setDescription('Open tickets per member for this topic (default: the panel\'s)')
        .setMinValue(1)
        .setMaxValue(10),
    )
    .addStringOption((o) =>
      o
        .setName('ticket_message')
        .setDescription('Embed text shown inside these tickets (type \\n for a new line)')
        .setMaxLength(3500),
    )
    .addStringOption((o) =>
      o
        .setName('questions')
        .setDescription(`Form questions, separated by | (max 5, 45 characters each)${none}`)
        .setMaxLength(400),
    )
    .addStringOption((o) =>
      o
        .setName('button_color')
        .setDescription('Color of the button (ignored in dropdowns)')
        .addChoices(
          { name: 'Blue', value: 'primary' },
          { name: 'Gray', value: 'secondary' },
          { name: 'Green', value: 'success' },
          { name: 'Red', value: 'danger' },
        ),
    )
    .addBooleanOption((o) =>
      o.setName('create_category').setDescription('Create a new private Discord category for this topic'),
    )
    .addRoleOption((o) =>
      o.setName('accept_role').setDescription('Applications: role given to accepted applicants'),
    );
}

const panelOption = (o) =>
  o.setName('panel').setDescription('Which panel').setRequired(true).setAutocomplete(true);
const topicOption = (o) =>
  o.setName('topic').setDescription('Which topic').setRequired(true).setAutocomplete(true);

/** Adds the topic subcommands (add, edit, remove, list) to the `topic` group of /panel. */
const addSubcommands = (group) => group
  .addSubcommand((sub) =>
    settings(
      sub
        .setName('add')
        .setDescription('Add a button or dropdown entry to a panel')
        .addIntegerOption(panelOption)
        .addStringOption((o) =>
          o.setName('label').setDescription('Button or dropdown text').setRequired(true).setMaxLength(80),
        ),
      { clearable: false },
    ),
  )
  .addSubcommand((sub) =>
    settings(
      sub
        .setName('edit')
        .setDescription('Change a topic')
        .addIntegerOption(panelOption)
        .addIntegerOption(topicOption)
        .addStringOption((o) => o.setName('label').setDescription('New button or dropdown text').setMaxLength(80))
        .addBooleanOption((o) =>
          o
            .setName('reset')
            .setDescription('First clear this topic\'s role, category, transcript, limit and message overrides'),
        ),
      { clearable: true },
    ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a topic from a panel')
      .addIntegerOption(panelOption)
      .addIntegerOption(topicOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Show the topics of a panel, or of every panel')
      .addIntegerOption((o) =>
        o.setName('panel').setDescription('Only this panel').setAutocomplete(true),
      ),
  );

const reply = (i, embed) => i.editReply({ embeds: [embed] });

function loadPanel(i, raw) {
  const panel = q.getPanel.get(raw);
  return panel?.guild_id === i.guildId ? panel : null;
}

/** undefined = option not given, null = "none" (clear), otherwise the trimmed text. */
function text(i, name) {
  const raw = i.options.getString(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  return value.toLowerCase() === 'none' || value === '' ? null : value;
}

/** Applies the options of /topic add or edit on top of `base`. Returns { topic } or { error }. */
async function build(i, base, me, panel) {
  const t = { ...base };

  if (i.options.getBoolean('reset')) {
    Object.assign(t, {
      staff_role_id: null,
      category_id: null,
      transcript_channel_id: null,
      max_tickets: null,
      ticket_message: null,
      accept_role_id: null,
    });
  }

  const label = i.options.getString('label');
  if (label !== null) t.label = label.trim();
  if (!t.label) return { error: 'The label cannot be empty.' };

  const kind = i.options.getString('kind');
  if (kind) t.kind = kind;

  const emoji = text(i, 'emoji');
  if (emoji !== undefined) {
    if (emoji !== null && !topicsLib.isEmoji(emoji)) {
      return { error: 'That is not an emoji. Use a normal emoji like 🎫, or a custom one like `<:name:123456789012345678>`.' };
    }
    t.emoji = emoji;
  }

  const description = text(i, 'description');
  if (description !== undefined) t.description = description;

  const message = text(i, 'ticket_message');
  if (message !== undefined) t.ticket_message = message?.replace(/\\n/g, '\n') ?? null;

  const questions = text(i, 'questions');
  if (questions !== undefined) {
    if (questions === null) t.questions = null;
    else {
      const parsed = topicsLib.parseQuestions(questions);
      if (parsed.error) return { error: parsed.error };
      t.questions = parsed.questions.length ? JSON.stringify(parsed.questions) : null;
    }
  }

  const buttonColor = i.options.getString('button_color');
  if (buttonColor) t.button_style = buttonColor;

  const staffRole = i.options.getRole('staff_role');
  if (staffRole) t.staff_role_id = staffRole.id;
  const category = i.options.getChannel('discord_category');
  if (category) t.category_id = category.id;
  if (i.options.getBoolean('create_category')) {
    if (category) return { error: 'Pick either `discord_category` or `create_category`, not both.' };
    try {
      const made = await tickets.createTopicCategory(
        i.guild,
        t.label,
        t.staff_role_id ?? panel.staff_role_id,
        me.id,
      );
      t.category_id = made.id;
    } catch (err) {
      console.error('[topic] could not create the category:', err.message);
      return { error: 'I could not create the category. Check my **Manage Channels** permission and the server channel limit.' };
    }
  }
  const maxTickets = i.options.getInteger('max_tickets');
  if (maxTickets !== null) t.max_tickets = maxTickets;
  const acceptRole = i.options.getRole('accept_role');
  if (acceptRole) t.accept_role_id = acceptRole.id;

  const transcript = i.options.getChannel('transcript_channel');
  if (transcript) {
    const needs = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles];
    if (!transcript.permissionsFor(me).has(needs)) {
      return {
        error: `I cannot send files in <#${transcript.id}>. I need View Channel, Send Messages, Embed Links and Attach Files there.`,
      };
    }
    t.transcript_channel_id = transcript.id;
  }

  if (t.kind === 'application' && !topicsLib.questionsOf(t).length) {
    return { error: 'An application needs at least one question. Add some with the `questions` option.' };
  }
  return { topic: t };
}

async function add(i) {
  const panel = loadPanel(i, i.options.getInteger('panel', true));
  if (!panel) return reply(i, ui.fail('I could not find that panel in this server.'));
  if (q.countTopics.get(panel.id).n >= topicsLib.MAX_TOPICS) {
    return reply(i, ui.fail(`A panel can have at most ${topicsLib.MAX_TOPICS} topics.`));
  }

  const me = await i.guild.members.fetchMe();
  const built = await build(
    i,
    topicsLib.newTopic({ panel_id: panel.id, position: q.nextTopicPosition.get(panel.id).next }),
    me,
    panel,
  );
  if (built.error) return reply(i, ui.fail(built.error));

  const result = q.insertTopic.run(built.topic);
  const refreshed = await tickets.refreshPanel(i.client, panel);
  return reply(
    i,
    ui.ok(
      `Added **${built.topic.label}** (topic #${Number(result.lastInsertRowid)}) to panel #${panel.id}.` +
        (refreshed ? '' : '\n⚠️ I could not update the panel message. Check it still exists.'),
    ),
  );
}

async function edit(i) {
  const panel = loadPanel(i, i.options.getInteger('panel', true));
  const topic = panel ? q.getTopic.get(i.options.getInteger('topic', true)) : null;
  if (!panel || topic?.panel_id !== panel.id) {
    return reply(i, ui.fail('I could not find that topic on that panel.'));
  }

  const me = await i.guild.members.fetchMe();
  const built = await build(i, topic, me, panel);
  if (built.error) return reply(i, ui.fail(built.error));

  q.updateTopic.run(built.topic);
  const refreshed = await tickets.refreshPanel(i.client, panel);
  return reply(
    i,
    ui.ok(
      `Updated **${built.topic.label}**.` +
        (refreshed ? '' : '\n⚠️ I could not update the panel message. Check it still exists.'),
    ),
  );
}

async function remove(i) {
  const panel = loadPanel(i, i.options.getInteger('panel', true));
  const topic = panel ? q.getTopic.get(i.options.getInteger('topic', true)) : null;
  if (!panel || topic?.panel_id !== panel.id) {
    return reply(i, ui.fail('I could not find that topic on that panel.'));
  }
  if (q.countTopics.get(panel.id).n <= 1) {
    return reply(i, ui.fail('A panel needs at least one topic. Add another before removing this one.'));
  }

  db.transaction(() => {
    q.deleteTopic.run(topic.id);
    q.kbUnlinkTopic.run(topic.id); // its help articles stay, just no longer tied to a topic
  })();
  await tickets.refreshPanel(i.client, panel);
  return reply(i, ui.ok(`Removed **${topic.label}** from panel #${panel.id}. Existing tickets are not affected.`));
}

function describe(t) {
  const bits = [t.kind === 'application' ? 'application' : 'ticket'];
  if (t.staff_role_id) bits.push(`staff <@&${t.staff_role_id}>`);
  if (t.category_id) bits.push(`category <#${t.category_id}>`);
  if (t.transcript_channel_id) bits.push(`transcripts <#${t.transcript_channel_id}>`);
  if (t.max_tickets) bits.push(`limit ${t.max_tickets}`);
  const questions = topicsLib.questionsOf(t).length;
  if (questions) bits.push(`${questions} question${questions === 1 ? '' : 's'}`);
  if (t.accept_role_id) bits.push(`accept <@&${t.accept_role_id}>`);
  return `**#${t.id}** ${t.emoji ?? ''} ${t.label}: ${bits.join(' · ')}`;
}

async function list(i) {
  const raw = i.options.getInteger('panel');
  const panels = raw === null ? q.panelsByGuild.all(i.guildId) : [loadPanel(i, raw)].filter(Boolean);
  if (!panels.length) {
    return reply(i, ui.info(raw === null ? 'No panels yet. Create one with `/setup`.' : 'I could not find that panel.'));
  }

  const lines = [];
  for (const panel of panels) {
    lines.push(`__Panel #${panel.id}__ in <#${panel.channel_id}> (${panel.type})`);
    for (const t of topicsLib.forPanel(panel.id)) lines.push(describe(t));
    lines.push('');
  }
  return i.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(colors.primary)
        .setTitle('📑 Ticket topics')
        .setDescription(ui.trunc(lines.join('\n'), 4000))
        .setFooter({ text: 'Empty settings use the panel\'s.' }),
    ],
  });
}

const handlers = { add, edit, remove, list };

module.exports = {
  addSubcommands,
  // /panel has already checked Manage Server and deferred the reply.
  execute: (i) => handlers[i.options.getSubcommand()](i),
  autocomplete(i) {
    const focused = i.options.getFocused(true).name;
    return focused === 'panel' ? autocomplete.panels(i) : autocomplete.topics(i);
  },
};
