# hapi-hub

Telegram bot + HTTP API + realtime updates for hapi hub.

## What it does

- Telegram bot for notifications and the Mini App entrypoint.
- HTTP API for sessions, messages, permissions, machines, and files.
- Server-Sent Events stream for live updates in web and native clients.
- Socket.IO channel for CLI connections.
- Serves the web app from `web/dist` or embedded assets in the single binary; network-relay mode uses the separately hosted official web app.
- Persists state in SQLite via `bun:sqlite`.

## Configuration

See `src/configuration.ts` for all options.

### Required

- `CLI_API_TOKEN` - Base shared secret used by CLI, web login and native pairing. Clients append `:<namespace>` for isolation. Auto-generated on first run if not set.

### Optional (Telegram)

- `TELEGRAM_BOT_TOKEN` - Token from @BotFather.
- `HAPI_PUBLIC_URL` - Canonical public HTTPS origin for shared Passkeys and Telegram Mini App access. Also used to derive default CORS origins for the web app.

### Optional (Voice)

Dictation and voice-assistant provider keys can also be added from **Settings → Voice** (stored in `settings.json` under `providerCredentials`; env vars still win when set at process start).

- `ELEVENLABS_API_KEY` - ElevenLabs API key for voice assistant + dictation.
- `ELEVENLABS_AGENT_ID` - Custom ElevenLabs agent ID (auto-created if not set).
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` - Gemini Live voice assistant.
- `DASHSCOPE_API_KEY` / `QWEN_API_KEY` - Qwen Realtime voice assistant.
- `VOICE_BACKEND` - Default assistant backend (`elevenlabs`, `gemini-live`, or `qwen-realtime`).
- `OPENAI_API_KEY` - OpenAI dictation (`gpt-transcribe` / `gpt-live-transcribe`).
- `DEEPGRAM_API_KEY` - Deepgram dictation (`nova-3`, standard and realtime).
- `GROQ_API_KEY` - Groq dictation (`whisper-large-v3`).
- `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL` - OpenAI-compatible/local transcription endpoint and model.
- `TRANSCRIPTION_API_KEY` - Optional bearer token for the OpenAI-compatible endpoint.

### Optional (automatic session titles)

When the configured OpenAI-compatible title provider is available, the Hub
performs one best-effort automatic title suggestion after the first completed
turn when the session has no manual name or existing summary. Automatic
failures are silent and never block the agent conversation. The manual
**Generate** action remains available.

Configure `HAPI_TITLE_PROVIDER_BASE_URL`, `HAPI_TITLE_PROVIDER_API_KEY`, and
`HAPI_TITLE_PROVIDER_MODEL` on the Hub. The attempt is persisted across restarts;
manual or Agent titles arriving during generation are preserved. No automatic
request is made without a configured provider.

### Optional

- `HAPI_LISTEN_HOST` - HTTP bind address (default: 127.0.0.1).
- `HAPI_LISTEN_PORT` - HTTP port (default: 3006).
- `CORS_ORIGINS` - Comma-separated origins, or `*`.
- `HAPI_HOME` - Data directory (default: ~/.hapi).
- `DB_PATH` - SQLite database path (default: HAPI_HOME/hapi.db).
- `TELEGRAM_NOTIFICATION` - Enable/disable Telegram notifications (default: true).
- `HAPI_RELAY_API` - Relay API domain (default: relay.hapi.run).
- `HAPI_RELAY_AUTH` - Explicit relay auth key. By default the hub obtains and persists an individually revocable key from the relay. A persisted key rejected with HTTP 403 is discarded and reissued once; an explicitly configured environment key must be updated manually.
- `HAPI_RELAY_FORCE_TCP` - Force TCP relay mode (true/1).
- `VAPID_SUBJECT` - Contact email/URL for Web Push.
- `HAPI_ANDROID_PUSH` - `auto` (default: direct FCM when credentials are configured, otherwise relay), `relay`, `fcm`, or `off`.
- `FCM_SERVICE_ACCOUNT_PATH` - Service-account JSON for private Firebase builds; the app must use the same project. Invalid configured credentials disable Android push instead of switching projects.
- `HAPI_IOS_PUSH` - `relay` (default), `apns`, or `off`.
- `HAPI_PUSH_RELAY_URL` - Shared Android/iOS push relay (default: `https://push.hapi.run`; persisted as `iosPushRelayUrl`). Independent of the `--relay` network tunnel.
- `HAPI_SESSION_IDLE_TIMEOUT_MS` - Keep-alive-idle window in ms (default: 43200000 / 12 h; `0` disables). See "Session liveness" below.
- `HAPI_SESSION_HIBERNATE_MS` - Idle window before stopping eligible runner sessions (default 7200000 ms, or 2 h). Set to `0` to disable. Values from 1 to 59999 are raised to 60000 ms.

