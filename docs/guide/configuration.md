---
description: "Every environment variable and settings.json key HAPI reads, grouped by hub, CLI, runner and agent, with defaults taken from the code."
---

# Configuration Reference

Every environment variable and `settings.json` key that HAPI reads, grouped by
the process that reads it. For a quick start, the defaults are enough; see
[Installation](./installation.md) for the common setup and
[Authentication](./authentication.md) for tokens and passkeys.

## How configuration is resolved

HAPI keeps its state in one directory, `~/.hapi` by default (override with
`HAPI_HOME`). The hub and the CLI on the same machine share
`settings.json` in that directory.

```
~/.hapi/
├── settings.json        # Configuration (hub + CLI)
├── hapi.db              # SQLite database (hub)
├── jwt-secret.json      # Web/native JWT signing key (hub)
├── owner-id.json        # Hub owner id (hub)
├── runner.state.json    # Runner process state
└── logs/                # Log files
```

Priority is **environment variable > `settings.json` > default**.

- **Hub settings** with a `settings.json` key in the tables below are saved to
  `settings.json` the first time the hub sees them in the environment, if the
  key is not already present. Later environment changes still win at runtime,
  but the saved value stays in the file.
- **CLI settings** (`apiUrl`, `extraHeaders`) are never saved from the
  environment. `cliApiToken` is saved by `hapi auth login` or the first-run
  prompt.
- Changes take effect on the next start of the process that reads them.
  Restart the hub or runner (`hapi runner start` replaces a running runner)
  after editing.

Editors that support JSON Schema can validate the file:

```json
{
  "$schema": "https://hapi.run/docs/schemas/settings.schema.json",
  "listenHost": "0.0.0.0",
  "publicUrl": "https://hapi.example.com"
}
```

**What is listed here.** This page covers variables an operator can
reasonably set. It omits variables that HAPI sets for its own child processes
(runner handoff and launcher PIDs, `HAPI_INVOKED_CWD`, hook ports/tokens,
`HAPI_DISCLAIM_*`, `HAPI_CLI_EXECUTABLE`, `HAPI_BUN_EXEC`, tunnel-client
`TUNWG_*`), test-only variables, and the native variables of each agent
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG`, provider API keys, …),
which HAPI passes through to the agent unchanged.

## Hub

Read by `hapi hub` (alias `hapi server`).

### Network and identity

| Variable | `settings.json` | Default | Description |
|----------|-----------------|---------|-------------|
| `HAPI_HOME` | – | `~/.hapi` | Data directory. A leading `~` is expanded. |
| `DB_PATH` | – | `$HAPI_HOME/hapi.db` | SQLite database path. |
| `CLI_API_TOKEN` | `cliApiToken` | Generated on first run | Base access token. Must not contain `:`; the hub refuses to start otherwise. See [Authentication](./authentication.md#access-token). |
| `HAPI_LISTEN_HOST` | `listenHost` | `127.0.0.1` | HTTP bind address. Also set by `hapi hub --host`. |
| `HAPI_LISTEN_PORT` | `listenPort` | `3006` | HTTP port. Also set by `hapi hub --port`. |
| `HAPI_PUBLIC_URL` | `publicUrl` | `http://localhost:<port>` | Public URL of the hub. Must be the canonical HTTPS origin (no path) for [passkeys](./authentication.md#passkeys); also used by the Telegram Mini App and to derive default CORS origins. |
| `CORS_ORIGINS` | `corsOrigins` | Origin of `publicUrl` | Comma-separated allowed origins, or `*`. A separately hosted web app needs its exact origin here for passkey callbacks. |
| `HAPI_PASSKEY_NATIVE_ORIGINS` | – | – | Extra trusted Android app origins for native passkeys, comma-separated, each `android:apk-key-hash:<hash>`. Only needed for custom-signed Android builds; any other form stops the hub from starting. |

### Relay tunnel

