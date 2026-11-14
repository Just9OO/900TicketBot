// Picks the SQLite driver. better-sqlite3 is used when it loads. Some hosts (older Linux images) cannot
// load its prebuilt binary ("GLIBC_2.38 not found", ERR_DLOPEN_FAILED), so the bot then falls back to the
// SQLite built into Node itself (node:sqlite, Node 22.5 or newer) through a small adapter with the same API.
// The database file is the same either way.
let Driver;
try {
  Driver = require('better-sqlite3');
} catch (nativeError) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    nativeError.message += '\n\nThe built-in fallback needs Node.js 22.5 or newer. Update Node, or install a better-sqlite3 build that matches this system.';
    throw nativeError;
  }
  console.warn(`[db] better-sqlite3 could not load (${String(nativeError.message).split('\n')[0]}). Using Node's built-in SQLite instead.`);

  const invalid = (v) => typeof v === 'boolean' || v === undefined;
  const complain = (name) => new TypeError(`SQLite3 can only bind numbers, strings, bigints, buffers, and null${name ? ` (${name})` : ''}`);

  class Statement {
    constructor(stmt, sql) {
      this.stmt = stmt;
      this.names = [...new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1]))];
    }
    bind(args) {
      const [first] = args;
      if (args.length === 1 && first && typeof first === 'object' && !Array.isArray(first) && !Buffer.isBuffer(first)) {
        const params = {};
        for (const name of this.names) {
          if (!(name in first)) throw new RangeError(`Missing named parameter "${name}"`);
          if (invalid(first[name])) throw complain(name);
          params[name] = first[name];
        }
        return [params];
      }
      const flat = args.length === 1 && Array.isArray(first) ? first : args;
      if (flat.some(invalid)) throw complain();
      return flat;
    }
    run(...args) { return this.stmt.run(...this.bind(args)); }
    get(...args) { return this.stmt.get(...this.bind(args)); }
    all(...args) { return this.stmt.all(...this.bind(args)); }
  }

  Driver = class Database {
    constructor(file) {
      this.inner = new DatabaseSync(file);
      this.depth = 0;
    }
    exec(sql) { return this.inner.exec(sql); }
    pragma(text) { return this.inner.prepare(`PRAGMA ${text}`).all(); }
    prepare(sql) { return new Statement(this.inner.prepare(sql), sql); }
    // Like better-sqlite3: a transaction inside a transaction becomes a savepoint.
    transaction(fn) {
      return (...args) => {
        const outer = this.depth === 0;
        const mark = `sp${this.depth}`;
        this.inner.exec(outer ? 'BEGIN' : `SAVEPOINT ${mark}`);
        this.depth += 1;
        try {
          const result = fn(...args);
          this.depth -= 1;
          this.inner.exec(outer ? 'COMMIT' : `RELEASE ${mark}`);
          return result;
        } catch (err) {
          this.depth -= 1;
          this.inner.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${mark}; RELEASE ${mark}`);
          throw err;
        }
      };
    }
    close() { this.inner.close(); }
  };
}
module.exports = Driver;