Official native apps register their encryption keys automatically; no push
provider setup is needed on a fresh hub. See the [native companion push
contract](../docs/api/native-companion-contract.md).

## Running

Binary (single executable):

```bash
export TELEGRAM_BOT_TOKEN="..."
export CLI_API_TOKEN="shared-secret"
export HAPI_PUBLIC_URL="https://your-domain.example"

hapi hub
```

`hapi server` remains supported as an alias.

For web/native clients + CLI, you can omit TELEGRAM_BOT_TOKEN.
To enable Telegram, set TELEGRAM_BOT_TOKEN and HAPI_PUBLIC_URL, start the hub, open `/app`
in the bot chat, and bind the Mini App with `CLI_API_TOKEN:<namespace>` when prompted.

From source:

```bash
bun install
bun run dev:hub
```

## HTTP API

The following is an overview. See the [client contract](../docs/api/client-contract/index.md)
for request/response shapes and error semantics, and `src/web/routes/` for all endpoints.

### Authentication (`src/web/routes/auth.ts`, `src/web/routes/bind.ts`)

- `POST /api/auth` - Get JWT token (Telegram initData, `CLI_API_TOKEN[:namespace]`, or a `passkeySession`).
- `POST /api/passkey/login/verify` - Unauthenticated native WebAuthn sign-in with an app-issued, short-lived, one-time challenge; returns a JWT plus a 30-day `passkeySession`.
- `POST /api/passkey/register/options`, `POST /api/passkey/register/verify`, `GET /api/passkeys`, `DELETE /api/passkeys/:id` - Manage passkeys for the caller's namespace (JWT required). Web and App passkeys share RP ID `auth.hapi.run` and are scoped to this Hub/namespace and the current `CLI_API_TOKEN`; rotating the token revokes them. Browser ceremonies use `/api/passkey/browser/{login,register}/start`, `/complete`, and `/exchange`. Set `HAPI_PUBLIC_URL` to the canonical HTTPS Hub origin. See the [client contract](../docs/api/client-contract/auth.md#passkeys-web).
- `POST /api/bind` - Bind a Telegram account using initData + `CLI_API_TOKEN:<namespace>`.

### Sessions (`src/web/routes/sessions.ts`)

