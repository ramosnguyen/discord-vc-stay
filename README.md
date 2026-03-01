# discord-vc-stay (selfbot)

TypeScript CLI to keep a Discord **user account** connected to a specific voice/stage channel with automatic reconnect.

> **Warning:** Using a user token (selfbot) may violate Discord's Terms of Service. Use at your own risk.

## Requirements
- Node.js 20+
- [Bun](https://bun.sh/) 1.0+
- A Discord user token
- Your account must be a member of the target server with voice permissions

## Getting your user token

1. Open Discord in a browser
2. Press F12 to open DevTools
3. Go to the **Network** tab
4. Send a message or perform any action
5. Look for a request to `discord.com/api` and find the `Authorization` header — that's your user token

## Install

```bash
bun install
```

## Run (Windows or Linux)

```bash
bun run start -- --token YOUR_USER_TOKEN --guild-id YOUR_GUILD_ID --channel-id YOUR_CHANNEL_ID
```

Optional:

```bash
bun run start -- --token YOUR_USER_TOKEN --guild-id YOUR_GUILD_ID --channel-id YOUR_CHANNEL_ID --log-level info
```

## Run with environment variables

PowerShell:

```powershell
$env:DISCORD_TOKEN="YOUR_USER_TOKEN"
$env:DISCORD_GUILD_ID="YOUR_GUILD_ID"
$env:DISCORD_CHANNEL_ID="YOUR_CHANNEL_ID"
$env:LOG_LEVEL="info"
bun run start
```

Bash:

```bash
DISCORD_TOKEN=YOUR_USER_TOKEN \
DISCORD_GUILD_ID=YOUR_GUILD_ID \
DISCORD_CHANNEL_ID=YOUR_CHANNEL_ID \
LOG_LEVEL=info \
bun run start
```

## Docker (Linux, VPS, NAS)

Build image:

```bash
docker build -t discord-vc-stay .
```

Run container:

```bash
docker run -d \
  --name discord-vc-stay \
  --restart unless-stopped \
  -e DISCORD_TOKEN=YOUR_USER_TOKEN \
  -e DISCORD_GUILD_ID=YOUR_GUILD_ID \
  -e DISCORD_CHANNEL_ID=YOUR_CHANNEL_ID \
  -e LOG_LEVEL=info \
  discord-vc-stay
```

## Docker Compose

Create `.env`:

```env
DISCORD_TOKEN=YOUR_USER_TOKEN
DISCORD_GUILD_ID=YOUR_GUILD_ID
DISCORD_CHANNEL_ID=YOUR_CHANNEL_ID
LOG_LEVEL=info
```

Then run:

```bash
docker compose up -d --build
```

## CLI help

```bash
bun run start -- --help
```

## Notes

- The process reconnects automatically with exponential backoff.
- Keep host machine/container online for 24/7 uptime.
- If channel/guild IDs are wrong, startup will fail and retry until fixed.

