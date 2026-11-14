const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { colors } = require('./config');

const DEFAULT_TICKET_TEXT =
  'Thanks for opening a ticket! A member of staff will be with you shortly.\n' +
  'Please describe your issue in as much detail as you can.';
const DEFAULT_APPLICATION_TEXT =
  'Thanks for applying! Your answers are below. A member of staff will review them shortly.';

const pad = (n) => String(n).padStart(4, '0');
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Builds a namespaced custom id, e.g. id('t', 3) -> "tk:t:3". */
const id = (...parts) => ['tk', ...parts].join(':');
const stars = (n) => '⭐'.repeat(n) + '☆'.repeat(5 - n);
/** A bar like ▰▰▰▱▱ showing value out of max. */
const meter = (value, max, width = 10) => {
  const filled = max > 0 ? Math.round((Math.min(value, max) / max) * width) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
};
/** 95 -> "1m", 5400 -> "1h 30m", 200000 -> "2d 7h". */
function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : 'under a minute';
}
const kindName = (ticket) => (ticket.kind === 'application' ? 'Application' : 'Ticket');

// ---------- small status embeds ----------
const box = (color, description) => new EmbedBuilder().setColor(color).setDescription(description);
const ok = (text) => box(colors.success, `✅ ${text}`);
const fail = (text) => box(colors.danger, `❌ ${text}`);
const warn = (text) => box(colors.warn, `⚠️ ${text}`);
const info = (text) => box(colors.primary, text);

// ---------- panel ----------
const isHttpUrl = (text) => {
  try {
    return ['http:', 'https:'].includes(new URL(String(text)).protocol);
  } catch {
    return false;
  }
};

/**
 * The panel message: its text, banner and footer, plus a list of the topics that have a
 * description (so members can see what each button is for before they click).
 */
function panelEmbed(panel, topics = [], limit = 5600) {
  const embed = new EmbedBuilder()
    .setColor(panel.color ?? colors.primary)
    .setTitle(trunc(panel.title || 'Open a Ticket', 256))
    .setDescription(panel.description || '\u200b');
  if (panel.image_url && isHttpUrl(panel.image_url)) embed.setImage(panel.image_url);
  if (panel.footer) embed.setFooter({ text: trunc(panel.footer, 200) });

  if (panel.show_list !== 0) {
    let room = limit - (panel.title?.length ?? 12) - (panel.description?.length ?? 0) - (panel.footer?.length ?? 0);
    for (const t of topics.filter((x) => x.description)) {
      const name = trunc(`${t.emoji ? `${t.emoji} ` : ''}${t.label}`, 256);
      const value = trunc(t.description, 300);
      if (room < name.length + value.length) break;
      embed.addFields({ name, value });
      room -= name.length + value.length;
    }
  }
  return embed;
}

/** The embed and buttons or dropdown of a panel, ready to send or edit. */
const panelMessage = (panel, topics) => ({
  embeds: [panelEmbed(panel, topics)],
  components: panelComponents(panel, topics),
});

const STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

const defaultEmoji = (panel, topic) =>
  topic.kind === 'application' ? '📋' : panel.type === 'form' ? '📝' : '🎫';

/**
 * Turns "🎫" or "<:name:123456789012345678>" into the object form Discord's components take.
 * An object is accepted by every discord.js version, unlike a bare string on dropdown options.
 */
function emojiObject(text) {
  const raw = String(text).trim();
  const custom = /^<(a?):(\w{2,32}):(\d{17,20})>$/.exec(raw);
  return custom ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' } : { name: raw };
}

/**
 * A "sidebar" panel is one dropdown of its topics. Every other panel shows one button per topic
 * (up to 25), so a panel with several topics is a multi-panel with no extra setup.
 */
