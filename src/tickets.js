// Core ticket logic. Works on plain Discord objects and ids; interaction wiring lives in actions.js.
const { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits: P } = require('discord.js');
const config = require('./config');
const { q } = require('./db');
const ui = require('./ui');
const topicsLib = require('./topics');
const knowledge = require('./knowledge');
const survey = require('./survey');
const bans = require('./bans');
const log = require('./log');
const { sendTranscript } = require('./transcript');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

const MEMBER_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const STAFF_PERMS = [...MEMBER_PERMS, P.ManageMessages];
const BOT_PERMS = [...STAFF_PERMS, P.ManageChannels];

const creating = new Set(); // "guild:user" while a ticket is being created (stops double clicks)
const cooldowns = new Map(); // "guild:user" -> timestamp of the last created ticket

setInterval(() => {
  const cutoff = Date.now() - config.createCooldownMs;
  for (const [key, ts] of cooldowns) if (ts < cutoff) cooldowns.delete(key);
}, 5 * 60 * 1000).unref();

/** Staff = has the given role, or can manage channels / is an administrator. */
function isStaff(interaction, staffRoleId) {
  const perms = interaction.memberPermissions;
  if (perms?.has(P.Administrator) || perms?.has(P.ManageChannels)) return true;
  const roles = interaction.member?.roles;
  if (!roles) return false;
  return Array.isArray(roles) ? roles.includes(staffRoleId) : roles.cache.has(staffRoleId);
}

/** Overwrites by id with an explicit type, so it works even when the user isn't cached. */
function setMemberPerms(channel, userId, perms) {
  return channel.permissionOverwrites.edit(userId, perms, { type: OverwriteType.Member });
}

/**
 * Opens a ticket (or application) for `interaction.user` from `topic` on `panel`.
 * Returns { channel } on success or { error } with a message fit to show the member.
 */
async function openTicket(interaction, panel, topic, { subject = null, fields = [] } = {}) {
  const { guild, user, client } = interaction;
  const key = `${guild.id}:${user.id}`;
  const settings = topicsLib.resolve(panel, topic);
  const isApplication = settings.kind === 'application';

  if (creating.has(key)) return { error: 'Your request is already being created.' };
  if (Date.now() - (cooldowns.get(key) ?? 0) < config.createCooldownMs) {
    return { error: 'You are doing that too quickly. Please wait a few seconds.' };
  }

  const ban = bans.activeBan(guild.id, user.id);
  if (ban) return { error: bans.banMessage(ban) };

  const open = q.openByOwnerTopic.all(guild.id, user.id, topic.id);
  if (open.length >= settings.maxTickets) {
    const links = open.map((t) => `<#${t.channel_id}>`).join(', ');
    return {
      error: isApplication
        ? `You already have an open application: ${links}`
        : `You already have ${open.length} open ticket(s) for this topic: ${links}`,
    };
  }

  creating.add(key);
  let channel;
  try {
    const number = q.nextNumber.get(guild.id).n;
    const prefix = isApplication ? 'app' : 'ticket';

    // Category: the topic's, else the panel's, else next to the panel itself.
    const parentId =
      settings.parentId ?? guild.channels.cache.get(panel.channel_id)?.parentId ?? undefined;

    channel = await guild.channels.create({
      name: `${prefix}-${ui.pad(number)}`,
      type: ChannelType.GuildText,
      parent: parentId,
      topic: `${isApplication ? 'Application' : 'Ticket'} #${ui.pad(number)} • opened by ${user.username} (${user.id})`,
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        { id: user.id, type: OverwriteType.Member, allow: MEMBER_PERMS },
        { id: settings.staffRoleId, type: OverwriteType.Role, allow: STAFF_PERMS },
        { id: client.user.id, type: OverwriteType.Member, allow: BOT_PERMS },
      ],
      reason: `${isApplication ? 'Application' : 'Ticket'} opened by ${user.username}`,
    });

    q.insertTicket.run({
      guild_id: guild.id,
      number,
      channel_id: channel.id,
      panel_id: panel.id ?? null,
      topic_id: topic.id,
      kind: settings.kind,
      owner_id: user.id,
      staff_role_id: settings.staffRoleId,
      transcript_channel_id: settings.transcriptChannelId,
      claim_enabled: panel.claim_enabled,
      accept_role_id: settings.acceptRoleId,
      app_status: isApplication ? 'pending' : null,
      subject: subject ?? topic.label,
      created_at: nowSec(),
    });
    const ticket = q.ticketByChannel.get(channel.id);

    const welcome = await channel.send({
      content: `<@${user.id}> <@&${settings.staffRoleId}>`,
      embeds: [ui.welcomeEmbed(ticket, { text: settings.message, fields, owner: user })],
      components: ui.controls(ticket),
      allowedMentions: { users: [user.id], roles: [settings.staffRoleId] },
    });
    q.setWelcome.run(welcome.id, ticket.id);

    cooldowns.set(key, Date.now());
    log.event(client, guild.id, {
      title: `${isApplication ? 'Application' : 'Ticket'} #${ui.pad(number)} opened`,
      color: 0x57f287,
      fields: [
        { name: 'Opened by', value: `<@${user.id}>` },
        { name: 'Topic', value: topic.label },
        { name: 'Channel', value: `<#${channel.id}>` },
      ],
    });

    // Help articles for this topic and for what the member wrote. Never blocks ticket creation.
    if (panel.kb_mode === 'inside' && !isApplication) {
      const text = [subject, ...fields.map((f) => f.value)].filter(Boolean).join(' ');
      const articles = knowledge.suggest(guild.id, topic, text, 3);
      if (articles.length) {
        channel
          .send({ embeds: [ui.kbIntroEmbed(), ...articles.map((a) => ui.kbEmbed(a, 1200))] })
          .catch(() => {});
      }
    }
    return { channel };
  } catch (err) {
    console.error('[openTicket]', err);
    if (channel) {
      q.deleteByChannel.run(channel.id);
      channel.delete('Ticket creation failed').catch(() => {});
    }
    return {
      error:
        'I could not create your ticket. The category may be full, or I may be missing the ' +
        '**Manage Channels** permission. Please tell a staff member.',
    };
  } finally {
    creating.delete(key);
  }
}

