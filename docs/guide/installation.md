# Installation

Install the HAPI CLI and set up the server.

## Prerequisites

- Claude Code, OpenAI Codex CLI, or Google Gemini CLI installed

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

## Server setup

The server can be deployed on:

- **Local desktop** (default) - Run on your development machine
- **Remote server** - Deploy on a VPS, cloud server, or any machine with network access

### Default: Public Relay (recommended)

```bash
hapi server --relay
```

The terminal displays a URL and QR code. Scan to access from anywhere.

- **End-to-end encrypted** with WireGuard + TLS
- No configuration needed
- Works behind NAT, firewalls, and any network

### Local Only

```bash
hapi server
# or
hapi server --no-relay
```

The server listens on `http://localhost:3006` by default.

On first run, HAPI:

1. Creates `~/.hapi/`
2. Generates a secure access token
3. Prints the token and saves it to `~/.hapi/settings.json`

<details>
<summary>Config files</summary>

```
~/.hapi/
├── settings.json      # Main configuration
├── hapi.db           # SQLite database (server)
├── daemon.state.json  # Daemon process state
└── logs/             # Log files
```
</details>

<details>
<summary>Environment variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CLI_API_TOKEN` | Auto-generated | Shared secret for authentication |
| `HAPI_SERVER_URL` | `http://localhost:3006` | Server URL for CLI |
| `WEBAPP_PORT` | `3006` | HTTP server port |
| `HAPI_HOME` | `~/.hapi` | Config directory path |
| `DB_PATH` | `~/.hapi/hapi.db` | Database file path |
| `CORS_ORIGINS` | - | Allowed CORS origins |
</details>

## CLI setup

If the server is not on localhost, set these before running `hapi`:

```bash
export HAPI_SERVER_URL="http://your-server:3006"
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

- Multiple machines to connect to one server
- Remote session spawning on specific machines
- Machine health monitoring

## Operations

### Self-hosted tunnels

If you prefer not to use the public relay (e.g., for lower latency or self-managed infrastructure), you can use these alternatives:

<details>
<summary>Cloudflare Tunnel</summary>

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

```bash
export WEBAPP_URL="https://your-tunnel.trycloudflare.com"
hapi server
```
</details>

<details>
<summary>Tailscale</summary>

https://tailscale.com/download

```bash
sudo tailscale up
hapi server
```

Access via your Tailscale IP:

```
http://100.x.x.x:3006
```
</details>

<details>
<summary>Public IP / Reverse Proxy</summary>

If the server has a public IP, access directly via `http://your-server-ip:3006`.

Use HTTPS (via Nginx, Caddy, etc.) for production.
</details>

### Telegram setup

Enable Telegram notifications and Mini App access:

1. Message [@BotFather](https://t.me/BotFather) and create a bot
2. Set the bot token and public URL
3. Start the server and bind your account

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export WEBAPP_URL="https://your-public-url"

hapi server
```

Then message your bot with `/start`, open the app, and enter your `CLI_API_TOKEN`.

### Daemon setup

Run a background service for remote session spawning:

```bash
hapi daemon start
hapi daemon status
hapi daemon logs
hapi daemon stop
```

With the daemon running:

- Your machine appears in the "Machines" list
- You can spawn sessions remotely from the web app
- Sessions persist even when the terminal is closed

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
