# Installation

Install the HAPI CLI and set up the hub.

## Prerequisites

- Claude Code, OpenAI Codex CLI, Google Gemini CLI, or OpenCode CLI installed

Verify your CLI is installed:

```bash
# For Claude Code
claude --version

# For OpenAI Codex CLI
codex --version

# For Google Gemini CLI
gemini --version

# For OpenCode CLI
opencode --version
```

## Architecture

HAPI has three components:

| Component | Role | Required |
|-----------|------|----------|
| **CLI** | Wraps AI agents (Claude/Codex/Gemini/OpenCode), runs sessions | Yes |
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
npm install -g @twsxtd/hapi
```

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

./cli/dist/hapi
```
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
| `HAPI_LISTEN_HOST` | `127.0.0.1` | `listenHost` | Hub HTTP bind address |
| `HAPI_LISTEN_PORT` | `3006` | `listenPort` | Hub HTTP port |
| `HAPI_PUBLIC_URL` | - | `publicUrl` | Public URL for external access |
| `CORS_ORIGINS` | - | `corsOrigins` | Allowed CORS origins (comma-separated) |
| `TELEGRAM_BOT_TOKEN` | - | `telegramBotToken` | Telegram Bot API token |
| `TELEGRAM_NOTIFICATION` | `true` | `telegramNotification` | Enable Telegram notifications |
| `HAPI_RELAY_FORCE_TCP` | `false` | - | Force TCP mode for relay |
| `VAPID_SUBJECT` | `mailto:admin@hapi.run` | - | Web Push contact info |
| `HAPI_HOME` | `~/.hapi` | - | Config directory path |
| `DB_PATH` | `~/.hapi/hapi.db` | - | Database file path |
| `ELEVENLABS_API_KEY` | - | - | ElevenLabs API key for voice |
| `ELEVENLABS_AGENT_ID` | Auto-created | - | Custom ElevenLabs agent ID |
</details>

<details>
<summary>settings.json example</summary>

Configuration priority: **ENV > settings.json > default**

When ENV values are set and not present in settings.json, they are automatically saved.

```json
{
  "$schema": "https://hapi.run/docs/schemas/settings.schema.json",
  "listenHost": "0.0.0.0",
  "listenPort": 3006,
  "publicUrl": "https://your-domain.com"
}
```

