// npm run check: parses every source file and reports syntax errors. No Discord connection needed.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));

const files = ['src', 'scripts'].flatMap(walk);
let bad = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    bad += 1;
    console.error(`${file}\n${err.stderr}`);
  }
}
console.log(`${files.length - bad}/${files.length} files parse`);
process.exit(bad ? 1 : 0);