function panelComponents(panel, topics) {
  if (panel.type === 'sidebar') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(id('tsel', panel.id))
      .setPlaceholder('🎫 Choose a topic to open a ticket…')
      .addOptions(
        topics.map((t) => {
          const option = new StringSelectMenuOptionBuilder()
            .setLabel(trunc(t.label, 100))
            .setValue(String(t.id));
          if (t.description) option.setDescription(trunc(t.description, 100));
          if (t.emoji) option.setEmoji(emojiObject(t.emoji));
          return option;
        }),
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }

  const buttons = topics.map((t) =>
    new ButtonBuilder()
      .setCustomId(id('t', t.id))
      .setLabel(trunc(t.label, 80))
      .setEmoji(emojiObject(t.emoji || defaultEmoji(panel, t)))
      .setStyle(STYLES[t.button_style] ?? (t.kind === 'application' ? ButtonStyle.Success : ButtonStyle.Primary)),
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

/** The form shown before a ticket or application is created. */
function topicModal(topic, questions, token = null) {
  const modal = new ModalBuilder()
    .setCustomId(token ? id('tf', topic.id, token) : id('tf', topic.id))
    .setTitle(trunc(topic.label, 45));
  const input = (customId, label, style, max) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(trunc(label, 45))
        .setStyle(style)
        .setRequired(true)
        .setMaxLength(max),
    );

  if (questions.length) {
    // 900 characters x 5 answers still fits inside one embed (6000 characters in total).
    modal.addComponents(
      ...questions.map((question, index) =>
        input(`q${index}`, question, TextInputStyle.Paragraph, 900),
      ),
    );
  } else {
    modal.addComponents(
      input('subject', 'Subject', TextInputStyle.Short, 100),
      input('details', 'How can we help?', TextInputStyle.Paragraph, 1000),
    );
  }
  return modal;
}

// ---------- dropdown questions (shown before the text form) ----------
function questionEmbed(topicLabel, choices, answers) {
  const done = choices.filter((c, n) => answers[n] !== undefined).length;
  return new EmbedBuilder()
    .setColor(done === choices.length ? colors.success : colors.primary)
    .setTitle(`📝 ${trunc(topicLabel, 190)}`)
    .setDescription('Pick an answer in each menu below, then press **Continue**.')
    .addFields(
      choices.map((c, n) => ({
        name: trunc(c.label, 256),
        value: answers[n] === undefined ? '⬜ *not answered yet*' : `✅ ${trunc(c.options[answers[n]], 1000)}`,
      })),
    )
    .setFooter({ text: `${done} of ${choices.length} answered` });
}

function questionSelects(token, choices, answers) {
  const rows = choices.map((c, n) =>
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(id('qsel', token, n))
        .setPlaceholder(trunc(c.label, 150))
        .addOptions(
          c.options.map((option, index) => ({
            label: trunc(option, 100),
            value: String(index),
            default: answers[n] === index,
          })),
        ),
    ),
  );
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(id('qgo', token)).setLabel('Continue').setEmoji('➡️').setStyle(ButtonStyle.Success),
    ),
  );
  return rows;
}

// ---------- inside a ticket ----------
/** The one-line state shown on the ticket's welcome message. It is edited as the ticket changes. */
function statusText(ticket) {
  if (ticket.status === 'closed') return '🔴 **Closed**';
  if (ticket.kind === 'application') {
    if (ticket.app_status === 'accepted') return '🟢 **Accepted**';
    if (ticket.app_status === 'denied') return '🔴 **Denied**';
    return '🟡 **Waiting for review**';
  }
  return ticket.claimed_by ? `🟢 **Claimed** by <@${ticket.claimed_by}>` : '🔵 **Open**, waiting for staff';
}

function statusColor(ticket) {
  if (ticket.status === 'closed' || ticket.app_status === 'denied') return colors.danger;
  if (ticket.claimed_by || ticket.app_status === 'accepted') return colors.success;
  if (ticket.kind === 'application') return colors.warn;
  return colors.primary;
}

/** Updates the Status field and colour of a welcome embed in place (adds the field to old tickets). */
const PRIORITIES = { low: '🟢 Low', high: '🟠 **High**', urgent: '🔴 **Urgent**' };
/** Text for a ticket's priority, or null when it is normal. */
const priorityText = (ticket) => PRIORITIES[ticket.priority] ?? null;

/** A row with one link button that jumps to a channel. */
const ticketLink = (guildId, channelId, label) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(label)
      .setEmoji('🎫')
      .setURL(`https://discord.com/channels/${guildId}/${channelId}`),
  );

/** Brings the Status and Priority fields (and the colour) of a welcome embed up to date. */
function applyStatus(embed, ticket) {
  const status = embed.data.fields?.find((f) => f.name === 'Status');
  if (status) status.value = statusText(ticket);
  else embed.spliceFields(1, 0, { name: 'Status', value: statusText(ticket), inline: true });

  const level = priorityText(ticket);
  const at = (embed.data.fields ?? []).findIndex((f) => f.name === 'Priority');
  if (level && at >= 0) embed.data.fields[at].value = level;
  else if (level) embed.spliceFields(2, 0, { name: 'Priority', value: level, inline: true });
  else if (at >= 0) embed.spliceFields(at, 1);
  return embed.setColor(statusColor(ticket));
}

