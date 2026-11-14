// Interaction-level actions shared by slash commands and buttons.
const { EmbedBuilder, MessageFlags, PermissionFlagsBits: P } = require('discord.js');
const config = require('./config');
const { q } = require('./db');
const ui = require('./ui');
const tickets = require('./tickets');
const log = require('./log');

const label = (ticket) => `${ticket.kind === 'application' ? 'Application' : 'Ticket'} #${ui.pad(ticket.number)}`;
/** Posts an event about a ticket to the log channel. */
const logTicket = (i, ticket, title, color, fields = []) =>
  log.event(i.client, i.guildId, {
    title: `${label(ticket)} ${title}`,
    color,
    fields: [{ name: 'Channel', value: `<#${ticket.channel_id}>` }, { name: 'By', value: `<@${i.user.id}>` }, ...fields],
  });

const EPH = MessageFlags.Ephemeral;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const purging = new Set(); // guild ids with a purge in progress

const deny = (i, text) => i.reply({ embeds: [ui.fail(text)], flags: EPH });

async function requireTicket(i) {
  const ticket = i.guildId ? q.ticketByChannel.get(i.channelId) : null;
  if (!ticket) {
    await deny(i, 'This only works inside a ticket channel.');
    return null;
  }
  return ticket;
}

async function requireStaff(i, ticket) {
  if (tickets.isStaff(i, ticket.staff_role_id)) return true;
  await deny(i, 'Only staff can do that.');
  return false;
}

/** Used by /claim and the Claim button. Running it again on your own ticket releases it. */
async function claim(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;
  if (ticket.status === 'closed') return deny(i, 'This ticket is closed.');

  const mine = ticket.claimed_by === i.user.id;
  if (ticket.claimed_by && !mine && !i.memberPermissions.has(P.Administrator)) {
    return deny(i, `This ticket is already claimed by <@${ticket.claimed_by}>.`);
  }

  const next = mine ? null : i.user.id;
  q.setClaimed.run(next, ticket.id);

  await i.reply({
    embeds: [
      next
        ? ui.ok(`Ticket claimed by <@${i.user.id}>.`)
        : ui.info(`<@${i.user.id}> released this ticket.`),
    ],
  });
  tickets.refreshWelcome(i.channel, { ...ticket, claimed_by: next }).catch(() => {});
  logTicket(i, ticket, next ? 'claimed' : 'released', 0x5865f2);
}

/** /ticket transfer: hand a ticket to another member of the staff role. */
async function transfer(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;
  if (ticket.status === 'closed') return deny(i, 'This ticket is closed.');
  if (ticket.claimed_by && ticket.claimed_by !== i.user.id && !i.memberPermissions.has(P.Administrator)) {
    return deny(i, `Only <@${ticket.claimed_by}> or an administrator can hand this ticket over.`);
  }

  const user = i.options.getUser('user', true);
  const member = i.options.getMember('user');
  const roles = member?.roles?.cache ? [...member.roles.cache.keys()] : [...(member?.roles ?? [])];
  if (user.bot || !roles.includes(ticket.staff_role_id)) return deny(i, 'Pick a member of this ticket\'s staff role.');
  if (ticket.claimed_by === user.id) return deny(i, `<@${user.id}> already has this ticket.`);

  q.setClaimed.run(user.id, ticket.id);
  await i.reply({ embeds: [ui.ok(`<@${i.user.id}> handed this ticket to <@${user.id}>.`)] });
  tickets.refreshWelcome(i.channel, { ...ticket, claimed_by: user.id }).catch(() => {});
  logTicket(i, ticket, 'transferred', 0x5865f2, [{ name: 'To', value: `<@${user.id}>` }]);
}

