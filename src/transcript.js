const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const config = require('./config');
const { q } = require('./db');
const { renderTranscript } = require('./transcriptHtml');
const { pad } = require('./ui');

/** Pages through the channel history (REST only, so no privileged intents are needed). */
async function collect(channel, max) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
    if (batch.size === 0) break;
    out.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.lastKey(); // API returns newest first, so the last key is the oldest
  }
  const truncated = out.length >= max;
  return { messages: out.slice(0, max).reverse(), truncated };
}

function resolveMentions(m) {
  return m.content
    .replace(/<@!?(\d+)>/g, (raw, uid) => {
      const user = m.mentions.users.get(uid);
      if (!user) return raw;
      const name = m.mentions.members?.get(uid)?.displayName ?? user.globalName ?? user.username;
      return `@${name}`;
    })
    .replace(/<@&(\d+)>/g, (raw, rid) => {
      const role = m.guild?.roles.cache.get(rid);
      return role ? `@${role.name}` : raw;
    })
    .replace(/<#(\d+)>/g, (raw, cid) => {
      const ch = m.guild?.channels.cache.get(cid);
      return ch ? `#${ch.name}` : raw;
    });
}

function serialize(m) {
  return {
    id: m.id,
    authorId: m.author.id,
    authorName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
    avatar: m.author.displayAvatarURL({ extension: 'png', size: 64 }),
    bot: m.author.bot,
    ts: m.createdTimestamp,
    content: resolveMentions(m),
    attachments: [...m.attachments.values()].map((a) => ({
      name: a.name,
      url: a.url,
      image: Boolean(a.contentType?.startsWith('image/')),
    })),
    // Link-preview embeds are noise; keep only embeds a bot or staff member actually wrote.
    embeds: m.embeds
      .filter((e) => !e.data?.type || e.data.type === 'rich')
      .map((e) => ({
        title: e.title,
        description: e.description,
        color: e.hexColor,
        fields: e.fields.map((f) => ({ name: f.name, value: f.value })),
      })),
    stickers: [...m.stickers.values()].map((s) => s.name),
  };
}

async function buildTranscript(channel, ticket) {
  const { messages, truncated } = await collect(channel, config.maxTranscriptMessages);
  const owner = await channel.client.users.fetch(ticket.owner_id).catch(() => null);

  const html = renderTranscript({
    guildName: channel.guild.name,
    ticket,
    ownerName: owner?.username,
    messages: messages.filter((m) => !m.system || m.content).map(serialize),
    truncated,
  });

  return {
    file: new AttachmentBuilder(Buffer.from(html, 'utf8'), {
      name: `transcript-${pad(ticket.number)}.html`,
    }),
    count: messages.length,
    owner,
  };
}

/**
 * Sends the HTML transcript to the panel's transcript channel and DMs it to the opener.
 * Does nothing when the panel has no transcript channel, so unconfigured servers pay no cost.
 */
async function sendTranscript(client, ticket, channel) {
  if (!ticket.transcript_channel_id) return false;

  const target = await client.channels.fetch(ticket.transcript_channel_id).catch(() => null);
  if (!target?.isTextBased()) return false;

  const { file, count, owner } = await buildTranscript(channel, ticket);

  const embed = new EmbedBuilder()
    .setColor(config.colors.neutral)
    .setTitle(`Ticket #${pad(ticket.number)} transcript`)
    .addFields(
      { name: 'Opened by', value: `<@${ticket.owner_id}>`, inline: true },
      {
        name: 'Claimed by',
        value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Nobody',
        inline: true,
      },
      {
        name: 'Closed by',
        value: ticket.closed_by ? `<@${ticket.closed_by}>` : '—',
        inline: true,
      },
      { name: 'Messages', value: String(count), inline: true },
      { name: 'Opened', value: `<t:${ticket.created_at}:f>`, inline: true },
    );
  if (ticket.subject) embed.addFields({ name: 'Subject', value: ticket.subject.slice(0, 1024) });
  if (ticket.close_reason) {
    embed.addFields({ name: 'Close reason', value: ticket.close_reason.slice(0, 1024) });
  }

  const payload = { embeds: [embed], files: [file], allowedMentions: { parse: [] } };
  const results = await Promise.allSettled([
    target.send(payload),
    owner?.send({
      ...payload,
      embeds: [EmbedBuilder.from(embed).setFooter({ text: channel.guild.name })],
    }),
  ]);

  const delivered = results[0].status === 'fulfilled';
  if (delivered) q.markTranscript.run(ticket.id);
  else console.error('[transcript] could not post to the transcript channel:', results[0].reason);
  return delivered;
}

module.exports = { sendTranscript };
