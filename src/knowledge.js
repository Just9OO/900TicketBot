// Knowledge base: finds help articles for a question, with no external service.
//
// Articles can be linked to a topic (always suggested for it) and every article is also
// matched against what the member wrote, using the keywords the staff gave it.
const crypto = require('node:crypto');
const { q } = require('./db');

const MAX_ARTICLES = 100; // per server, keeps the in-memory index small
const MIN_SCORE = 3; // one keyword hit, or a title word plus a body word

const STOP_WORDS = new Set(
  (
    'the and for are but not you your can how what when where why who with this that have has had ' +
    'was were been from they them their there then than into out about just like need want get got ' +
    'please help hello hey thanks thank would could should will does did any all some more very ' +
    'also its our his her she him one two too off per via'
  ).split(' '),
);

const tokens = (text) => [
  ...new Set(
    (String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)),
  ),
];

function prepare(row) {
  const phrases = row.keywords
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    row,
    phrases: phrases.filter((p) => p.includes(' ')),
    keywordTokens: new Set(phrases.flatMap(tokens)),
    titleTokens: new Set(tokens(row.title)),
    bodyTokens: new Set(tokens(row.body)),
  };
}

const index = new Map(); // guildId -> prepared articles; rebuilt after any change

function load(guildId) {
  let list = index.get(guildId);
  if (!list) {
    list = q.kbByGuild.all(guildId).map(prepare);
    index.set(guildId, list);
  }
  return list;
}

const invalidate = (guildId) => index.delete(guildId);

function score(article, lowerText, queryTokens) {
  let total = 0;
  for (const word of queryTokens) {
    if (article.keywordTokens.has(word)) total += 3;
    if (article.titleTokens.has(word)) total += 2;
    if (article.bodyTokens.has(word)) total += 1;
  }
  for (const phrase of article.phrases) if (lowerText.includes(phrase)) total += 4;
  return total;
}

/** Best keyword matches for some text, highest score first. */
function search(guildId, text, limit = 3) {
  const lowerText = String(text ?? '').toLowerCase();
  const queryTokens = tokens(lowerText);
  if (!queryTokens.length) return [];
  return load(guildId)
    .map((article) => ({ row: article.row, score: score(article, lowerText, queryTokens) }))
    .filter((hit) => hit.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.row);
}

/** Articles linked to the topic first, then keyword matches, without duplicates. */
function suggest(guildId, topic, text, limit = 3) {
  const linked = topic ? q.kbByTopic.all(topic.id) : [];
  const seen = new Set(linked.map((a) => a.id));
  const matched = search(guildId, text, limit + linked.length).filter((a) => !seen.has(a.id));
  return [...linked, ...matched].slice(0, limit);
}

// Holds "what the member typed" while they decide whether the suggestions solved it.
const pending = new Map();
const PENDING_MS = 10 * 60 * 1000;

function stash(data) {
  const token = crypto.randomBytes(6).toString('hex');
  pending.set(token, { ...data, expires: Date.now() + PENDING_MS });
  return token;
}

/** Returns the stashed data once, and only to the member it belongs to. */
function take(token, userId) {
  const entry = pending.get(token);
  if (!entry || entry.expires < Date.now() || entry.userId !== userId) return null;
  pending.delete(token);
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pending) if (entry.expires < now) pending.delete(token);
}, 60 * 1000).unref();

module.exports = { MAX_ARTICLES, search, suggest, invalidate, stash, take };
