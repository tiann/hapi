# hapi-server

Telegram bot + HTTP API + realtime updates for hapi.

## What it does

- Telegram bot for notifications and the Mini App entrypoint.
- HTTP API for sessions, messages, permissions, machines, and files.
- Server-Sent Events stream for live updates in the web app.
- Socket.IO channel for CLI connections.
- Serves the web app from `web/dist` or embedded assets in the single binary.
- Persists state in SQLite.

## Configuration

See `src/configuration.ts` for all options.

### Required

- `CLI_API_TOKEN` - Base shared secret used by CLI and web login. Clients append `:<namespace>` for isolation.

### Optional (Telegram)

- `TELEGRAM_BOT_TOKEN` - Token from @BotFather.
- `WEBAPP_URL` - Public HTTPS URL for Telegram Mini App access. Also used to derive default CORS origins for the web app.

### Optional

- `WEBAPP_PORT` - HTTP port (default: 3006).
- `CORS_ORIGINS` - Comma-separated origins, or `*`.
- `HAPI_HOME` - Data directory (default: ~/.hapi).
- `DB_PATH` - SQLite database path (default: HAPI_HOME/hapi.db).

## Running

Binary (single executable):

```bash
export TELEGRAM_BOT_TOKEN="..."
export CLI_API_TOKEN="shared-secret"
export WEBAPP_URL="https://your-domain.example"

hapi server
```

If you only need web + CLI, you can omit TELEGRAM_BOT_TOKEN.
To enable Telegram, set TELEGRAM_BOT_TOKEN and WEBAPP_URL, start the server, open `/app`
in the bot chat, and bind the Mini App with `CLI_API_TOKEN:<namespace>` when prompted.

From source:

```bash
bun install
bun run dev:server
```

## HTTP API

See `src/web/routes/` for all endpoints.

### Authentication (`src/web/routes/auth.ts`)

- `POST /api/auth` - Get JWT token (Telegram initData or `CLI_API_TOKEN[:namespace]`).
- `POST /api/bind` - Bind a Telegram account using initData + `CLI_API_TOKEN:<namespace>`.

### Sessions (`src/web/routes/sessions.ts`)

- `GET /api/sessions` - List all sessions.
- `GET /api/sessions/:id` - Get session details.
- `POST /api/sessions/:id/abort` - Abort session.
- `POST /api/sessions/:id/switch` - Switch session mode (remote/local).
- `POST /api/sessions/:id/permission-mode` - Set permission mode.
- `POST /api/sessions/:id/model` - Set model preference.

### Messages (`src/web/routes/messages.ts`)

- `GET /api/sessions/:id/messages` - Get messages (paginated).
- `POST /api/sessions/:id/messages` - Send message.

### Permissions (`src/web/routes/permissions.ts`)

- `POST /api/sessions/:id/permissions/:requestId/approve` - Approve permission.
- `POST /api/sessions/:id/permissions/:requestId/deny` - Deny permission.

### Machines (`src/web/routes/machines.ts`)

- `GET /api/machines` - List online machines.
- `POST /api/machines/:id/spawn` - Spawn new session on machine.

### Git/Files (`src/web/routes/git.ts`)

- `GET /api/sessions/:id/git-status` - Git status.
- `GET /api/sessions/:id/git-diff-numstat` - Diff summary.
- `GET /api/sessions/:id/git-diff-file` - File-specific diff.
- `GET /api/sessions/:id/file` - Read file content.
- `GET /api/sessions/:id/files` - File search with ripgrep.

### Events (`src/web/routes/events.ts`)

- `GET /api/events` - SSE stream for live updates.

### CLI (`src/web/routes/cli.ts`)

- `POST /cli/sessions` - Create/load session.
- `GET /cli/sessions/:id` - Get session by ID.
- `POST /cli/machines` - Create/load machine.
- `GET /cli/machines/:id` - Get machine by ID.

## Socket.IO

See `src/socket/handlers/cli.ts` for event handlers.

Namespace: `/cli`

### Client events (CLI to server)

- `message` - Send message to session.
- `update-metadata` - Update session metadata.
- `update-state` - Update agent state.
- `session-alive` - Keep session active.
- `session-end` - Mark session ended.
- `machine-alive` - Keep machine online.
- `rpc-register` - Register RPC handler.
- `rpc-unregister` - Unregister RPC handler.

### Server events (server to clients)

- `update` - Broadcast session/message updates.
- `rpc-request` - Incoming RPC call.

See `src/socket/rpcRegistry.ts` for RPC routing.

## Telegram Bot

See `src/telegram/bot.ts` for bot implementation.

### Commands

- `/start` - Welcome message with Mini App link.
- `/app` - Open Mini App.

### Features

- Permission request notifications with approve/deny buttons.
- Session ready notifications.
- Deep links to Mini App sessions.

See `src/telegram/callbacks.ts` for button handlers.

## Core Logic

See `src/sync/syncEngine.ts` for the main session/message manager:

- In-memory session cache with versioning.
- Message pagination and retrieval.
- Permission approval/denial.
- RPC method routing via Socket.IO.
- Event publishing to SSE and Telegram.
- Git operations and file search.
- Activity tracking and timeouts.

## Storage

See `src/store/index.ts` for SQLite persistence:

- Sessions with metadata and agent state.
- Messages with pagination support.
- Machines with daemon state.
- Todo extraction from messages.
- Users table for Telegram bindings (includes namespace).

## Source structure

- `src/web/` - HTTP server and routes.
- `src/socket/` - Socket.IO setup and handlers.
- `src/telegram/` - Telegram bot.
- `src/sync/` - Core session/message logic.
- `src/store/` - SQLite persistence.
- `src/sse/` - Server-Sent Events.

## Security model

Access is controlled by:
- Telegram initData verification plus bound Telegram users (bound via `CLI_API_TOKEN:<namespace>`).
- `CLI_API_TOKEN` base secret for CLI and browser access (namespace is appended by clients).

Transport security depends on HTTPS in front of the server.

## Build for deployment

From the repo root:

```bash
bun run build:server
bun run build:web
```

The server build output is `server/dist/index.js`, and the web assets are in `web/dist`.

## Networking notes

- Telegram Mini Apps require HTTPS and a public URL. If the server has no public IP, use Cloudflare Tunnel or Tailscale and set `WEBAPP_URL` to the HTTPS endpoint.
- If the web app is hosted on a different origin, set `CORS_ORIGINS` (or `WEBAPP_URL`) to include that static host origin.

## Standalone web hosting

The web UI can be hosted separately from the server (for example on GitHub Pages or Cloudflare Pages):

1. Build and deploy `web/dist` from the repo root.
2. Set `CORS_ORIGINS` (or `WEBAPP_URL`) to the static host origin.
3. Open the static site, click the Server button on the login screen, and enter the hapi server origin.

Leaving the server override empty preserves the default same-origin behavior when the server serves the web assets directly.
