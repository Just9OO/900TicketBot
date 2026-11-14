# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [3.0.0]

**Added**
- Ticket priority: `/ticket priority` sets low, normal, high or urgent, shown on the ticket's first message (new `priority` column, added automatically)
- `/ticket transfer` hands a ticket to another member of the staff role
- `/ticket info` shows a card with the ticket's details
- `/mytickets` lists the member's own open tickets with links
- A "Go to your ticket" link button after opening a ticket or application

**Changed**
- Major version because the command set grew. Existing commands and data are unchanged, and the database upgrades itself on startup
- Dependencies updated: discord.js 14.28, better-sqlite3 13 and dotenv 18
- **Node.js 22 or newer is now required** (Node 20 reached end of life). Node 24 LTS is recommended

**Project**
- New README with a banner and mock-up images, CHANGELOG, SECURITY and CONTRIBUTING files, issue and pull request templates, a CI workflow and Dependabot

## [2.1.0]

**Changed**
- Only staff can reopen a closed ticket. The opener sees the Reopen button but is told it is staff only
- Closing keeps the opener's view of the channel, and reopening restores their view and send permissions. The bot warns staff if it cannot unlock them

**Fixed**
- Importing a template could keep a banner image hosted anywhere. Banners must now be hosted by Discord, otherwise they are left out and you are told
- A wrong or revoked bot token left the process running but idle. It now logs "Login failed" and exits, so a process manager can restart it
- Hosts whose Linux is too old for the better-sqlite3 binary ("GLIBC_2.38 not found") no longer crash the bot. It falls back to the SQLite built into Node.js 22.5 or newer, using the same database file
- Reopen and Delete buttons are now also on the ticket's first message once it is closed, not only on the closing card
- Saving a new help article with `/articles add` failed after the rename from `/kb`

**Added**
- Ticket welcome message shows the opener's name and avatar, a relative "Opened" time and a footer hint
- Closed-ticket card shows how long the ticket was open
- Progress meters (block characters) for ratings and for open versus closed counts in `/stats` and in rating feedback

**Changed**
- Redesigned embeds: icons and clearer titles, a colour-coded status line, a closed-ticket card with "Closed by" and "Reason" fields, a progress footer on the dropdown-question step, and nicer decision and rating messages
- `/setup` now lists your panels on the home screen, shows a breadcrumb (Main, Settings, Topics), warns what is still missing before you can post, and has icons on every picker
- `/help`, `/stats`, `/panel list`, `/admin banlist` and `/articles list` have a cleaner layout. `/stats` adds totals, a rating line and medals for top staff
- Clearer command names: `/kb` is now `/articles`, `/panel form` is now `/panel questions`, `/ticket add-user` and `remove-user` are now `/ticket add` and `/ticket remove`, `/ticket close-request` is now `/ticket request-close`, and `/admin bans` is now `/admin banlist`
- The `/setup` button "Questions, limit & color" is now "Form & limits"

## [2.0.0]

**Added**
- `/setup` dashboard with channel and role pickers, toggles, forms, topic editor, live preview, and edit or delete for existing panels
- Panel look: title, colour, banner image, footer, optional topic list in the embed and button colours
- Dropdown questions in forms, written as `Platform? [PC, Console, Mobile]`
- Live ticket status in the welcome message (Open, Claimed, Closed, and application states)
- Ticket log channel with `/admin log`
- Ticket bans with `/admin ban`, `/admin unban` and `/admin banlist`
- Panel templates with `/panel export` and `/panel import`

**Changed**
- Commands are grouped: `/panel` (create, list, delete, form, topic, export, import), `/ticket` (claim, close, request-close, add, remove, rename, reopen, delete, open) and `/admin` (purge, ban, unban, banlist, log). `/close` and `/claim` stay as shortcuts
- `/topic` is now `/panel topic`, `/form` is now `/panel questions`, `/open` is now `/ticket open`, and the other ticket commands moved under `/ticket`
- `/purge` is now `/admin purge`

**Removed**
- `/roleall`

## [1.1.0]

**Added**
- `create_categories` on `/panel` and `create_category` on `/topic` for a private category per option
- Forms on any panel type
- `/open` and `/stats`

**Fixed**
- Two people closing a ticket at once could send two transcripts and two rating prompts
- Long form answers plus a long ticket message could exceed Discord's 6000 character embed limit and fail ticket creation
- Several long help articles in one message could exceed the same limit
- `/remove-user` could remove the bot from its own ticket
- Links containing `__` or `*` were broken in transcripts
- Moving the bot to a different application kept the old command hash and skipped registering commands

## [1.0.0]
Initial release: panels, topics, applications, ratings, help articles, close requests, claiming and HTML transcripts.