function welcomeEmbed(ticket, { text, fields = [], owner = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(colors.primary)
    .setTitle(`${ticket.kind === 'application' ? '📋' : '🎫'} ${kindName(ticket)} #${pad(ticket.number)}`)
    .setDescription(
      text || (ticket.kind === 'application' ? DEFAULT_APPLICATION_TEXT : DEFAULT_TICKET_TEXT),
    )
    .setColor(statusColor(ticket))
    .addFields(
      { name: 'Opened by', value: `<@${ticket.owner_id}>`, inline: true },
      { name: 'Status', value: statusText(ticket), inline: true },
    );

  if (ticket.subject) {
    embed.addFields({ name: 'Topic', value: trunc(ticket.subject, 1024), inline: true });
  }
  if (ticket.created_at) embed.addFields({ name: 'Opened', value: `<t:${ticket.created_at}:R>`, inline: true });
  const person = owner?.user ?? owner;
  if (person?.username) {
    embed.setAuthor({ name: trunc(person.username, 100), iconURL: person.displayAvatarURL?.({ size: 64 }) });
  }
  embed.setFooter({ text: 'Staff can claim, close and manage this ticket with the buttons below' });
  // A message's embeds may hold 6000 characters in total. Long form answers plus a long custom
  // message can exceed that, so the answers share whatever room is left instead of failing.
  let room =
    5800 -
    (embed.data.title?.length ?? 0) -
    (embed.data.description?.length ?? 0) -
    (ticket.subject ? Math.min(ticket.subject.length, 1024) + 5 : 0) -
    140;
  for (const f of fields.slice(0, 20)) {
    const name = trunc(f.name, 256);
    const value = trunc(f.value || '—', Math.min(1024, room - name.length));
    if (room - name.length < 20) break;
    embed.addFields({ name, value });
    room -= name.length + value.length;
  }
  return embed.setTimestamp();
}

/**
 * Close, plus Claim/Release when enabled. A pending application also gets Accept and Deny.
 */
function controls(ticket) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id('close'))
      .setLabel('Close')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );
  if (ticket.claim_enabled) {
    const claimed = Boolean(ticket.claimed_by);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(id('claim'))
        .setLabel(claimed ? 'Release' : 'Claim')
        .setEmoji(claimed ? '🔓' : '🙋')
        .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success),
    );
  }
  const rows = [row];

  if (ticket.kind === 'application' && ticket.app_status === 'pending') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(id('app', 'accept'))
          .setLabel('Accept')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(id('app', 'deny'))
          .setLabel('Deny')
          .setEmoji('✖️')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return rows;
}

function closeModal() {
  return new ModalBuilder()
    .setCustomId(id('closesub'))
    .setTitle('Close ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(512),
      ),
    );
}

function closedEmbed(ticket, closerId) {
  const embed = new EmbedBuilder()
    .setColor(colors.danger)
    .setTitle(`🔒 ${kindName(ticket)} #${pad(ticket.number)} closed`)
    .setDescription('This conversation is now locked. A transcript has been saved if a transcript channel is set.')
    .addFields({ name: 'Closed by', value: `<@${closerId}>`, inline: true });
  if (ticket.created_at) {
    const end = ticket.closed_at ?? Math.floor(Date.now() / 1000);
    embed.addFields({ name: 'Open for', value: duration(end - ticket.created_at), inline: true });
  }
  if (ticket.close_reason) embed.addFields({ name: 'Reason', value: trunc(ticket.close_reason, 1000) });
  return embed.setFooter({ text: 'Staff can reopen or delete it with the buttons below.' }).setTimestamp();
}

function closedControls() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(id('reopen'))
        .setLabel('Reopen')
        .setEmoji('🔓')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(id('delete'))
        .setLabel('Delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function purgeConfirm(userId, scope) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(id('purge', 'yes', userId, scope))
        .setLabel('Purge')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(id('purge', 'no', userId, scope))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ---------- close request ----------
function closeRequestEmbed(staffId, message) {
  let text = `<@${staffId}> thinks this ticket is resolved.`;
  if (message) text += `\n\n> ${trunc(message, 1000).replace(/\n/g, '\n> ')}`;
  return new EmbedBuilder()
    .setColor(colors.warn)
    .setTitle('🙋 Is your issue resolved?')
    .setDescription(text)
    .setFooter({ text: 'Only the person who opened the ticket can answer.' });
}

function closeRequestButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(id('crq', 'yes'))
        .setLabel('Yes, close it')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(id('crq', 'no'))
        .setLabel('No, keep it open')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ---------- applications ----------
function decisionEmbed(accepted, staffId, note) {
  const embed = new EmbedBuilder()
    .setColor(accepted ? colors.success : colors.danger)
    .setTitle(accepted ? '🎉 Application accepted' : '📄 Application denied')
    .setDescription(`${accepted ? 'Accepted' : 'Denied'} by <@${staffId}>.`);
  if (note) embed.addFields({ name: accepted ? '💬 Note' : '💬 Reason', value: trunc(note, 1024) });
  return embed.setTimestamp();
}

function denyModal() {
  return new ModalBuilder()
    .setCustomId(id('appdeny'))
    .setTitle('Deny application')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason (sent to the applicant)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
}

// ---------- rating survey ----------
function surveyEmbed(survey, guildName) {
  return new EmbedBuilder()
    .setColor(colors.primary)
    .setTitle('⭐ How was your support?')
    .setDescription(
      `Your ticket **#${pad(survey.ticket_number)}** in **${trunc(guildName, 100)}** was closed.\n` +
        'Tap a number to rate the help you received, **1** (poor) to **5** (great).',
    );
}

function surveyButtons(surveyId) {
  return [
    new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map((n) =>
        new ButtonBuilder()
          .setCustomId(id('rate', surveyId, n))
          .setLabel(String(n))
          .setEmoji('⭐')
          .setStyle(ButtonStyle.Secondary),
      ),
    ),
  ];
}