- `GET /api/sessions` - List all sessions. The default order is global-pinned, project-pinned, then `lastUserMessageAt ?? createdAt` descending (creation time and ID break ties); `?order=updatedAt` requests pure recency. Each summary includes `hasConversationContent`, derived from stored conversation messages (not titles or lifecycle events); full session SSE updates carry changes to this flag. See the [client contract](../docs/api/client-contract/rest.md) for the wire-level ordering rules.
- `GET /api/sessions/:id` - Get session details.
- `POST /api/sessions/:id/abort` - Abort session.
- `POST /api/sessions/:id/switch` - Hand off session control to the web.
- `POST /api/sessions/:id/resume` - Resume inactive session.
- `POST /api/sessions/:id/reopen` - Reopen a session; follow the returned session ID.
- `POST /api/sessions/:id/clear` - Start a fresh conversation when supported.
- `POST /api/sessions/:id/upload` - Upload file (base64, max 50MB).
- `POST /api/sessions/:id/uploads` - Initialize chunked streaming upload (configurable max via `HAPI_MAX_UPLOAD_BYTES`, default 512 MiB, clamped to 10 GiB).
- `POST /api/sessions/:id/uploads/:uploadId/chunk?index=<n>` - Stream binary chunk (`application/octet-stream`, 1 B – 8 MB).
- `POST /api/sessions/:id/uploads/:uploadId/finalize` - Finalize chunked upload and authorize file identity.
- `POST /api/sessions/:id/uploads/:uploadId/abort` - Abort chunked upload and delete partial file.
- `POST /api/sessions/:id/upload/delete` - Delete uploaded file.
- `POST /api/sessions/:id/archive` - Archive active session.
  Runner-owned sessions wait for verified cleanup, including retries after an
  early inactive/archived update. Concurrent requests join the same operation.
  Cleanup confirmation has a 90-second budget; failure returns a structured
  `archive-cleanup-unconfirmed` (409), `archive-cleanup-unavailable` (503), or
  `archive-cleanup-timeout` (503) error. A timeout does not cancel Runner cleanup
  or prove the process is still alive; retry to verify the final result.
- `PATCH /api/sessions/:id` - Rename session.
- `DELETE /api/sessions/:id` - Delete inactive session.
- `GET /api/sessions/:id/slash-commands` - List slash commands.
- `GET /api/sessions/:id/skills` - List skills.
- `POST /api/sessions/:id/permission-mode` - Set permission mode.
- `POST /api/sessions/:id/model` - Set model preference.
- `POST /api/sessions/:id/effort` - Set effort for Claude, Grok, or Pi; other config controls are flavor/capability-gated (see the client contract).
- `GET/POST /api/sessions/:id/scratchlist` - Read/create Hub-persisted scratchlist entries; update/delete and attachment routes share this prefix.

### Messages (`src/web/routes/messages.ts`)

- `GET /api/sessions/:id/messages` - Get messages (paginated).
- `POST /api/sessions/:id/messages` - Send message.
- `POST /api/sessions/:id/messages/queued-state` - Reconcile queued, indeterminate, and invoked local IDs.
- `DELETE /api/sessions/:id/messages/:messageId` - Cancel a queued message.
- `POST /api/sessions/:id/messages/:messageId/steer` - Steer a queued message when the session supports it.
- `POST /api/sessions/:id/messages/:messageId/retry` - Explicitly retry indeterminate delivery when safe; never auto-replay.

### Permissions (`src/web/routes/permissions.ts`)

- `POST /api/sessions/:id/permissions/:requestId/approve` - Approve permission.
- `POST /api/sessions/:id/permissions/:requestId/deny` - Deny permission.

### Machines (`src/web/routes/machines.ts`)

- `GET /api/machines` - List online machines.
- `PATCH /api/machines/:id` - Set/clear the machine display name.
- `GET /api/machines/:id/agent-availability` - List installed/configured Agents.
- `POST /api/machines/:id/spawn` - Spawn new session on machine.
- `POST /api/machines/:id/list-directory` - Browse runner-scoped directories.
- `POST /api/machines/:id/paths/exists` - Check if path exists.
- `POST /api/machines/:id/restart-runner` - Request runner restart (requires an available restart path).

### Usage (`src/web/routes/usage.ts`)

- `GET /api/usage/summary` - Get cache-aware token usage for the owner namespace (`range=7d|30d|all`).

### Activity (`src/web/routes/activity.ts`)

- `GET /api/activity` - When agents in the caller's namespace were working (`since`/`until` epoch ms, default last 24 h, max 31 days): each session's turns from the `session_turns` table, plus the permission prompts and questions it waited on. Used by `hapi usage`.

### Storage (`src/web/routes/storage.ts`)

- `GET /api/storage/sqlite` - SQLite database/WAL/SHM sizes for the owner namespace.

### Git/Files (`src/web/routes/git.ts`)

