# hapi

HAPI means "哈皮," a Chinese transliteration of [Happy](https://github.com/slopus/happy). Great credit to the original project.

Run Claude Code / Codex / Gemini sessions locally and control them remotely through a Web / PWA / Telegram Mini App.

> **Why HAPI?** HAPI is a local-first alternative to Happy. See [Why Not Happy?](docs/WHY_NOT_HAPPY.md) for the key differences.

## Features

- Start AI coding sessions from any machine.
- Monitor and control sessions from your phone or browser.
- Approve or deny tool permissions remotely.
- Browse files and view git diffs.
- Track session progress with todo lists.
- Supports multiple AI backends: Claude Code, Codex, and Gemini.

## Installation

### Homebrew (macOS/Linux)

```bash
brew install tiann/tap/hapi
```

### npm/npx

```bash
npx @twsxtd/hapi
```

Or install globally:

```bash
npm install -g @twsxtd/hapi
```

### Prebuilt binary

Download from [Releases](https://github.com/tiann/hapi/releases).

**macOS users**: Remove the quarantine attribute before running:

```bash
xattr -d com.apple.quarantine ./hapi
```

## Quickstart

1. Start the server on a machine you control:

```bash
hapi server
# or: npx @twsxtd/hapi server
```

2. If the server has no public IP, expose it over HTTPS:
   - Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
   - Tailscale: https://tailscale.com/kb/

3. Run the CLI on the machine where you want sessions:

```bash
# If the server is not on localhost:3006
export HAPI_SERVER_URL="https://your-domain.example"

hapi
# or: npx @twsxtd/hapi
```

4. Open the UI in a browser at the server URL and log in with `CLI_API_TOKEN`.

### Finding Your Access Token

On first run, an Access Token is automatically generated and saved to `~/.hapi/settings.json`.

View your token:

```bash
cat ~/.hapi/settings.json | grep cliApiToken
```

Or set your own via environment variable (takes priority over generated token):

```bash
export CLI_API_TOKEN="your-secret-token"
```

## Telegram Mini App (optional)

To use Telegram for notifications and the Mini App:

1. Create a bot with @BotFather and get the token.

2. Expose your server over HTTPS (Cloudflare Tunnel, Tailscale, etc.).

3. Add environment variables:

```
WEBAPP_URL="https://your-domain.example"
TELEGRAM_BOT_TOKEN="..."
```

4. Start the server and send `/start` to the bot to get your chat ID.

5. Add your chat ID and restart:

```
ALLOWED_CHAT_IDS="12345678"
```

6. Run `/app` in the bot chat to open the Mini App.

## Multi-agent support

- `hapi` - Start a Claude Code session.
- `hapi codex` - Start an OpenAI Codex session.
- `hapi gemini` - Start a Google Gemini session.

## CLI config file

You can store the token in `~/.hapi/settings.json` instead of an env var.
Environment variables take priority over the file.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH) for Claude Code sessions.
- Bun if building from source.

## Build from source

```bash
bun install
bun run build
```

Build a single binary with embedded web assets:

```bash
bun run build:single-exe
```

## Docs

- `docs/WHY_NOT_HAPPY.md` - Why HAPI exists: architectural differences from Happy
- `cli/README.md` - CLI usage and config
- `server/README.md` - Server setup and architecture
- `web/README.md` - Web app behavior and dev workflow

## License

- cli: MIT
- others: LGPLv2
