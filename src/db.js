const fs = require('node:fs');
const path = require('node:path');
const Database = require('./sqlite');
const config = require('./config');
const { initDatabase, STATEMENTS } = require('./sql');

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL'); // readers never block the writer
db.pragma('synchronous = NORMAL'); // safe with WAL, far fewer fsyncs
db.pragma('temp_store = MEMORY');

// Creates the tables on a fresh database, upgrades one made by an older version, and builds
// topics for panels that predate them.
initDatabase(db);

// Every statement is compiled exactly once at startup and reused for the life of the process.
const q = Object.fromEntries(
  Object.entries(STATEMENTS).map(([name, sql]) => [name, db.prepare(sql)]),
);

function close() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    /* already closed */
  }
}

module.exports = { db, q, close };
