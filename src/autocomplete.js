// Autocomplete suggestions shared by several commands. Every lookup is limited to the current server.
const { q } = require('./db');
const { trunc } = require('./ui');

const respond = (i, choices) => i.respond(choices.slice(0, 25));
const matches = (focused, text) => text.toLowerCase().includes(focused);

/** Panels of this server, newest first. Value = panel id. */
function panels(i) {
  const focused = String(i.options.getFocused()).toLowerCase();
  const choices = q.panelsByGuild
    .all(i.guildId)
    .reverse()
    .map((p) => {
      const channel = i.guild.channels.cache.get(p.channel_id);
      const where = channel ? `#${channel.name}` : 'deleted channel';
      return { name: trunc(`Panel #${p.id} · ${p.type} · ${where}`, 100), value: p.id };
    })
    .filter((c) => matches(focused, c.name));
  return respond(i, choices);
}

/**
 * Topics of the panel chosen in the `panel` option, or of every panel when there is none
 * (used by /articles link). Value = topic id.
 */
function topics(i) {
  const focused = String(i.options.getFocused()).toLowerCase();
  const panelId = i.options.get('panel')?.value;

  let rows;
  if (panelId !== undefined) {
    const panel = q.getPanel.get(Number(panelId));
    rows = panel?.guild_id === i.guildId ? q.topicsByPanel.all(panel.id) : [];
  } else {
    rows = q.topicsByGuild.all(i.guildId);
  }
  const choices = rows
    .map((t) => ({
      name: trunc(`Panel #${t.panel_id} › ${t.label}${t.kind === 'application' ? ' (application)' : ''}`, 100),
      value: t.id,
    }))
    .filter((c) => matches(focused, c.name));
  return respond(i, choices);
}

/**
 * Help articles of this server. `asText` makes the value a string, for options that also
 * accept free text (/faq).
 */
function articles(i, { asText = false } = {}) {
  const focused = String(i.options.getFocused()).toLowerCase();
  const choices = q.kbByGuild
    .all(i.guildId)
    .filter((a) => matches(focused, `${a.title} ${a.keywords}`))
    .map((a) => ({
      name: trunc(`#${a.id} · ${a.title}${a.topic_id ? ' (linked)' : ''}`, 100),
      value: asText ? String(a.id) : a.id,
    }));
  return respond(i, choices);
}

module.exports = { panels, topics, articles };
