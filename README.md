# hxlftone

Static landing page plus an optional Discord media repost bot.

## Media repost bot

The bot watches opt-in Discord channels for YouTube, TikTok, and Instagram links. When a supported video can be downloaded under the configured size limit, it reposts the clip as a Discord attachment and deletes the original link message when it has `Manage Messages`.

It can also enforce link-only posting in channels like finished-edits. In those channels, messages that contain anything besides links are removed and the user gets an embed-style DM explaining what happened.

### Requirements

- Node.js 20+
- `yt-dlp` available on the host
- A Discord bot token
- Bot intents enabled in the Discord Developer Portal:
  - Server Members intent is not needed
  - Message Content intent is needed

### Setup

```sh
cp .env.example .env
npm install
npm run start:bot
```

Configure `.env`:

```sh
DISCORD_TOKEN=your_bot_token
DISCORD_MEDIA_CHANNEL_IDS=123456789012345678,234567890123456789
DISCORD_LINK_ONLY_CHANNEL_IDS=345678901234567890
MAX_VIDEO_BYTES=24000000
YTDLP_BIN=yt-dlp
YTDLP_COOKIES_FILE=
```

`DISCORD_MEDIA_CHANNEL_IDS` controls where video links are downloaded and reposted. `DISCORD_LINK_ONLY_CHANNEL_IDS` controls channels where users may post links only; use your finished-edits channel ID there. A channel can be in both lists.

The bot needs these Discord permissions in enabled channels:

- View Channel
- Read Message History
- Send Messages
- Attach Files
- Manage Messages, only if you want it to remove the original link
