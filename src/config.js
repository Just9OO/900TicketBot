require('dotenv').config({ quiet: true });

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

module.exports = {
  token,
  guildId: process.env.GUILD_ID || null,
  dbPath: process.env.DB_PATH || './data/tickets.db',
  maxTranscriptMessages: int(process.env.MAX_TRANSCRIPT_MESSAGES, 5000),
  createCooldownMs: int(process.env.CREATE_COOLDOWN_SECONDS, 10) * 1000,
  deleteDelayMs: 5000,
  colors: {
    primary: 0x5865f2,
    success: 0x57f287,
    danger: 0xed4245,
    warn: 0xfee75c,
    neutral: 0x2b2d31,
  },
};