- `GET /api/sessions/:id/git-status` - Git status.
- `GET /api/sessions/:id/git-diff-numstat` - Diff summary.
- `GET /api/sessions/:id/git-diff-file` - File-specific diff.
- `GET /api/sessions/:id/file` - Read file content.
- `GET /api/sessions/:id/files` - File search with ripgrep.

For inactive sessions, including archived sessions, these read-only file and Git operations fall back to
the matching online Runner when it advertises `workspace-file-access`. The
Runner reads the current workspace under its configured roots; HAPI does not
copy or snapshot files during archive.

### Events (`src/web/routes/events.ts`)

- `GET /api/events` - SSE stream for live updates.
- `POST /api/visibility` - Report client visibility state.

### Voice (`src/web/routes/voice.ts`)

- `POST /api/voice/token` - Get ElevenLabs conversation token.
- `GET /api/voice/backend` - Discover configured assistant backends.
- `GET /api/voice/voices` - List voices for the selected backend.
- `GET/PUT /api/voice/transcription/credentials` - Read masked provider settings or update credentials (owner-only).
- `GET /api/voice/transcription/providers` - List configured providers and supported modes.
- `POST /api/voice/transcription` - Transcribe a bounded recording.
- `POST /api/voice/transcription/realtime-token` - Mint a short-lived OpenAI, ElevenLabs, or Deepgram credential.

### Push Notifications (`src/web/routes/push.ts`)

- `GET /api/push/vapid-public-key` - Get VAPID public key.
- `POST /api/push/subscribe` - Subscribe to push notifications.
- `DELETE /api/push/subscribe` - Unsubscribe.

Native Android/iOS registration uses `POST`/`DELETE /api/devices/register`
(`src/web/routes/devices.ts`); see the [native push contract](../docs/api/native-companion-contract.md).

### CLI (`src/web/routes/cli.ts`)

- `POST /cli/sessions` - Create/load session.
- `GET /cli/sessions/:id` - Get session by ID.
- `POST /cli/machines` - Create/load machine.
- `GET /cli/machines/:id` - Get machine by ID.

## Socket.IO

See `src/socket/handlers/cli/index.ts` and `src/socket/handlers/terminal.ts` for event handlers.

Namespaces: `/cli` (raw CLI access token) and `/terminal` (client JWT).
Ordinary web/native session updates use SSE, not the CLI Socket.IO namespace.

### Client events (CLI to hub)

- `message` - Send message to session.
- `update-metadata` - Update session metadata.
- `update-state` - Update agent state.
- `session-alive` - Keep session active.
- `session-ready` - Cursor ACP `session/load` (or `newSession`) succeeded; hub defers merge/dedup until this arrives on reopen.
- `session-end` - Mark session ended.
- `machine-alive` - Keep machine online.
- `rpc-register` - Register RPC handler.
- `rpc-unregister` - Unregister RPC handler.

### Terminal events (web to hub, `/terminal`)

- `terminal:create` - Open terminal for session.
- `terminal:write` - Send input.
- `terminal:resize` - Resize dimensions.
- `terminal:close` - Close terminal.
- `agent-terminal:subscribe` / `agent-terminal:unsubscribe` - Attach/detach the wrapped agent's terminal stream.
- `agent-terminal:input` / `agent-terminal:resize` - Interact with that terminal when supported.

### Hub events (hub to CLI clients, `/cli`)

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

### Session liveness

