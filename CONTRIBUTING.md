# Contributing

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Set up

```bash
git clone https://github.com/Just9OO/900TicketBot.git
cd 900TicketBot
npm install
cp .env.example .env     # add a test bot's token, and set GUILD_ID to a test server
npm run dev              # restarts on file changes
```

Use **Node.js 22 or newer** (24 LTS recommended).

## Before you open a pull request

1. Create a branch: `git checkout -b feature/my-change`
2. Keep to the existing style: CommonJS, no build step, all SQL in `src/sql.js` as prepared statements, all embeds and components in `src/ui.js`.
3. Run `npm run check` (it parses every file).
4. Try the change on a test server.
5. Update `README.md` and `CHANGELOG.md` if behaviour changed.

## Adding a command

Add one file to `src/commands/` that exports `data` (a `SlashCommandBuilder`) and `execute(interaction)`. It is loaded automatically. Keep command names short and lowercase, and group related actions as subcommands.
