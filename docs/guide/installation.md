# Installation

Install the HAPI CLI and set up the hub.

## Prerequisites

- At least one supported agent CLI installed (Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, and more — see [Supported Agents](./agents.md))

Verify your CLI is installed:

```bash
# For Claude Code
claude --version

# For OpenAI Codex CLI
codex --version

# For Cursor Agent CLI
agent --version

# For Grok Build CLI
grok --version

# For OpenCode CLI
opencode --version
```

## Architecture

HAPI has three components:

| Component | Role | Required |
|-----------|------|----------|
| **CLI** | Wraps AI coding agents, runs sessions | Yes |
| **Hub** | Central coordinator: persistence, real-time sync, remote access | Yes |
| **Runner** | Background service for remote session spawning | Optional |

### How they work together

```
┌─────────────────────────────────────────────────────┐
│              Your Machine                           │
│                                                     │
│  ┌─────────┐    Socket.IO    ┌─────────────┐       │
│  │  CLI    │◄───────────────►│    Hub      │       │
│  │+ Agent  │                 │  + SQLite   │       │
│  └─────────┘                 └──────┬──────┘       │
│       ▲                             │ SSE          │
│       │ spawn                       ▼              │
│  ┌────┴────┐                 ┌─────────────┐       │
│  │ Runner  │◄────RPC────────►│   Web App   │       │
│  │(背景)   │                 └─────────────┘       │
│  └─────────┘                                       │
└─────────────────────────────────────────────────────┘
                    │
           [Tunnel / Public URL]
                    │
              ┌─────▼─────┐
              │ Phone/Web │
              └───────────┘
```

- **CLI**: Start a session with `hapi`. The CLI wraps your AI agent and syncs with the hub.
- **Hub**: Run `hapi hub`. Stores sessions, handles permissions, enables remote access.
- **Runner**: Run `hapi runner start`. Lets you spawn sessions from phone/web without keeping a terminal open.

### Typical workflows

**Local only**: `hapi hub` → `hapi` → work in terminal

**Remote access**: `hapi hub --relay` → `hapi runner start` → control from phone/web

## Install the CLI

```bash
npm install -g @twsxtd/hapi --registry=https://registry.npmjs.org
```

> Recommendation: use the official npm registry for global install. Some mirrors may not sync platform packages in time.

Or with Homebrew:

```bash
brew install tiann/tap/hapi
```

## Other install options

<details>
<summary>npx (no install)</summary>

```bash
npx @twsxtd/hapi
```
</details>

<details>
<summary>Prebuilt binary</summary>