/** /ticket priority: mark how urgent a ticket is. Shown on the ticket's first message. */
async function priority(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;
  if (ticket.status === 'closed') return deny(i, 'This ticket is closed.');

  const level = i.options.getString('level', true);
  if (!['low', 'normal', 'high', 'urgent'].includes(level)) return deny(i, 'Pick low, normal, high or urgent.');
  const next = { ...ticket, priority: level === 'normal' ? null : level };
  q.setPriority.run(next.priority, ticket.id);

  await i.reply({ embeds: [ui.ok(next.priority ? `Priority set to ${ui.priorityText(next)}.` : 'Priority is back to normal.')] });
  tickets.refreshWelcome(i.channel, next).catch(() => {});
  logTicket(i, ticket, `priority ${level}`, 0xf59e0b);
}

/** /ticket info: a card with the facts about this ticket. */
async function info(i) {
  const ticket = await requireTicket(i);
  if (!ticket) return;
  const embed = new EmbedBuilder()
    .setColor(ui.statusColor(ticket))
    .setTitle(`ℹ️ ${label(ticket)}`)
    .addFields(
      { name: 'Opened by', value: `<@${ticket.owner_id}>`, inline: true },
      { name: 'Status', value: ui.statusText(ticket), inline: true },
      { name: 'Claimed by', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'nobody yet', inline: true },
    );
  if (ticket.subject) embed.addFields({ name: 'Topic', value: ui.trunc(ticket.subject, 1024), inline: true });
  if (ui.priorityText(ticket)) embed.addFields({ name: 'Priority', value: ui.priorityText(ticket), inline: true });
  if (ticket.created_at) embed.addFields({ name: 'Opened', value: `<t:${ticket.created_at}:R>`, inline: true });
  if (ticket.status === 'closed') {
    if (ticket.closed_at) embed.addFields({ name: 'Closed', value: `<t:${ticket.closed_at}:R>`, inline: true });
    if (ticket.close_reason) embed.addFields({ name: 'Reason', value: ui.trunc(ticket.close_reason, 1024) });
  }
  return i.reply({ embeds: [embed], flags: EPH });
}

/** Used by /close and the Close button's modal. */
async function close(i, reason) {
  const ticket = await requireTicket(i);
  if (!ticket) return;
  if (ticket.status === 'closed') return deny(i, 'This ticket is already closed.');
  if (i.user.id !== ticket.owner_id && !tickets.isStaff(i, ticket.staff_role_id)) {
    return deny(i, 'Only the ticket owner or staff can close this ticket.');
  }

  await i.deferReply(); // building the transcript can take longer than 3 seconds
  const closed = await tickets.closeTicket(i.client, ticket, i.channel, i.user.id, reason);
  if (!closed) return i.editReply({ embeds: [ui.fail('This ticket is already closed.')] });
  await i.editReply({
    embeds: [ui.closedEmbed(closed, i.user.id)],
    components: ui.closedControls(),
  });
  tickets.refreshWelcome(i.channel, closed).catch(() => {});
  logTicket(i, ticket, 'closed', 0xed4245, [{ name: 'Opened by', value: `<@${ticket.owner_id}>` }, { name: 'Reason', value: reason || 'None given' }]);
}

