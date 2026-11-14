// Pure SQL (no driver imports) so the schema, migrations and statements can be tested anywhere.
// Works with any driver exposing exec() and prepare().all()/run() (better-sqlite3, node:sqlite).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  guild_id TEXT PRIMARY KEY,
  n        INTEGER NOT NULL
);

-- A panel is the message members click on. Its settings are the defaults for its topics.
CREATE TABLE IF NOT EXISTS panels (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id              TEXT    NOT NULL,
  channel_id            TEXT    NOT NULL,
  message_id            TEXT,
  type                  TEXT    NOT NULL CHECK (type IN ('click', 'form', 'sidebar')),
  staff_role_id         TEXT    NOT NULL,
  claim_enabled         INTEGER NOT NULL DEFAULT 1,
  transcript_channel_id TEXT,
  category_id           TEXT,
  ticket_message        TEXT,
  options               TEXT,
  max_tickets           INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL
);

-- A topic is one button / dropdown entry on a panel. NULL fields inherit from the panel.
CREATE TABLE IF NOT EXISTS topics (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  panel_id              INTEGER NOT NULL,
  position              INTEGER NOT NULL DEFAULT 0,
  label                 TEXT    NOT NULL,
  emoji                 TEXT,
  description           TEXT,
  kind                  TEXT    NOT NULL DEFAULT 'ticket' CHECK (kind IN ('ticket', 'application')),
  staff_role_id         TEXT,
  category_id           TEXT,
  transcript_channel_id TEXT,
  max_tickets           INTEGER,
  questions             TEXT,
  ticket_message        TEXT,
  accept_role_id        TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id              TEXT    NOT NULL,
  number                INTEGER NOT NULL,
  channel_id            TEXT    NOT NULL UNIQUE,
  panel_id              INTEGER,
  topic_id              INTEGER,
  kind                  TEXT    NOT NULL DEFAULT 'ticket',
  owner_id              TEXT    NOT NULL,
  staff_role_id         TEXT    NOT NULL,
  transcript_channel_id TEXT,
  claim_enabled         INTEGER NOT NULL DEFAULT 1,
  accept_role_id        TEXT,
  app_status            TEXT,
  app_by                TEXT,
  app_note              TEXT,
  subject               TEXT,
  welcome_message_id    TEXT,
  claimed_by            TEXT,
  status                TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by             TEXT,
  close_reason          TEXT,
  transcript_sent       INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  closed_at             INTEGER
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  keywords   TEXT    NOT NULL DEFAULT '',
  topic_id   INTEGER,
  created_at INTEGER NOT NULL
);

-- Outlives the ticket, so a rating can still arrive after the channel was deleted.
CREATE TABLE IF NOT EXISTS surveys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       INTEGER NOT NULL,
  guild_id        TEXT    NOT NULL,
  ticket_number   INTEGER NOT NULL,
  owner_id        TEXT    NOT NULL,
  claimed_by      TEXT,
  subject         TEXT,
  dest_channel_id TEXT    NOT NULL,
  rating          INTEGER,
  comment         TEXT,
  created_at      INTEGER NOT NULL,
  rated_at        INTEGER
);