Download the latest release from [GitHub Releases](https://github.com/tiann/hapi/releases).

```bash
xattr -d com.apple.quarantine ./hapi
chmod +x ./hapi
sudo mv ./hapi /usr/local/bin/
```
</details>

<details>
<summary>Build from source</summary>

```bash
git clone https://github.com/tiann/hapi.git
cd hapi
bun install
bun build:single-exe

./cli/dist-exe/<target>/hapi
```

`<target>` is the Bun build target (e.g., `bun-linux-x64`, `bun-darwin-arm64`); it defaults to the host platform and architecture.
</details>

## Hub setup

The hub can be deployed on:

- **Local desktop** (default) - Run on your development machine
- **Remote host** - Deploy the hub on a VPS, cloud host, or any machine with network access

### Default: Public Relay (recommended)

```bash
hapi hub --relay
```

The terminal displays a URL and QR code. Scan to access from anywhere.

`hapi server` remains supported as an alias.

- **End-to-end encrypted** with WireGuard + TLS
- No configuration needed
- Works behind NAT, firewalls, and any network

For relay key management, TCP fallback, and self-hosted tunnel alternatives, see [Deployment](./deployment.md#relay-tunnel-details).

### Local Only

```bash
hapi hub
# or
hapi hub --no-relay
```

The hub listens on `http://localhost:3006` by default.

On first run, HAPI:

1. Creates `~/.hapi/`
2. Generates a secure access token
3. Prints the token and saves it to `~/.hapi/settings.json`

<details>
<summary>Config files</summary>

```
~/.hapi/
├── settings.json      # Main configuration
├── hapi.db           # SQLite database (hub)
├── runner.state.json  # Runner process state
└── logs/             # Log files
```
</details>

<details>
<summary>Environment variables</summary>

| Variable | Default | settings.json | Description |
|----------|---------|---------------|-------------|
| `CLI_API_TOKEN` | Auto-generated | `cliApiToken` | Shared secret for authentication |
| `HAPI_API_URL` | `http://localhost:3006` | `apiUrl` | Hub URL for CLI connections |
| `HAPI_EXTRA_HEADERS_JSON` | - | `extraHeaders` | JSON object of extra outbound headers for CLI → hub HTTP/WebSocket requests |
| `HAPI_LISTEN_HOST` | `127.0.0.1` | `listenHost` | Hub HTTP bind address |
| `HAPI_LISTEN_PORT` | `3006` | `listenPort` | Hub HTTP port |
| `HAPI_PUBLIC_URL` | - | `publicUrl` | Public URL for external access |
| `CORS_ORIGINS` | - | `corsOrigins` | Allowed CORS origins (comma-separated) |
| `TELEGRAM_BOT_TOKEN` | - | `telegramBotToken` | Telegram Bot API token |
| `TELEGRAM_NOTIFICATION` | `true` | `telegramNotification` | Enable Telegram notifications |
| `SERVERCHAN_SENDKEY` | - | `serverChanSendKey` | Server酱 (ServerChan) SendKey for push notifications |
| `SERVERCHAN_NOTIFICATION` | `true` | `serverChanNotification` | Enable ServerChan notifications |
| `HAPI_RELAY_API` | `relay.hapi.run` | - | Relay API domain for the public relay |
| `HAPI_RELAY_AUTH` | Per-hub key issued by the relay | `relayAuthKey` | Relay auth key override (set only when an operator provides a key) |
| `HAPI_RELAY_FORCE_TCP` | `false` | - | Force TCP mode for relay |
| `HAPI_OFFICIAL_WEB_URL` | `https://app.hapi.run` | - | Official web app origin, added to CORS when the relay is enabled |
| `VAPID_SUBJECT` | `mailto:admin@hapi.run` | - | Web Push contact info |
| `HAPI_HOME` | `~/.hapi` | - | Config directory path |
| `DB_PATH` | `~/.hapi/hapi.db` | - | Database file path |
| `HAPI_EXPERIMENTAL` | - | - | CLI: enable experimental features (`true`/`1`/`yes`) |
| `ELEVENLABS_API_KEY` | - | Settings / env | ElevenLabs API key for voice + dictation |
| `ELEVENLABS_AGENT_ID` | Auto-created | - | Custom ElevenLabs agent ID |
| `OPENAI_API_KEY` | - | Settings / env | OpenAI API key for dictation (`gpt-transcribe` / `gpt-live-transcribe`) |
| `DEEPGRAM_API_KEY` | - | Settings / env | Deepgram API key for dictation (`nova-3`) |
| `GROQ_API_KEY` | - | Settings / env | Groq API key for dictation (`whisper-large-v3`) |
| `TRANSCRIPTION_BASE_URL` | - | Settings / env | OpenAI-compatible/local transcription base URL |
| `TRANSCRIPTION_MODEL` | - | Settings / env | Model for the OpenAI-compatible transcription endpoint |
| `TRANSCRIPTION_API_KEY` | - | Settings / env | Optional bearer token for that endpoint |
</details>

<details>
<summary>settings.json example</summary>

Configuration priority: **ENV > settings.json > default**

When ENV values are set and not present in settings.json, they are automatically saved.
`HAPI_EXTRA_HEADERS_JSON` is not automatically saved, so access credentials are not persisted unexpectedly.

```json
{
  "$schema": "https://hapi.run/docs/schemas/settings.schema.json",
  "listenHost": "0.0.0.0",
  "listenPort": 3006,
  "publicUrl": "https://your-domain.com",
  "extraHeaders": {
    "Cookie": "CF_Authorization=..."
  }
}
```

JSON Schema: [settings.schema.json](https://hapi.run/docs/schemas/settings.schema.json)
</details>

## CLI setup

If the hub is not on localhost, set these before running `hapi`:

```bash
export HAPI_API_URL="http://your-hub:3006"
export CLI_API_TOKEN="your-token-here"
export HAPI_EXTRA_HEADERS_JSON='{"Cookie":"CF_Authorization=..."}'
```

Or use interactive login:

```bash
hapi auth login
```

Authentication commands:

```bash
hapi auth status
hapi auth login
hapi auth logout
```

Each machine gets a unique ID stored in `~/.hapi/settings.json`. This allows:

- Multiple machines to connect to one hub
- Remote session spawning on specific machines
- Machine health monitoring

### Diagnostics

Run `hapi doctor` for a full diagnostics report: configuration, runner status, logs, and relevant environment info.

```bash
hapi doctor          # Diagnostics report
hapi doctor clean    # Kill runaway hapi processes
```

## Runner setup

Run a background service for remote session spawning:

```bash
hapi runner start
hapi runner status
hapi runner logs
hapi runner stop
```

With the runner running:

- Your machine appears in the "Machines" list
- You can spawn sessions remotely from the web app
- Sessions persist even when the terminal is closed

#### Split hub + remote runner (peer discovery)

When the hub runs on one host and the runner on another, agents inside runner-spawned sessions should discover peers via MCP **`list_peers`** (same hub credentials as the session CLI). Prefer that over shelling `hapi ping-peer --list`.

```
[Hub host]  hapi hub          ← sessions DB + /api/sessions
     ▲
     │ HAPI_API_URL + CLI_API_TOKEN
     │
[Runner host]  hapi runner start  → spawns session CLIs
                     │
                     ▼
              agent session  → MCP list_peers / inspect_peer / ping_peer
```

On the runner host, configure the **same** hub URL and token the hub uses:

```bash
export HAPI_API_URL="http://your-hub:3006"   # or Tailscale / public URL
export CLI_API_TOKEN="your-token-here"
# or: hapi auth login   # saves the token; still set HAPI_API_URL for a remote hub
hapi runner start
```

Session CLI may export an **explicit** non-default `HAPI_API_URL` (from env or settings) into child env so shell helpers hit the same remote hub. It does **not** mirror `CLI_API_TOKEN` into wrapped agents (settings/prompt-backed secrets stay out of agent env; a fresh `hapi` re-reads `~/.hapi/settings.json`, and systemd/env tokens already inherit). Prefer MCP `list_peers` inside a session. Web terminal PTYs still strip hub secrets. If `--list` fails with an auth/URL error, the message points at `hapi auth login` and the configured hub URL.

Additional runner commands:

```bash
hapi runner list                      # List active sessions
hapi runner stop-session <sessionId>  # Stop a single session managed by the runner
```

Use `--workspace-root <path>` to restrict which directories the runner can browse and spawn sessions in. Repeat the flag to allow multiple directories; supports `~` expansion:

```bash
hapi runner start --workspace-root ~/projects --workspace-root ~/work
```

For running the hub and runner as persistent background services (pm2, launchd, systemd), see [Deployment](./deployment.md).

## Security notes

- Keep tokens secret and rotate if needed
- Use HTTPS for public access
- Restrict CORS origins in production

<details>
<summary>Firewall example (ufw)</summary>

```bash
ufw allow from 192.168.1.0/24 to any port 3006
```
</details>