/**
 * Creates a private Discord category for a topic, so its tickets are grouped together.
 * Returns the new category, or throws when the bot cannot create it.
 */
function createTopicCategory(guild, label, staffRoleId, botId) {
  return guild.channels.create({
    name: `Tickets - ${label}`.slice(0, 100),
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: staffRoleId, type: OverwriteType.Role, allow: STAFF_PERMS },
      { id: botId, type: OverwriteType.Member, allow: BOT_PERMS },
    ],
    reason: `Category for the "${label}" ticket topic`,
  });
}

/**
 * Keeps the ticket's welcome message live: its Status field, colour and buttons follow the
 * ticket's current state (open, claimed, closed, or the application's decision).
 */
async function refreshWelcome(channel, ticket) {
  if (!ticket.welcome_message_id) return;
  const message = await channel.messages.fetch(ticket.welcome_message_id);
  const payload = { components: ticket.status === 'open' ? ui.controls(ticket) : ui.closedControls() };
  if (message.embeds[0]) payload.embeds = [ui.applyStatus(EmbedBuilder.from(message.embeds[0]), ticket)];
  await message.edit(payload);
}

/**
 * Re-renders a panel message after its topics or look changed. Panels posted by an older version
 * do not have their text stored, so for those only the buttons are refreshed.
 */
async function refreshPanel(client, panel) {
  if (!panel.message_id) return false;
  try {
    const channel = await client.channels.fetch(panel.channel_id);
    const topics = topicsLib.forPanel(panel.id);
    await channel.messages.edit(
      panel.message_id,
      panel.description ? ui.panelMessage(panel, topics) : { components: ui.panelComponents(panel, topics) },
    );
    return true;
  } catch (err) {
    console.error('[refreshPanel]', err.message);
    return false;
  }
}

async function closeTicket(client, ticket, channel, closerId, reason) {
  // Only an open ticket can be closed, so two people closing at once cannot both do it
  // (that would send two transcripts and two rating prompts).
  const changed = q.closeTicket.run(closerId, reason || null, nowSec(), ticket.id);
  if (!changed.changes) return null;
  const closed = q.ticketByChannel.get(ticket.channel_id);

  // Lock the opener out of typing, build the transcript and ask for a rating, all at once.
  const [lock, transcript, rating] = await Promise.allSettled([
    setMemberPerms(channel, ticket.owner_id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }),
    sendTranscript(client, closed, channel),
    survey.send(client, closed, channel),
  ]);
  if (lock.status === 'rejected') console.error('[close] could not lock the opener:', lock.reason);
  if (transcript.status === 'rejected') console.error('[close] transcript failed:', transcript.reason);
  if (rating.status === 'rejected') console.error('[close] rating prompt failed:', rating.reason);

  return q.ticketByChannel.get(ticket.channel_id);
}

async function reopenTicket(ticket, channel) {
  q.reopenTicket.run(ticket.id);
  let unlocked = true;
  await setMemberPerms(channel, ticket.owner_id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true }).catch((err) => {
    unlocked = false;
    console.error('[reopen] could not unlock the opener:', err);
  });
  return { ticket: q.ticketByChannel.get(ticket.channel_id), unlocked };
}

async function deleteTicket(client, ticket, channel) {
  // A closed ticket already sent its transcript; an open one gets it now. Runs during the countdown.
  const needsTranscript = !ticket.transcript_sent;
  await Promise.all([
    sleep(config.deleteDelayMs),
    needsTranscript
      ? sendTranscript(client, ticket, channel).catch((err) =>
          console.error('[delete] transcript failed:', err),
        )
      : null,
  ]);
  await channel.delete(`Ticket #${ui.pad(ticket.number)} deleted`);
  q.deleteByChannel.run(ticket.channel_id);
}

module.exports = {
  isStaff,
  setMemberPerms,
  openTicket,
  createTopicCategory,
  refreshWelcome,
  refreshPanel,
  closeTicket,
  reopenTicket,
  deleteTicket,
  MEMBER_PERMS,
};
