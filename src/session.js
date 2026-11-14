// Short-lived in-memory state for multi-step screens: the /setup dashboard and dropdown
// questions. Entries belong to one user, expire after 30 minutes and vanish on restart.
const crypto = require('node:crypto');

const TTL_MS = 30 * 60 * 1000;
const store = new Map();

function create(userId, data) {
  const token = crypto.randomBytes(5).toString('hex');
  store.set(token, { userId, data, expires: Date.now() + TTL_MS });
  return token;
}

/** The data for a token, only for the user it belongs to. Refreshes the expiry. */
function get(token, userId) {
  const entry = store.get(token);
  if (!entry || entry.expires < Date.now() || entry.userId !== userId) return null;
  entry.expires = Date.now() + TTL_MS;
  return entry.data;
}

const remove = (token) => store.delete(token);

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store) if (entry.expires < now) store.delete(token);
}, 60 * 1000).unref();

module.exports = { create, get, remove };
