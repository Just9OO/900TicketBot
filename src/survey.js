// Star rating + optional comment, asked of the member after their ticket is closed.
const { MessageFlags } = require('discord.js');
const { q } = require('./db');
const ui = require('./ui');

const EPH = MessageFlags.Ephemeral;
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * DMs the opener a rating prompt (falling back to the ticket channel when their DMs are closed).
 * Only sent for normal tickets whose topic has a transcript channel, because that is where the
 * rating is delivered. Returns true when a prompt was sent.
 */
async function send(client, ticket, channel) {
  if (ticket.kind !== 'ticket' || !ticket.transcript_channel_id) return false;
  const panel = ticket.panel_id ? q.getPanel.get(ticket.panel_id) : null;
  if (panel && !panel.survey_enabled) return false;

  const handledBy =
    ticket.claimed_by ?? (ticket.closed_by !== ticket.owner_id ? ticket.closed_by : null);
  const inserted = q.insertSurvey.run({
    ticket_id: ticket.id,
    guild_id: ticket.guild_id,
    ticket_number: ticket.number,
    owner_id: ticket.owner_id,
    claimed_by: handledBy ?? null,
    subject: ticket.subject ?? null,
    dest_channel_id: ticket.transcript_channel_id,
    created_at: nowSec(),
  });
  if (!inserted.changes) return false; // this ticket was already asked once (closed, reopened, closed)

  const survey = q.surveyByTicket.get(ticket.id);
  const payload = {
    embeds: [ui.surveyEmbed(survey, channel.guild.name)],
    components: ui.surveyButtons(survey.id),
  };
  try {
    const user = await client.users.fetch(ticket.owner_id);
    await user.send(payload);
  } catch {
    await channel
      .send({
        content: `<@${ticket.owner_id}>`,
        ...payload,
        allowedMentions: { users: [ticket.owner_id] },
      })
      .catch(() => {});
  }
  return true;
}

const guildName = (i, survey) => i.client.guilds.cache.get(survey.guild_id)?.name ?? 'the server';

function problem(i, survey, ownerOnly = true) {
  if (!survey) return 'This rating request has expired.';
  if (ownerOnly && i.user.id !== survey.owner_id) return 'Only the ticket opener can rate this ticket.';
  if (survey.rating) return 'You have already rated this ticket. Thank you!';
  return null;
}

/** Star button -> ask for an optional comment. */
async function rate(i, [surveyId, stars]) {
  const survey = q.surveyById.get(Number(surveyId));
  const error = problem(i, survey);
  if (error) return i.reply({ embeds: [ui.fail(error)], flags: EPH });
  const n = Math.min(5, Math.max(1, Number(stars) || 0));
  return i.showModal(ui.rateModal(survey.id, n));
}

/** Comment submitted -> store the rating (once) and deliver it to staff. */
async function rateSubmit(i, [surveyId, stars]) {
  const survey = q.surveyById.get(Number(surveyId));
  const error = problem(i, survey);
  if (error) return i.reply({ embeds: [ui.fail(error)], flags: EPH });

  const rating = Math.min(5, Math.max(1, Number(stars) || 0));
  const comment = i.fields.getTextInputValue('comment').trim() || null;
  const stored = q.rateSurvey.run(rating, comment, nowSec(), survey.id);
  if (!stored.changes) {
    return i.reply({ embeds: [ui.fail('You have already rated this ticket. Thank you!')], flags: EPH });
  }

  await i.update({ embeds: [ui.ratedEmbed(rating)], components: [] });

  const dest = await i.client.channels.fetch(survey.dest_channel_id).catch(() => null);
  if (dest?.isTextBased()) {
    await dest
      .send({
        embeds: [ui.feedbackEmbed(survey, rating, comment, guildName(i, survey))],
        allowedMentions: { parse: [] },
      })
      .catch((err) => console.error('[survey] could not deliver the rating:', err.message));
  }
}

module.exports = { send, rate, rateSubmit };