async function reopen(i) {
  const ticket = await requireTicket(i);
  if (!ticket) return;
  if (ticket.status !== 'closed') return deny(i, 'This ticket is not closed.');
  if (!tickets.isStaff(i, ticket.staff_role_id)) {
    return deny(i, 'Only staff can reopen a closed ticket.');
  }

  await i.deferReply();
  const { ticket: reopened, unlocked } = await tickets.reopenTicket(ticket, i.channel);
  await i.editReply({ embeds: [ui.ok(`${label(ticket)} reopened by <@${i.user.id}>.`)] });
  if (!unlocked) {
    await i.followUp({
      embeds: [ui.warn(`I could not give <@${ticket.owner_id}> permission to type again. Check that I have **Manage Roles** and **Manage Channels**, or allow them to send messages in this channel yourself.`)],
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  // Remove the buttons from the card that was clicked, unless it is the welcome message (refreshed below).
  if (i.isButton() && i.message.id !== ticket.welcome_message_id) i.message.edit({ components: [] }).catch(() => {});
  tickets.refreshWelcome(i.channel, reopened).catch(() => {});
  logTicket(i, ticket, 'reopened', 0xfee75c);
}

/** /delete and the Delete button. */
async function remove(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;

  logTicket(i, ticket, 'deleted', 0xed4245, [{ name: 'Opened by', value: `<@${ticket.owner_id}>` }]);
  const seconds = Math.ceil(config.deleteDelayMs / 1000);
  await i.reply({ embeds: [ui.warn(`This ticket will be deleted in ${seconds} seconds…`)] });
  try {
    await tickets.deleteTicket(i.client, ticket, i.channel);
  } catch (err) {
    console.error('[delete]', err);
    await i
      .followUp({ embeds: [ui.fail('I could not delete this channel. Check my **Manage Channels** permission.')] })
      .catch(() => {});
  }
}

async function addUser(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;

  const user = i.options.getUser('user', true);
  if (!i.options.getMember('user')) return deny(i, 'That user is not in this server.');
  if (user.bot) return deny(i, 'You cannot add bots to a ticket.');

  const existing = i.channel.permissionOverwrites.cache.get(user.id);
  if (existing?.allow.has(P.ViewChannel)) return deny(i, `<@${user.id}> is already in this ticket.`);

  await tickets.setMemberPerms(
    i.channel,
    user.id,
    Object.fromEntries(tickets.MEMBER_PERMS.map((perm) => [permName(perm), true])),
  );
  await i.reply({
    content: `<@${user.id}>`,
    embeds: [ui.ok(`Added <@${user.id}> to the ticket.`)],
    allowedMentions: { users: [user.id] },
  });
  logTicket(i, ticket, 'user added', 0x5865f2, [{ name: 'Added', value: `<@${user.id}>` }]);
}

async function removeUser(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;

  const user = i.options.getUser('user', true);
  if (user.id === ticket.owner_id) return deny(i, 'You cannot remove the ticket owner.');
  if (user.id === i.client.user.id) return deny(i, 'You cannot remove me from my own ticket.');
  if (!i.channel.permissionOverwrites.cache.has(user.id)) {
    return deny(i, `<@${user.id}> was not added to this ticket.`);
  }

  await i.channel.permissionOverwrites.delete(user.id, `Removed by ${i.user.username}`);
  await i.reply({ embeds: [ui.ok(`Removed <@${user.id}> from the ticket.`)] });
  logTicket(i, ticket, 'user removed', 0x5865f2, [{ name: 'Removed', value: `<@${user.id}>` }]);
}

async function rename(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;

  const name = i.options
    .getString('name', true)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  if (!name) return deny(i, 'Please use letters or numbers in the name.');

  await i.deferReply();
  const renaming = i.channel.setName(name, `Renamed by ${i.user.username}`).then(() => true);
  renaming.catch(() => {}); // a late failure after the timeout below must not crash the process
  const done = await Promise.race([renaming, sleep(8000).then(() => false)]);
  logTicket(i, ticket, 'renamed', 0x5865f2, [{ name: 'New name', value: `#${name}` }]);

  await i.editReply({
    embeds: [
      done
        ? ui.ok(`Renamed to **#${name}**.`)
        : ui.warn(
            'Discord only allows 2 channel renames per 10 minutes. The new name is queued and ' +
              'will apply automatically.',
          ),
    ],
  });
}

// ---------- close request ----------
/** /ticket request-close: staff ask the opener to confirm the ticket is resolved. */
async function closeRequest(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return;
  if (ticket.status === 'closed') return deny(i, 'This ticket is already closed.');
  if (i.user.id === ticket.owner_id) return deny(i, 'This is your own ticket. Use /close instead.');

  await i.reply({
    content: `<@${ticket.owner_id}>`,
    embeds: [ui.closeRequestEmbed(i.user.id, i.options.getString('message'))],
    components: ui.closeRequestButtons(),
    allowedMentions: { users: [ticket.owner_id] },
  });
}

/** The opener pressed Yes or No on a close request. */
async function closeRequestAnswer(i, answer) {
  const ticket = q.ticketByChannel.get(i.channelId);
  if (!ticket || ticket.status !== 'open') {
    return i.update({ content: null, embeds: [ui.info('This request is no longer active.')], components: [] });
  }
  if (i.user.id !== ticket.owner_id) return deny(i, 'Only the person who opened the ticket can answer this.');

  if (answer !== 'yes') {
    return i.update({
      content: null,
      embeds: [ui.info(`<@${ticket.owner_id}> says this is **not resolved** yet, so the ticket stays open.`)],
      components: [],
    });
  }

  await i.update({
    content: null,
    embeds: [ui.ok(`<@${ticket.owner_id}> confirmed this is resolved. Closing the ticket…`)],
    components: [],
  });
  const closed = await tickets.closeTicket(
    i.client,
    ticket,
    i.channel,
    i.user.id,
    'Resolved: confirmed by the ticket opener',
  );
  if (!closed) return;
  await i.channel.send({
    embeds: [ui.closedEmbed(closed, i.user.id)],
    components: ui.closedControls(),
  });
  tickets.refreshWelcome(i.channel, closed).catch(() => {});
  log.event(i.client, i.guildId, {
    title: `${label(ticket)} closed`,
    color: 0xed4245,
    fields: [
      { name: 'Channel', value: `<#${ticket.channel_id}>` },
      { name: 'Opened by', value: `<@${ticket.owner_id}>` },
      { name: 'Reason', value: 'Resolved: confirmed by the ticket opener' },
    ],
  });
}

// ---------- applications ----------
async function pendingApplication(i) {
  const ticket = await requireTicket(i);
  if (!ticket || !(await requireStaff(i, ticket))) return null;
  if (ticket.kind !== 'application') {
    await deny(i, 'This is not an application.');
    return null;
  }
  if (ticket.app_status !== 'pending') {
    await deny(i, `This application was already ${ticket.app_status}.`);
    return null;
  }
  return ticket;
}

/** Tells the applicant the outcome by DM. Closed DMs are fine: the channel message still pings them. */
async function notifyApplicant(i, ticket, accepted, note) {
  const user = await i.client.users.fetch(ticket.owner_id).catch(() => null);
  await user
    ?.send({
      embeds: [
        ui
          .decisionEmbed(accepted, i.user.id, note)
          .setFooter({ text: i.guild?.name ?? 'Application' }),
      ],
    })
    .catch(() => {});
}

async function applicationDecided(i, ticket, accepted, note) {
  logTicket(i, ticket, accepted ? 'accepted' : 'denied', accepted ? 0x57f287 : 0xed4245, [
    { name: 'Applicant', value: `<@${ticket.owner_id}>` },
    ...(note ? [{ name: accepted ? 'Note' : 'Reason', value: note }] : []),
  ]);
  await i.channel.send({
    content: `<@${ticket.owner_id}>`,
    embeds: [ui.decisionEmbed(accepted, i.user.id, note)],
    allowedMentions: { users: [ticket.owner_id] },
  });
  await notifyApplicant(i, ticket, accepted, note);
  tickets.refreshWelcome(i.channel, q.ticketByChannel.get(ticket.channel_id)).catch(() => {});
}

/** Accept button: marks it accepted and grants the topic's role if there is one. */
async function appAccept(i) {
  const ticket = await pendingApplication(i);
  if (!ticket) return;
  await i.deferUpdate();

  const decided = q.setAppStatus.run('accepted', i.user.id, null, ticket.id);
  if (!decided.changes) return;

  let note = null;
  if (ticket.accept_role_id) {
    try {
      const member = await i.guild.members.fetch(ticket.owner_id);
      await member.roles.add(ticket.accept_role_id, `Application #${ticket.number} accepted by ${i.user.username}`);
      note = `Granted <@&${ticket.accept_role_id}>.`;
    } catch (err) {
      console.error('[application] could not grant the role:', err.message);
      note =
        `I could not grant <@&${ticket.accept_role_id}>. Staff: check that I have **Manage Roles** ` +
        'and that my role is above it.';
    }
  }
  await applicationDecided(i, ticket, true, note);
}

/** Deny button: asks staff for an optional reason first. */
async function appDenyPrompt(i) {
  const ticket = await pendingApplication(i);
  if (!ticket) return;
  return i.showModal(ui.denyModal());
}

async function appDenySubmit(i) {
  const ticket = await pendingApplication(i);
  if (!ticket) return;

  const reason = i.fields.getTextInputValue('reason').trim() || null;
  const decided = q.setAppStatus.run('denied', i.user.id, reason, ticket.id);
  if (!decided.changes) return deny(i, 'This application was already reviewed.');

  await i.reply({ embeds: [ui.ok('Application denied.')], flags: EPH });
  await applicationDecided(i, ticket, false, reason);
}

// ---------- /purge ----------
async function purge(i) {
  const scope = i.options.getString('scope') ?? 'closed';
  const rows =
    scope === 'all' ? q.listByGuild.all(i.guildId) : q.listByGuildStatus.all(i.guildId, 'closed');
  if (!rows.length) return i.reply({ embeds: [ui.info(`There are no ${scope} tickets to purge.`)], flags: EPH });

  await i.reply({
    embeds: [
      ui.warn(
        `This will permanently delete **${rows.length}** ${scope} ticket channel(s). ` +
          'Transcripts are **not** generated, and this cannot be undone.',
      ),
    ],
    components: ui.purgeConfirm(i.user.id, scope),
    flags: EPH,
  });
}

async function purgeConfirm(i, answer, userId, scope) {
  if (i.user.id !== userId) return deny(i, 'Only the person who ran /admin purge can confirm it.');
  if (!i.memberPermissions.has(P.Administrator)) return deny(i, 'Only administrators can purge tickets.');
  if (answer !== 'yes') {
    return i.update({ embeds: [ui.info('Purge cancelled.')], components: [] });
  }
  if (purging.has(i.guildId)) return deny(i, 'A purge is already running in this server.');

  purging.add(i.guildId);
  try {
    const rows =
      scope === 'all' ? q.listByGuild.all(i.guildId) : q.listByGuildStatus.all(i.guildId, 'closed');
    await i.update({ embeds: [ui.warn(`Purging ${rows.length} ticket(s)…`)], components: [] });

    let deleted = 0;
    let failed = 0;
    for (const [index, row] of rows.entries()) {
      try {
        await i.guild.channels.delete(row.channel_id, 'Ticket purge');
        q.deleteById.run(row.id);
        deleted++;
      } catch (err) {
        if (err.code === 10003) {
          q.deleteById.run(row.id); // channel was already gone
          deleted++;
        } else {
          failed++;
        }
      }
      if ((index + 1) % 10 === 0) {
        await i
          .editReply({ embeds: [ui.warn(`Purging… ${index + 1}/${rows.length}`)] })
          .catch(() => {});
      }
    }

    log.event(i.client, i.guildId, {
      title: 'Tickets purged',
      color: 0xed4245,
      fields: [{ name: 'By', value: `<@${i.user.id}>` }, { name: 'Scope', value: scope }, { name: 'Deleted', value: String(deleted) }],
    });
    const note = failed ? ` ${failed} could not be deleted (check my **Manage Channels** permission).` : '';
    await i
      .editReply({ embeds: [ui.ok(`Purged **${deleted}** ticket(s).${note}`)] })
      .catch(() => {});
  } finally {
    purging.delete(i.guildId);
  }
}

/** PermissionFlagsBits value -> the key name that permissionOverwrites.edit expects. */
function permName(flag) {
  return Object.keys(P).find((key) => P[key] === flag);
}

module.exports = {
  claim,
  transfer,
  priority,
  info,
  close,
  reopen,
  remove,
  addUser,
  removeUser,
  rename,
  closeRequest,
  closeRequestAnswer,
  appAccept,
  appDenyPrompt,
  appDenySubmit,
  purge,
  purgeConfirm,
};