Used only with `hapi hub --relay`. See [Deployment](./deployment.md#relay-tunnel-details).

| Variable | `settings.json` | Default | Description |
|----------|-----------------|---------|-------------|
| `HAPI_RELAY_API` | – | `relay.hapi.run` | Relay API domain. |
| `HAPI_RELAY_AUTH` | `relayAuthKey` | Issued by the relay | Relay key override. The issued key is stored as `relayAuthKey` automatically; set the variable only when an operator gave you a key. |
| `HAPI_RELAY_FORCE_TCP` | – | `false` | `true` or `1` forces TCP when UDP is blocked. |
| `HAPI_OFFICIAL_WEB_URL` | – | `https://app.hapi.run` | Web app origin added to CORS when the relay is enabled. |

### Notifications

See [Notifications](./notifications.md) for setup.

| Variable | `settings.json` | Default | Description |
|----------|-----------------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | `telegramBotToken` | – | Telegram bot token. Enables the bot, Mini App sign-in and Telegram notifications. |
| `TELEGRAM_NOTIFICATION` | `telegramNotification` | `true` | Enable Telegram notifications. In the environment, any value other than `true` disables. |
| `SERVERCHAN_SENDKEY` | `serverChanSendKey` | – | ServerChan (Server酱) SendKey. |
| `SERVERCHAN_NOTIFICATION` | `serverChanNotification` | `true` | Enable ServerChan notifications. In the environment, any value other than `true` disables. |
| `SERVERCHAN_BACKGROUND_ONLY` | `serverChanBackgroundOnly` | `false` | Only send when no visible HAPI client is connected in the namespace. |
| `WXPUSHER_APP_TOKEN` | `wxPusherAppToken` | – | WxPusher application token for App/client notifications. |
| `WXPUSHER_UIDS` | `wxPusherUids` | – | Comma-separated WxPusher recipient UIDs. |
| `WXPUSHER_TOPIC_IDS` | `wxPusherTopicIds` | – | Comma-separated WxPusher topic IDs. |
| `WXPUSHER_NOTIFICATION` | `wxPusherNotification` | `true` | Enable WxPusher notifications. |
| `WXPUSHER_BACKGROUND_ONLY` | `wxPusherBackgroundOnly` | `false` | Background-only delivery for the legacy `default` destination. |
| – | `wxPusherByNamespace` | – | Explicit WxPusher destinations by namespace. See [WxPusher setup](./notifications.md#wxpusher-app-setup). |
| `VAPID_SUBJECT` | – | `mailto:admin@hapi.run` | Web Push contact. VAPID keys are generated into `vapidKeys`. |
| `HAPI_ANDROID_PUSH` | `androidPushMode` | `auto` | `auto` (direct FCM when `fcmServiceAccountPath` is set, otherwise the push relay), `relay`, `fcm`, or `off`. Unknown values disable Android push. |
| `FCM_SERVICE_ACCOUNT_PATH` | `fcmServiceAccountPath` | – | Firebase service-account JSON for private builds of the Android app. |
| `HAPI_IOS_PUSH` | `iosPushMode` | `relay` | `relay`, `apns` (direct), or `off`. |
| `HAPI_PUSH_RELAY_URL` | `iosPushRelayUrl` | `https://push.hapi.run` | Native push relay for both Android and iOS. Unrelated to `--relay`. |
| `APNS_KEY_P8_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` | `apnsKeyP8Path`, `apnsKeyId`, `apnsTeamId`, `apnsBundleId` | – | Required for `HAPI_IOS_PUSH=apns`; iOS push is disabled if any is missing. |
| `APNS_ENV` | `apnsEnv` | `production` | `production` or `sandbox` for direct APNs. |
| `HAPI_NOTIFY_DEBUG` | – | – | `1` logs push delivery decisions. |

For the legacy `default` WxPusher destination, overriding `WXPUSHER_APP_TOKEN` with a different app requires `WXPUSHER_UIDS` or `WXPUSHER_TOPIC_IDS` in the environment. The Hub neither reuses the other app's saved recipients nor saves the temporary app's recipients under the saved token. Explicit `wxPusherByNamespace.default` still replaces the entire legacy destination.

### Voice and dictation

Provider keys can also be entered in the web app under **Settings → Voice**,
which stores them in `providerCredentials`. A variable set when the hub starts
wins and cannot be edited from Settings. See
[Voice Assistant](./voice-assistant.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `ELEVENLABS_API_KEY` | – | ElevenLabs voice assistant and dictation. |
| `ELEVENLABS_AGENT_ID` | Created automatically | Use an existing ElevenLabs agent. |
| `ELEVENLABS_VOICE_AGENT_MAP` | – | JSON object mapping voice ids to ElevenLabs agent ids. |
| `ELEVENLABS_MAX_DURATION_SECONDS` | `1800` | Maximum length of one conversation, 60–7200. Also editable in Settings (`elevenLabsMaxDurationSeconds`) when the variable is unset. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | – | Gemini Live voice assistant. |
| `GEMINI_API_BASE` | Google default | Gemini API base URL handed to the web client. |
| `GEMINI_LIVE_WS_URL` | Google default | Upstream Live WebSocket URL used by the hub's Gemini proxy. |
| `DASHSCOPE_API_KEY` / `QWEN_API_KEY` | – | Qwen Realtime voice assistant. |
| `QWEN_REALTIME_WS_URL` | DashScope default | Upstream Qwen Realtime WebSocket URL used by the hub's proxy. |
| `VOICE_BACKEND` | First configured backend | Preferred assistant: `elevenlabs`, `gemini-live`, or `qwen-realtime`. |
| `OPENAI_API_KEY` | – | OpenAI dictation. |
| `DEEPGRAM_API_KEY` | – | Deepgram dictation. |
| `GROQ_API_KEY` | – | Groq dictation. |
| `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL`, `TRANSCRIPTION_API_KEY` | – | OpenAI-compatible or local transcription endpoint, model, and optional bearer token. |

### Generated session titles

All three `HAPI_TITLE_PROVIDER_*` connection variables are required to enable
the **Generate** action in the session rename dialog. The key is never sent
to the browser. Each request sends recent visible conversation text (up to
200 messages, bounded in size) to the configured provider.

With a provider configured, the hub also makes one best-effort automatic
request after the first completed turn when the session has no name or
summary yet. Failures are ignored and the attempt is remembered across
restarts; **Generate** stays available to retry. A manual or agent-set title
that arrives meanwhile takes precedence. Without a provider, titles behave as
before.

| Variable | Default | Description |
|----------|---------|-------------|
| `HAPI_TITLE_PROVIDER_BASE_URL` | – | OpenAI-compatible Chat Completions base URL. |
| `HAPI_TITLE_PROVIDER_API_KEY` | – | API key for that provider. |
| `HAPI_TITLE_PROVIDER_MODEL` | – | Model id, preferably a small one. |
| `HAPI_TITLE_PROVIDER_MAX_TOKENS` | `64` | Completion-token budget per title; raise for reasoning models. |
| `HAPI_TITLE_PROVIDER_TIMEOUT_MS` | `10000` | Request timeout. |
| `HAPI_TITLE_SUGGESTION_RATE_LIMIT` | `5` | Suggestions per session per window. |
| `HAPI_TITLE_SUGGESTION_RATE_WINDOW_MS` | `600000` | Rate-limit window. |

### Sessions, uploads and terminals

| Variable | Default | Description |
|----------|---------|-------------|
| `HAPI_SESSION_IDLE_TIMEOUT_MS` | `43200000` (12 h) | A session that sends only keep-alives for this long, with no visible work or pending request, is shown as idle. `0` disables. |
| `HAPI_MAX_UPLOAD_BYTES` | `536870912` (512 MiB) | Maximum size of one uploaded file; capped at 10 GiB. The machine that receives the file checks the same variable, so set it on the hub and the CLI/runner. |
| `HAPI_SCRATCHLIST_MAX_ATTACHMENT_BYTES_PER_FILE` | `10485760` (10 MiB) | Scratchlist attachment limit per file. |
| `HAPI_SCRATCHLIST_MAX_ATTACHMENTS_PER_ENTRY` | `4` | Attachments per scratchlist entry. |
| `HAPI_SCRATCHLIST_MAX_ATTACHMENT_BYTES_PER_ENTRY` | `20971520` (20 MiB) | Total attachment size per entry. |
| `HAPI_SCRATCHLIST_MAX_ATTACHMENT_BYTES_PER_SESSION` | `104857600` (100 MiB) | Total attachment size per session. |
| `HAPI_SCRATCHLIST_ALLOWED_ATTACHMENT_MIMES` | JPEG, PNG, GIF, WebP, SVG, PDF, plain text | Comma-separated MIME allowlist. |
| `HAPI_TERMINAL_IDLE_TIMEOUT_MS` | `900000` (15 min) | Close idle web terminals. Read by both the hub and the CLI/runner that hosts the terminal. |
| `HAPI_TERMINAL_MAX_TERMINALS` | `4` | Maximum concurrent web terminals. Read by both the hub and the CLI/runner. |
| `HAPI_CURSOR_LEGACY_AUTO_MIGRATE` | On | `0`, `false`, `no` or `off` stops the hub from migrating legacy Cursor sessions to ACP when they are resumed. |
| `HAPI_HOSTNAME` | OS host name | Host name the hub treats as its own when deciding whether a legacy Cursor session is local. |

### Codex Desktop integration

Only needed for the Codex Desktop session import and restart actions.

| Variable | Default | Description |
|----------|---------|-------------|
| `HAPI_CODEX_COMMAND` | `codex` on `PATH` | Codex launcher used to detect an installation. |
| `HAPI_CODEX_APP_PATH` | `/Applications/Codex.app`, `~/Applications/Codex.app` | Codex Desktop app path on macOS. |
| `HAPI_CODEX_SCRIPT_ROOT` | Hub working directory | Directory containing helper scripts. |
| `HAPI_CODEX_RESTART_SCRIPT` | `Restart-CodexDesktop.ps1` in the script root | PowerShell restart script. |
| `HAPI_CODEX_WORKSPACE` | Script directory | Workspace for script logs and direct import. |
| `HAPI_CODEX_SCRIPT_TIMEOUT_MS` | `60000` | Script timeout. |
| `HAPI_PWSH_PATH` | `pwsh`, then `powershell.exe` | PowerShell executable. |

### Hub-managed settings

These keys have no environment variable. Change them from the web app's
Settings page; the hub writes them to `settings.json`.

| Key | Default | Description |
|-----|---------|-------------|
| `peerSpawnDefaults` | `{ "agent": "claude", "permissionMode": "yolo", "models": { "claude": "sonnet" } }` | Defaults for `spawn_peer` and `hapi spawn-peer`. Each field is optional. |
| `sessionSummaryContract` | `false` | Ask supported agents to end turns with an `AGENT_NOTIFY_SUMMARY` line used by notifications. |
| `sessionSummaryInChat` | `false` | Show that summary line as a compact row in chat instead of hiding it. |
| `autoBridgeTransientModelErrors` | `false` | After a transient model error, Cursor sessions automatically queue one retry. |
| `providerCredentials` | – | Voice and dictation keys saved from Settings. |
| `elevenLabsMaxDurationSeconds` | `1800` | See `ELEVENLABS_MAX_DURATION_SECONDS`. |
| `vapidKeys` | Generated | Web Push keys. Do not edit. |

## CLI

Read by `hapi`, `hapi <agent>`, and the other client commands on every
machine that connects to a hub.

| Variable | `settings.json` | Default | Description |
|----------|-----------------|---------|-------------|
| `HAPI_API_URL` | `apiUrl` | `http://localhost:3006` | Hub URL. Settings also accepts the legacy key `serverUrl`. |
| `CLI_API_TOKEN` | `cliApiToken` | Prompted on first interactive run | Access token, optionally with `:<namespace>`. Saved by `hapi auth login`. Non-interactive runs fail if it is missing. |
| `HAPI_EXTRA_HEADERS_JSON` | `extraHeaders` | – | JSON object of extra headers for CLI → hub HTTP and WebSocket requests, for example an access-proxy cookie. |
| `HAPI_HOME` | – | `~/.hapi` | Data directory. Use one per namespace when a machine serves several. |
| `HAPI_API_FALLBACK_URLS` | – | – | Comma-separated alternative URLs for the **same** hub (for example LAN and tunnel addresses). The machine connection rotates to the next URL after repeated connect failures and retries the primary after 30 minutes. |
| `HAPI_API_FAILOVER_AFTER` | – | `5` | Consecutive connect failures before rotating to the next URL. |
| `HAPI_HOSTNAME` | – | OS host name | Host name reported for the machine and its sessions. |
| `HAPI_HTTP_MCP_URL` | – | – | Target for `hapi mcp` when `--url` is not given. |
| `HAPI_WAIT_ACTIVE_SECS` | – | `60` | Default `--wait` for `hapi spawn-peer`. |
| `HAPI_SESSION_SUMMARY_CONTRACT` | – | Hub setting | Overrides `sessionSummaryContract` for sessions started by this process. `0`, `false`, `off` or `no` disables; any other non-empty value enables. |
| `HAPI_DISABLE_PEER_TOOLS` | – | – | `1`, `true` or `yes` removes the peer tools (`list_peers`, `inspect_peer`, `ping_peer`, `spawn_peer`) from wrapped agents and makes the peer CLI commands fail. Usually set on the runner. See [Installation](./installation.md#disabling-peer-tools-on-a-runner). |
| `HAPI_TERMINAL_SHELL` | PowerShell 7, Windows PowerShell, then `cmd.exe` | Windows only: shell for web terminals. On macOS and Linux, web terminals use `$SHELL`, falling back to `/bin/zsh` (macOS) or `/bin/bash`. |
| `HAPI_EXPERIMENTAL` | – | – | Reserved flag (`true`, `1`, `yes`); no current feature depends on it. |
| `DEBUG` | – | – | Any value enables verbose logs and stack traces. |

`HAPI_MAX_UPLOAD_BYTES`, `HAPI_TERMINAL_IDLE_TIMEOUT_MS` and
`HAPI_TERMINAL_MAX_TERMINALS` are also read here; see the
[hub table](#sessions-uploads-and-terminals).

Other `settings.json` keys written by the CLI:

| Key | Description |
|-----|-------------|
| `machineId`, `machineIdConfirmedByServer` | Machine identity, created on first connection. Cleared by `hapi auth logout`. Do not edit. |
| `runnerAutoStartWhenRunningHappy` | Legacy key; no longer read. |

## Runner

Read by `hapi runner start` / `start-sync`. The runner also reads every
[CLI variable](#cli). Its spawned sessions inherit its environment, so set
agent variables on the runner too. `hapi runner start` replaces a running
runner so new values take effect.

| Variable | Default | Description |
|----------|---------|-------------|
| `HAPI_RUNNER_SUPERVISED` | – | Exactly `1` tells the hub that a supervisor (systemd, launchd, pm2) restarts the runner after it exits, enabling the web **Restart** control. Set only when that is true. |
| `HAPI_DISABLE_VERSION_HANDOFF` | – | Exactly `1` disables automatic runner replacement when the installed CLI binary changes. Use when a supervisor manages upgrades. |
| `HAPI_RUNNER_HEARTBEAT_INTERVAL` | `60000` | Heartbeat interval in ms (version checks, dead-session pruning). |
| `HAPI_RUNNER_HTTP_TIMEOUT` | `10000` | Timeout in ms for local runner control requests. |
| `HAPI_RUNNER_WEBHOOK_TIMEOUT_MS` | `15000` (Codex: `30000`) | How long a spawn waits for the new session to report in. Raise for slow agent startup. |

## Agent-specific

Set these on the machine that runs the agent: your shell for terminal
sessions, the runner for remote spawns.

| Variable | Agent | Default | Description |
|----------|-------|---------|-------------|
| `HAPI_CLAUDE_PATH` | Claude Code | `claude` on `PATH` | Path to the `claude` executable. |
| `CLAUDE_REMOTE_RESPAWN_BACKOFF_MS` | Claude Code | `1000` | Delay before respawning a failed remote-mode Claude process. |
| `HAPI_CODEX_APP_SERVER_BIN` | Codex | `codex` | Command used to start `codex app-server` for remote sessions. |
| `HAPI_CODEX_MODEL_CATALOG_JSON` | Codex | – | Absolute path (or `~/…`) to a static Codex model catalog, passed as `-c model_catalog_json=…`. |
| `HAPI_CODEX_LAZY_HISTORY_IDS` | Codex | – | Comma-separated native thread ids that load only their newest turn. For exceptionally large threads; set on the runner. |
| `COPILOT_CLI_PATH` | GitHub Copilot | `copilot` | Path to the Copilot CLI. |
| `CURSOR_LEGACY_TRANSIENT_BACKOFF_MS` | Cursor (legacy) | `2000` | Delay before retrying after a transient Cursor Agent error. |
| `HAPI_DSH_ACP_COMMAND` | DeepSeek Harness | `dsh` (with `--profile acp`) | ACP server executable. |
| `HAPI_DSH_ACP_ARGS_JSON` | DeepSeek Harness | – | JSON array of ACP server arguments. |
| `HAPI_DSH_ACP_CONFIG` | DeepSeek Harness | – | Absolute config path for the ACP server. |

See [Supported Agents](./agents.md) for installing and authenticating each
agent.

## Set by HAPI inside sessions

HAPI exports these into agent processes. Read them from scripts; do not set
them yourself.

| Variable | Description |
|----------|-------------|
| `HAPI_SESSION_ID` | The current HAPI session id, for example for [`hapi job`](./session-jobs.md). |
| `HAPI_API_URL` | Exported only when a non-default hub URL is configured. `CLI_API_TOKEN` from `settings.json` is not copied into agent environments. |
| `HAPI_WORKTREE_BASE_PATH`, `HAPI_WORKTREE_BRANCH`, `HAPI_WORKTREE_NAME`, `HAPI_WORKTREE_PATH`, `HAPI_WORKTREE_CREATED_AT` | Set for sessions created as a worktree. |
