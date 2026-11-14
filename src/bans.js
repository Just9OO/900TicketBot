// Members blocked from opening tickets.
const { q } = require('./db');

const nowSec = () => Math.floor(Date.now() / 1000);

/** The active ban for a member, or null. An expired ban is removed on the way. */
function activeBan(guildId, userId) {
  const ban = q.getBan.get(guildId, userId);
  if (!ban) return null;
  if (ban.expires_at && ban.expires_at <= nowSec()) {
    q.deleteBan.run(guildId, userId);
    return null;
  }
  return ban;
}

/** "30m", "12h", "7d", "2w" -> seconds. Empty or "perm" -> null (permanent). Bad text -> undefined. */
function parseDuration(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw || raw === 'perm' || raw === 'permanent' || raw === 'forever') return null;
  const match = /^(\d{1,4})\s*([mhdw])$/.exec(raw);
  if (!match) return undefined;
  const unit = { m: 60, h: 3600, d: 86400, w: 604800 }[match[2]];
  return Number(match[1]) * unit;
}

function banMessage(ban) {
  let text = 'You are blocked from opening tickets in this server.';
  if (ban.reason) text += `\n**Reason:** ${ban.reason}`;
  text += ban.expires_at ? `\nThis ends <t:${ban.expires_at}:R>.` : '\nThis block does not expire.';
  return text;
}

module.exports = { activeBan, parseDuration, banMessage, nowSec };
