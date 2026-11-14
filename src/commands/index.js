// Loads every command file in this folder into a Map keyed by command name.
const fs = require('node:fs');
const path = require('node:path');

const commands = new Map();

for (const file of fs.readdirSync(__dirname)) {
  if (file === 'index.js' || !file.endsWith('.js')) continue;
  const command = require(path.join(__dirname, file));
  commands.set(command.data.name, command);
}

module.exports = commands;