-- Members blocked from opening tickets. expires_at NULL means permanent.
CREATE TABLE IF NOT EXISTS bans (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  reason     TEXT,
  banned_by  TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id       TEXT PRIMARY KEY,
  log_channel_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets (guild_id, status);
CREATE INDEX IF NOT EXISTS idx_panels_guild         ON panels  (guild_id);
CREATE INDEX IF NOT EXISTS idx_topics_panel         ON topics  (panel_id, position);
CREATE INDEX IF NOT EXISTS idx_kb_guild             ON kb_articles (guild_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_ticket ON surveys (ticket_id);
`;

// Columns added after v1.0. A v1.0 database keeps its data and gains these on startup.
const MIGRATIONS = [
  ['tickets', 'topic_id', 'INTEGER'],
  ['tickets', 'kind', "TEXT NOT NULL DEFAULT 'ticket'"],
  ['tickets', 'accept_role_id', 'TEXT'],
  ['tickets', 'app_status', 'TEXT'],
  ['tickets', 'app_by', 'TEXT'],
  ['tickets', 'app_note', 'TEXT'],
  // Panel-wide switches: DM a star rating after close, and when to show knowledge-base articles
  // ('off', 'inside' the new ticket, or 'before' the ticket is created).
  ['panels', 'survey_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['panels', 'kb_mode', "TEXT NOT NULL DEFAULT 'inside'"],
  // Ask for a form on any panel type, and default form questions that topics inherit.
  ['panels', 'form_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['panels', 'questions', 'TEXT'],
  // What the panel message looks like, kept so it can be edited and rebuilt later.
  ['panels', 'title', 'TEXT'],
  ['panels', 'description', 'TEXT'],
  ['panels', 'color', 'INTEGER'],
  ['panels', 'image_url', 'TEXT'],
  ['panels', 'footer', 'TEXT'],
  ['panels', 'show_list', 'INTEGER NOT NULL DEFAULT 1'],
  ['topics', 'button_style', 'TEXT'],
  ['tickets', 'priority', 'TEXT'], // null = normal, else low | high | urgent
];

// Indexes on migrated columns can only be created once the columns exist.
const POST_MIGRATION = `
CREATE INDEX IF NOT EXISTS idx_tickets_owner_topic ON tickets (guild_id, owner_id, topic_id, status);
CREATE INDEX IF NOT EXISTS idx_kb_topic            ON kb_articles (topic_id);
`;

function applyMigrations(db) {
  for (const [table, column, ddl] of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
}

/** Panels made before topics existed get topics built from their old dropdown options. */
function backfillTopics(db) {
  const panels = db
    .prepare('SELECT * FROM panels p WHERE NOT EXISTS (SELECT 1 FROM topics t WHERE t.panel_id = p.id)')
    .all();
  if (!panels.length) return 0;

  const insert = db.prepare('INSERT INTO topics (panel_id, position, label) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const panel of panels) {
      let labels = ['Open a Ticket'];
      if (panel.type === 'sidebar' && panel.options) {
        try {
          const parsed = JSON.parse(panel.options);
          if (Array.isArray(parsed) && parsed.length) labels = parsed;
        } catch {
          /* fall back to the default label */
        }
      }
      labels.forEach((label, index) => insert.run(panel.id, index, String(label)));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return panels.length;
}

function initDatabase(db) {
  db.exec(SCHEMA);
  applyMigrations(db);
  db.exec(POST_MIGRATION);
  backfillTopics(db);
}

const TOPIC_COLUMNS =
  'panel_id, position, label, emoji, description, kind, staff_role_id, category_id, ' +
  'transcript_channel_id, max_tickets, questions, ticket_message, accept_role_id, button_style';

const STATEMENTS = {
  // meta
  getMeta: 'SELECT value FROM meta WHERE key = ?',
  setMeta:
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',

  // per-guild ticket numbering (never reused, even after /purge)
  nextNumber:
    'INSERT INTO counters (guild_id, n) VALUES (?, 1) ON CONFLICT(guild_id) DO UPDATE SET n = n + 1 RETURNING n',

  // panels
  insertPanel: `INSERT INTO panels
    (guild_id, channel_id, type, staff_role_id, claim_enabled, transcript_channel_id,
     category_id, ticket_message, options, max_tickets, created_at, survey_enabled, kb_mode,
     form_enabled, questions, title, description, color, image_url, footer, show_list)
    VALUES
    (@guild_id, @channel_id, @type, @staff_role_id, @claim_enabled, @transcript_channel_id,
     @category_id, @ticket_message, @options, @max_tickets, @created_at, @survey_enabled, @kb_mode,
     @form_enabled, @questions, @title, @description, @color, @image_url, @footer, @show_list)`,
  updatePanel: `UPDATE panels SET
    type = @type, staff_role_id = @staff_role_id, claim_enabled = @claim_enabled,
    transcript_channel_id = @transcript_channel_id, category_id = @category_id,
    ticket_message = @ticket_message, max_tickets = @max_tickets, survey_enabled = @survey_enabled,
    kb_mode = @kb_mode, form_enabled = @form_enabled, questions = @questions, title = @title,
    description = @description, color = @color, image_url = @image_url, footer = @footer,
    show_list = @show_list
    WHERE id = @id`,
  setPanelMessage: 'UPDATE panels SET message_id = ? WHERE id = ?',
  setPanelForm: 'UPDATE panels SET form_enabled = ?, questions = ? WHERE id = ?',
  getPanel: 'SELECT * FROM panels WHERE id = ?',
  deletePanel: 'DELETE FROM panels WHERE id = ?',
  panelsByGuild: 'SELECT * FROM panels WHERE guild_id = ? ORDER BY id',

  // topics
  insertTopic: `INSERT INTO topics (${TOPIC_COLUMNS})
    VALUES (@panel_id, @position, @label, @emoji, @description, @kind, @staff_role_id, @category_id,
            @transcript_channel_id, @max_tickets, @questions, @ticket_message, @accept_role_id,
            @button_style)`,
  updateTopic: `UPDATE topics SET
    label = @label, emoji = @emoji, description = @description, kind = @kind,
    staff_role_id = @staff_role_id, category_id = @category_id,
    transcript_channel_id = @transcript_channel_id, max_tickets = @max_tickets,
    questions = @questions, ticket_message = @ticket_message, accept_role_id = @accept_role_id,
    position = @position, button_style = @button_style
    WHERE id = @id`,
  getTopic: 'SELECT * FROM topics WHERE id = ?',
  topicsByPanel: 'SELECT * FROM topics WHERE panel_id = ? ORDER BY position, id',
  topicsByGuild: `SELECT t.*, p.channel_id AS panel_channel_id
    FROM topics t JOIN panels p ON p.id = t.panel_id
    WHERE p.guild_id = ? ORDER BY t.panel_id, t.position, t.id`,
  nextTopicPosition: 'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM topics WHERE panel_id = ?',
  countTopics: 'SELECT COUNT(*) AS n FROM topics WHERE panel_id = ?',
  deleteTopic: 'DELETE FROM topics WHERE id = ?',
  deleteTopicsByPanel: 'DELETE FROM topics WHERE panel_id = ?',

  // tickets
  insertTicket: `INSERT INTO tickets
    (guild_id, number, channel_id, panel_id, topic_id, kind, owner_id, staff_role_id,
     transcript_channel_id, claim_enabled, accept_role_id, app_status, subject, created_at)
    VALUES
    (@guild_id, @number, @channel_id, @panel_id, @topic_id, @kind, @owner_id, @staff_role_id,
     @transcript_channel_id, @claim_enabled, @accept_role_id, @app_status, @subject, @created_at)`,
  ticketByChannel: 'SELECT * FROM tickets WHERE channel_id = ?',
  ticketById: 'SELECT * FROM tickets WHERE id = ?',
  openByOwnerTopic:
    "SELECT channel_id FROM tickets WHERE guild_id = ? AND owner_id = ? AND topic_id = ? AND status = 'open'",
  setWelcome: 'UPDATE tickets SET welcome_message_id = ? WHERE id = ?',
  setClaimed: 'UPDATE tickets SET claimed_by = ? WHERE id = ?',
  setPriority: 'UPDATE tickets SET priority = ? WHERE id = ?',
  openByOwner: "SELECT * FROM tickets WHERE guild_id = ? AND owner_id = ? AND status = 'open' ORDER BY id DESC LIMIT 20",
  // Only a pending application can be decided, so two staff members pressing Accept or Deny at
  // the same moment cannot both succeed: the second update changes 0 rows.
  setAppStatus:
    "UPDATE tickets SET app_status = ?, app_by = ?, app_note = ? WHERE id = ? AND app_status = 'pending'",
  closeTicket:
    "UPDATE tickets SET status = 'closed', closed_by = ?, close_reason = ?, closed_at = ? WHERE id = ? AND status = 'open'",
  reopenTicket:
    "UPDATE tickets SET status = 'open', closed_by = NULL, close_reason = NULL, closed_at = NULL, transcript_sent = 0 WHERE id = ?",
  markTranscript: 'UPDATE tickets SET transcript_sent = 1 WHERE id = ?',
  deleteByChannel: 'DELETE FROM tickets WHERE channel_id = ?',
  listByGuild: 'SELECT id, channel_id, status FROM tickets WHERE guild_id = ?',
  listByGuildStatus: 'SELECT id, channel_id, status FROM tickets WHERE guild_id = ? AND status = ?',
  deleteById: 'DELETE FROM tickets WHERE id = ?',

  // knowledge base
  insertKb: `INSERT INTO kb_articles (guild_id, title, body, keywords, topic_id, created_at)
    VALUES (@guild_id, @title, @body, @keywords, @topic_id, @created_at)`,
  kbByGuild: 'SELECT * FROM kb_articles WHERE guild_id = ? ORDER BY id',
  kbCount: 'SELECT COUNT(*) AS n FROM kb_articles WHERE guild_id = ?',
  kbByTopic: 'SELECT * FROM kb_articles WHERE topic_id = ? ORDER BY id LIMIT 3',
  kbGet: 'SELECT * FROM kb_articles WHERE id = ? AND guild_id = ?',
  kbDelete: 'DELETE FROM kb_articles WHERE id = ? AND guild_id = ?',
  kbLink: 'UPDATE kb_articles SET topic_id = ? WHERE id = ? AND guild_id = ?',
  kbUnlinkTopic: 'UPDATE kb_articles SET topic_id = NULL WHERE topic_id = ?',

  // bans and settings
  getBan: 'SELECT * FROM bans WHERE guild_id = ? AND user_id = ?',
  upsertBan: `INSERT INTO bans (guild_id, user_id, reason, banned_by, created_at, expires_at)
    VALUES (@guild_id, @user_id, @reason, @banned_by, @created_at, @expires_at)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason,
      banned_by = excluded.banned_by, created_at = excluded.created_at, expires_at = excluded.expires_at`,
  deleteBan: 'DELETE FROM bans WHERE guild_id = ? AND user_id = ?',
  listBans: 'SELECT * FROM bans WHERE guild_id = ? ORDER BY created_at DESC LIMIT 25',
  getSettings: 'SELECT * FROM guild_settings WHERE guild_id = ?',
  setLogChannel: `INSERT INTO guild_settings (guild_id, log_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET log_channel_id = excluded.log_channel_id`,

  // stats
  countByStatus: 'SELECT status, kind, COUNT(*) AS n FROM tickets WHERE guild_id = ? GROUP BY status, kind',
  closedSince: "SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'closed' AND closed_at >= ?",
  ratingStats:
    'SELECT COUNT(rating) AS n, AVG(rating) AS avg FROM surveys WHERE guild_id = ? AND rating IS NOT NULL',
  topStaff: `SELECT claimed_by, COUNT(rating) AS n, AVG(rating) AS avg FROM surveys
    WHERE guild_id = ? AND rating IS NOT NULL AND claimed_by IS NOT NULL
    GROUP BY claimed_by ORDER BY n DESC, avg DESC LIMIT 5`,

  // surveys
  insertSurvey: `INSERT OR IGNORE INTO surveys
    (ticket_id, guild_id, ticket_number, owner_id, claimed_by, subject, dest_channel_id, created_at)
    VALUES
    (@ticket_id, @guild_id, @ticket_number, @owner_id, @claimed_by, @subject, @dest_channel_id, @created_at)`,
  surveyByTicket: 'SELECT * FROM surveys WHERE ticket_id = ?',
  surveyById: 'SELECT * FROM surveys WHERE id = ?',
  rateSurvey: 'UPDATE surveys SET rating = ?, comment = ?, rated_at = ? WHERE id = ? AND rating IS NULL',
};

module.exports = { SCHEMA, MIGRATIONS, POST_MIGRATION, STATEMENTS, initDatabase, applyMigrations, backfillTopics };