function rateModal(surveyId, n) {
  return new ModalBuilder()
    .setCustomId(id('ratesub', surveyId, n))
    .setTitle(`Your rating: ${n} / 5`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('comment')
          .setLabel('Anything you want to add? (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
}

function ratedEmbed(rating) {
  return new EmbedBuilder()
    .setColor(colors.success)
    .setTitle('Thanks for your feedback!')
    .setDescription(`You rated this ticket **${stars(rating)}**`);
}

function feedbackEmbed(survey, rating, comment, guildName) {
  const embed = new EmbedBuilder()
    .setColor(rating >= 4 ? colors.success : rating === 3 ? colors.warn : colors.danger)
    .setTitle(`Ticket #${pad(survey.ticket_number)} rated ${rating}/5`)
    .setDescription(`${stars(rating)}\n${meter(rating, 5)}  **${rating}** / 5`)
    .addFields(
      { name: 'From', value: `<@${survey.owner_id}>`, inline: true },
      {
        name: 'Handled by',
        value: survey.claimed_by ? `<@${survey.claimed_by}>` : 'Unclaimed',
        inline: true,
      },
    )
    .setFooter({ text: guildName })
    .setTimestamp();
  if (survey.subject) embed.addFields({ name: 'Topic', value: trunc(survey.subject, 1024) });
  if (comment) embed.addFields({ name: 'Comment', value: trunc(comment, 1024) });
  return embed;
}

// ---------- knowledge base ----------
/** `max` caps the body; several articles in one message must stay under 6000 characters together. */
function kbEmbed(article, max = 4000) {
  return new EmbedBuilder()
    .setColor(colors.neutral)
    .setTitle(trunc(article.title, 200))
    .setDescription(trunc(article.body, max))
    .setFooter({ text: `Help article #${article.id}` });
}

const kbIntroEmbed = () =>
  info('📚 **These articles might help while you wait.** If one solves it, you can close the ticket.');

function kbGateButtons(token) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(id('kbdone', token))
        .setLabel('That solved it')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(id('kbgo', token))
        .setLabel('Open a ticket anyway')
        .setEmoji('🎫')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function kbAddModal() {
  const field = (customId, label, style, required, max, placeholder) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(max)
        .setPlaceholder(placeholder),
    );
  return new ModalBuilder()
    .setCustomId(id('kbadd'))
    .setTitle('New help article')
    .addComponents(
      field('title', 'Title', TextInputStyle.Short, true, 100, 'How do I get a refund?'),
      field(
        'keywords',
        'Keywords (comma separated)',
        TextInputStyle.Short,
        false,
        200,
        'refund, money back, payment',
      ),
      field('body', 'Answer', TextInputStyle.Paragraph, true, 4000, 'Write the answer members will see…'),
    );
}

module.exports = {
  pad,
  trunc,
  id,
  stars,
  meter,
  duration,
  ok,
  fail,
  warn,
  info,
  panelEmbed,
  panelMessage,
  panelComponents,
  statusText,
  statusColor,
  priorityText,
  ticketLink,
  applyStatus,
  questionEmbed,
  questionSelects,
  isHttpUrl,
  topicModal,
  welcomeEmbed,
  controls,
  closeModal,
  closedEmbed,
  closedControls,
  purgeConfirm,
  closeRequestEmbed,
  closeRequestButtons,
  decisionEmbed,
  denyModal,
  surveyEmbed,
  surveyButtons,
  rateModal,
  ratedEmbed,
  feedbackEmbed,
  kbEmbed,
  kbIntroEmbed,
  kbGateButtons,
  kbAddModal,
};