JSON Schema: [settings.schema.json](https://hapi.run/schemas/settings.schema.json)
</details>

## CLI setup

If the hub is not on localhost, set these before running `hapi`:

```bash
export HAPI_API_URL="http://your-hub:3006"
export CLI_API_TOKEN="your-token-here"
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

## Operations

### Self-hosted tunnels

If you prefer not to use the public relay (e.g., for lower latency or self-managed infrastructure), you can use these alternatives:

<details>
<summary>Cloudflare Tunnel</summary>

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

**Quick tunnel** (temporary URL, changes on restart):

```bash
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --protocol http2 --url http://localhost:3006
```

Copy the generated URL and set it:

```bash
export HAPI_PUBLIC_URL="https://your-tunnel.trycloudflare.com"
hapi hub
```

**Named tunnel** (persistent URL):

```bash
# Create and configure a named tunnel
cloudflared tunnel create hapi
cloudflared tunnel route dns hapi hapi.yourdomain.com

# Run the tunnel
cloudflared tunnel --protocol http2 run hapi
```

> **Note:** Use `--protocol http2` instead of QUIC (the default) to avoid potential timeout issues with long-lived connections.

</details>

<details>
<summary>Tailscale</summary>

https://tailscale.com/download

```bash
sudo tailscale up
hapi hub
```

Access via your Tailscale IP:

```
http://100.x.x.x:3006
```
</details>

<details>
<summary>Public IP / Reverse Proxy</summary>

If the hub has a public IP, access directly via `http://your-hub-ip:3006`.

Use HTTPS (via Nginx, Caddy, etc.) for production.
</details>

### Telegram setup

Enable Telegram notifications and Mini App access:

1. Message [@BotFather](https://t.me/BotFather) and create a bot
2. Set the bot token and public URL
3. Start the hub and bind your account

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export HAPI_PUBLIC_URL="https://your-public-url"

hapi hub
```

Then message your bot with `/start`, open the app, and enter your `CLI_API_TOKEN`.

**Troubleshooting:**

- If binding fails, verify `HAPI_PUBLIC_URL` is accessible from the internet
- Telegram Mini App requires HTTPS (not HTTP)

### Runner setup

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

<details>
<summary>Alternative: pm2</summary>

If you prefer pm2 for process management:

```bash
pm2 start "hapi runner start --foreground" --name hapi-runner
pm2 save
```
</details>

### Background service deployment

Keep HAPI running persistently so it survives terminal closes, system restarts, and continues running in the background.

<details>
<summary>Quick: nohup</summary>

Simple one-liner for quick background runs:

```bash
# Hub
nohup hapi hub --relay > ~/.hapi/logs/hub.log 2>&1 &

# Runner
nohup hapi runner start --foreground > ~/.hapi/logs/runner.log 2>&1 &
```

View logs:

```bash
tail -f ~/.hapi/logs/hub.log
tail -f ~/.hapi/logs/runner.log
```

Stop processes:

```bash
pkill -f "hapi hub"
pkill -f "hapi runner"
```
</details>

<details>
<summary>pm2 (recommended for Node.js users)</summary>

pm2 provides process management with auto-restart on crashes and system reboot.

```bash
# Install pm2
npm install -g pm2

# Start hub and runner
pm2 start "hapi hub --relay" --name hapi-hub
pm2 start "hapi runner start --foreground" --name hapi-runner

# View status and logs
pm2 status
pm2 logs hapi-hub
pm2 logs hapi-runner

# Auto-restart on system reboot
pm2 startup    # Follow the printed instructions
pm2 save       # Save current process list
```
</details>

<details>
<summary>macOS: launchd</summary>

Create plist files for automatic startup on macOS.

**Hub** (`~/Library/LaunchAgents/com.hapi.hub.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string>
        <string>hub</string>
        <string>--relay</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
</dict>
</plist>
```

**Runner** (`~/Library/LaunchAgents/com.hapi.runner.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string>
        <string>runner</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
</dict>
</plist>
```

Load/unload services:

```bash
# Load (start)
launchctl load ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl load ~/Library/LaunchAgents/com.hapi.runner.plist

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl unload ~/Library/LaunchAgents/com.hapi.runner.plist
```

> **macOS sleep note:** macOS may suspend background processes when the display sleeps. Use `caffeinate` to prevent this:
> ```bash
> caffeinate -dimsu hapi hub --relay
> ```
> Or run `caffeinate -dimsu` in a separate terminal while HAPI is running.
</details>

<details>
<summary>Linux: systemd</summary>

Create user-level systemd services for automatic startup.

**Hub** (`~/.config/systemd/user/hapi-hub.service`):

```ini
[Unit]
Description=HAPI Hub
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hapi hub --relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

**Runner** (`~/.config/systemd/user/hapi-runner.service`):

```ini
[Unit]
Description=HAPI Runner
After=network.target hapi-hub.service

[Service]
Type=simple
ExecStart=/usr/local/bin/hapi runner start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:

```bash
# Reload systemd
systemctl --user daemon-reload

# Enable (auto-start on login)
systemctl --user enable hapi-hub
systemctl --user enable hapi-runner

# Start now
systemctl --user start hapi-hub
systemctl --user start hapi-runner

# View status/logs
systemctl --user status hapi-hub
journalctl --user -u hapi-hub -f
```

> **Persist after logout:** To keep services running even when not logged in:
> ```bash
> loginctl enable-linger $USER
> ```
</details>

### Voice assistant setup

Enable voice control:

1. Get an API key from [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys)
2. Set the environment variable:

```bash
export ELEVENLABS_API_KEY="your-api-key"
hapi hub --relay
```

See [Voice Assistant](./voice-assistant.md) for usage details.

### Security notes

- Keep tokens secret and rotate if needed
- Use HTTPS for public access
- Restrict CORS origins in production

<details>
<summary>Firewall example (ufw)</summary>

```bash
ufw allow from 192.168.1.0/24 to any port 3006
```
</details>
