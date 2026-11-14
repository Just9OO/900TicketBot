const { ActivityType, Client, Events, GatewayIntentBits, Options } = require('discord.js');
const config = require('./config');
const { q, close: closeDb } = require('./db');
const { syncCommands } = require('./deploy');
const { handleInteraction } = require('./handlers');

const client = new Client({
  // Slash commands, buttons and modals all arrive as interactions, and transcripts are read over
  // REST, so the Guilds intent is all we need: no message, member or presence events.
  intents: [GatewayIntentBits.Guilds],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    ReactionManager: 0,
    PresenceManager: 0,
    VoiceStateManager: 0,
    StageInstanceManager: 0,
    GuildScheduledEventManager: 0,
    GuildInviteManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    GuildBanManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    UserManager: { maxSize: 100, keepOverLimit: (user) => user.id === user.client.user?.id },
    GuildMemberManager: { maxSize: 50, keepOverLimit: (member) => member.id === member.client.user?.id },
  }),
});

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in as ${ready.user.tag} in ${ready.guilds.cache.size} server(s).`);
  try {
    const changed = await syncCommands(ready);
    console.log(changed ? 'Slash commands registered.' : 'Slash commands already up to date.');
  } catch (err) {
    console.error('Could not register slash commands:', err);
  }
  ready.user.setPresence({ activities: [{ name: '/help • tickets', type: ActivityType.Watching }] });
});

client.on(Events.InteractionCreate, handleInteraction);

// If a ticket channel is deleted by hand, forget it so the opener can open a new one.
client.on(Events.ChannelDelete, (channel) => {
  if (channel.guildId) q.deleteByChannel.run(channel.id);
});

client.on(Events.Error, (err) => console.error('[client]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

function shutdown() {
  client.destroy();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A wrong token used to leave the process alive but doing nothing, so nothing would ever restart it.
client.login(config.token).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
