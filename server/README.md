# hapi-server

Telegram bot + HTTP API + realtime updates for hapi.

## What it does
- Telegram bot for notifications and the Mini App entrypoint.
- HTTP API for sessions, messages, permissions, machines, and files.
- Server-Sent Events stream for live updates in the web app.
- Socket.IO channel for CLI connections.
- Serves the web app from `web/dist` or embedded assets in the single binary.
- Persists state in SQLite.

## Typical deployment flow
1. Configure env vars.
2. Expose the server to the internet (HTTPS) if you need Telegram Mini App access.
3. Run the server.
4. Point the CLI to the server and open the web app.

## Configuration
Required:
- `TELEGRAM_BOT_TOKEN` - token from @BotFather.
- `ALLOWED_CHAT_IDS` - comma-separated chat IDs allowed to use the bot.
- `CLI_API_TOKEN` - shared secret used by CLI and web login.

Optional:
- `WEBAPP_PORT` - HTTP port (default: 3006).
- `WEBAPP_URL` - public URL for Telegram Mini App button.
- `CORS_ORIGINS` - comma-separated origins, or `*`.
- `HAPI_BOT_DATA_DIR` - data directory (default: ~/.hapi-server).
- `DB_PATH` - SQLite database path.

## Running
Binary (single executable):
```bash
export TELEGRAM_BOT_TOKEN="..."
export ALLOWED_CHAT_IDS="12345678"
export CLI_API_TOKEN="shared-secret"
export WEBAPP_URL="https://your-domain.example"

hapi server
```

From source:
```bash
bun install
bun run dev:server
```

Or inside `server/`:
```bash
bun run start
```

## Build for deployment
From the repo root:
```bash
bun run build:server
bun run build:web
```

The server build output is `server/dist/index.js`, and the web assets are in `web/dist`.

## Networking notes
- Telegram Mini Apps require HTTPS and a public URL. If the server has no public IP, use Cloudflare Tunnel or Tailscale and set `WEBAPP_URL` to the HTTPS endpoint.
- If the web app is hosted on a different origin, set `CORS_ORIGINS` accordingly.

## Architecture overview
The server is the hub for direct-connect mode. It accepts CLI connections over Socket.IO, exposes HTTP endpoints for the web UI, and publishes live updates over SSE. A Telegram bot provides notifications and a Mini App entrypoint. Session and machine state are stored in a local SQLite database.

## Security model
Access is controlled by:
- Telegram chat ID allowlist.
- `CLI_API_TOKEN` shared secret for CLI and browser access.

Transport security depends on HTTPS in front of the server.