Two separate signals, deliberately (tiann/hapi#1820):

- **`active` / `activeAt`** - transport. The CLI socket is connected; `session-alive` refreshes it every ~2 s. `sessionCache.expireInactive` drops `active` after 30 s of silence.
- **`metadata.lifecycleState`** - agent health. `running` -> `idle` -> `running`, plus `hibernated` and `archived`.

Keep-alives prove a socket, not an agent. A session can therefore heartbeat for days with no messages, no thinking and no background tasks - `active: true` forever, which `expireInactive` can never catch. `sessionCache.reconcileKeepaliveIdle` (same 5 s tick) closes that gap: after `HAPI_SESSION_IDLE_TIMEOUT_MS` with no agent progress it moves `lifecycleState` `running` -> `idle`.

- `active` is left alone on purpose. The CLI really is reachable, and flipping it would let `resumeSession` spawn a second agent against a live process, and unlock dedup-merge / delete on it.
- Progress means a message in either direction, a queued prompt, or a background task - never a keep-alive. Sessions that are thinking, running background tasks or holding a pending permission request are never marked.
- `idle` reverts to `running` on the next progress, within one tick.
- After `HAPI_SESSION_HIBERNATE_MS` without progress or live work, the hub stops eligible runner sessions. A confirmed stop marks the session `hibernated` and inactive. Hibernation uses the same stop path as archive. Children that detach from the wrapper’s process tree, such as an MCP server that daemonises, may keep running. The next send resumes the same ID.
- `metadata.idleReconcileExempt: true` opts a session out entirely.

### Hibernation transitions

The hub tracks transport liveness separately from the durable hibernation marker. “Waking” below means the original row still carries its settled marker while a resume is in progress or awaiting confirmation.

| Starting state | Event | Outcome |
|---|---|---|
| Running or idle | The idle window and hub startup grace have elapsed | Start a stop only for an eligible runner-owned worker with no live work, a heartbeat from that wrapper reporting no peer reply watch or chunked upload, and connected runner stop and inspection handlers. A single-request upload reserves the worker until its RPC returns. A chunked upload also keeps the worker awake between chunks until finalize, abort, or expiry. Workers missing either report stay running. |
| Eligible | Before sending `KillSession` | Reserve the row, persist `stopping` with machine, PID and wrapper start marker, and block terminal creation and competing deliveries. |
| Stopping | The archive stop path returns `stopped` or `already_gone` and the same wrapper still owns the row | Mark the row inactive and hibernated. Preserve its ID, order, and unconsumed prompts. |
| Stopping | Runner explicitly returns `still_alive` or `unknown` after the archive fallbacks | Keep the stopping marker while shutdown may still be completing. The next idle sweep checks the recorded generation after ten minutes. A wake request can check sooner. |
| Stopping | A reply is lost, the runner disconnects, or the hub restarts during the stop | Retain the recorded identity. On a sweep or a wake request, ask the original runner to inspect the recorded PID and start marker. This read-only query checks the process generation without terminating it. |
| Interrupted stop | Probe completes | An absent PID or a different start marker confirms the original wrapper exited. Recovery is read-only. The original runner must also have observed exit for the session and find no remaining tracked wrapper or matching orphan. A verified replacement retires the stop reservation without signalling it. An inconclusive inspection keeps the attempt retryable. A matching generation with a fresh worker report after ten minutes can return to running. A replaced owner or an explicit archive retires the old attempt without ending the replacement. Older markers without an identity are cleared on startup. |
| Hibernated | Immediate send, explicit resume/reopen, implicit peer wake, or due scheduled prompt | Request the original HAPI ID; concurrent sends join the authorized wake. A future scheduled prompt alone leaves the session asleep. |
| Waking | Same-ID spawn confirms activity and any required native readiness | Clear the marker and backoff, record progress and allow delivery. A local terminal bootstrap and matching late Codex readiness can also confirm a wake. |
| Waking | Error, timeout, or hub restart with an active but unconfirmed transport | Keep the durable marker. For Claude, OpenCode, and Pi, a heartbeat, due prompt or immediate wake request can recover the lost acknowledgement. The runner must confirm the recorded wake attempt, original HAPI ID and replacement process generation, and the hub verifies the machine and native conversation before releasing delivery. Pi and OpenCode must also report that the replacement generation loaded the requested native conversation. OpenCode refuses to fall back to a blank conversation during a wake. The worker heartbeat repeats that evidence after reconnect. Until confirmation, immediate sends receive a retryable conflict and scheduled delivery and CLI reconnect backfill stay held. Matching late Codex readiness can finish its wake. If the worker exits or expires, restore hibernation; an operator can explicitly archive and reopen an unresponsive worker. |
| Waking | Spawn returns a different ID | Reject the wake, leave the returned row untouched, and retry a due prompt after ten minutes. The reply contains no proof of child ownership; an unexpected child may remain running, and the runner can return the cached mismatch on every retry until that child exits. |
| Hibernated or unconfirmed wake | Hub restarts with the row inactive | Keep the sleeping row or restore it from the surviving marker, including a CLI self-archive during startup. Preserve explicit hub archives and superseded rows. Due messages are reconsidered on the inactivity tick. An interrupted Pi attempt on an inactive row requires runner confirmation before another same-ID spawn. |
| Hibernated | Explicit archive | An outstanding wake requires fresh stop confirmation from its runner for the logical session. A settled sleeper with no outstanding wake can archive using its original confirmation. Remove the marker on successful archive. A later reopen follows the ordinary archive flow. |
| Any | Retry of an already-invoked attachment message | Acknowledge the authorized session's exact local ID without waking, validating deleted uploads, or dispatching a duplicate. New or unconsumed attachment messages still require the applicable worker checks. If an upload expired, the web composer shows the reupload error, restores the draft, and stages available local files again. If another draft prevents restoration, the failed bubble retains the recovery action. |

## Storage

See `src/store/index.ts` for SQLite persistence:

- Sessions with metadata and agent state.
- Messages with pagination support.
- Machines with runner state.
- Todo extraction from messages.
- Users table for Telegram bindings (includes namespace).
- Scratchlist entries/attachments, usage, work graph, and push registrations.

Message content is stored via `src/store/contentCodec.ts`: oversized strings
inside agent messages (giant tool output) are head+tail truncated at ingest,
and payloads ≥256 chars are zstd-compressed (TEXT = plaintext JSON, BLOB =
zstd). User prompts are never truncated — queued rows are delivered to the CLI
verbatim.

Maintenance scripts (run with the hub stopped before swapping files):

- `scripts/compact-db.ts` — retroactively truncate + compress + VACUUM an
  existing DB into a new file (the source is only opened read-only).
- `scripts/cleanup-sessions.ts` — bulk-delete sessions by message count, path
  glob, or first-message pattern.

## Source structure

- `src/web/` - HTTP service and routes.
- `src/socket/` - Socket.IO setup and handlers.
- `src/socket/handlers/cli/` - Modular CLI handlers.
- `src/telegram/` - Telegram bot.
- `src/sync/` - Core session/message logic.
- `src/store/` - SQLite persistence.
- `src/sse/` - Server-Sent Events.
- `src/config/` - Configuration loading and generation.
- `src/notifications/` - Push and Telegram notifications.
- `src/visibility/` - Client visibility tracking.

## Security model

Access is controlled by:
- Telegram initData verification plus bound Telegram users (bound via `CLI_API_TOKEN:<namespace>`).
- `CLI_API_TOKEN` base secret for CLI and browser access (namespace is appended by clients).

Transport security depends on HTTPS in front of the hub.

## Build for deployment

From the repo root:

```bash
bun run build:hub
bun run build:web
```

The hub build output is `hub/dist/index.js`, and the web assets are in `web/dist`.

## Networking notes

- Telegram Mini Apps require HTTPS and a public URL. If the hub has no public IP, use Cloudflare Tunnel or Tailscale and set `HAPI_PUBLIC_URL` to the HTTPS endpoint.
- If the web app is hosted on a different origin, set `CORS_ORIGINS` (or `HAPI_PUBLIC_URL`) to include that static host origin.

## Standalone web hosting

The web UI can be hosted separately from the hub (for example on GitHub Pages or Cloudflare Pages):

1. Build and deploy `web/dist` from the repo root.
2. Set `CORS_ORIGINS` (or `HAPI_PUBLIC_URL`) to the static host origin.
3. Open the static site, click the Hub button on the login screen, and enter the hapi hub origin.

Leaving the hub override empty preserves the default same-origin behavior when the hub serves the web assets directly.
