# hapi

HAPI means "哈皮," a Chinese transliteration of [happy](https://github.com/slopus/happy), great credit to the original Happy project.

Run Claude Code / Codex / Gemini sessions locally and control them remotely through a Web / PWA / Telegram Mini App.

## Features

- Start AI coding sessions from any machine.
- Monitor and control sessions from your phone or browser.
- Approve or deny tool permissions remotely.
- Browse files and view git diffs.
- Track session progress with todo lists.
- Supports multiple AI backends: Claude Code, Codex, and Gemini.

## Quickstart

1. Start the server on a machine you control:

```bash
npx @twsxtd/hapi server
```

> Alternatively, download the prebuilt binary from [Releases](https://github.com/tiann/hapi/releases) and run `hapi server`.

2. If the server has no public IP, expose it over HTTPS:
   - Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
   - Tailscale: https://tailscale.com/kb/

3. Run the CLI on the machine where you want sessions:

```bash
# If the server is not on localhost:3006
export HAPI_SERVER_URL="https://your-domain.example"

npx @twsxtd/hapi
```

4. Open the UI in a browser at the server URL and log in with `CLI_API_TOKEN`.

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

- `npx @twsxtd/hapi` - Start a Claude Code session.
- `npx @twsxtd/hapi codex` - Start an OpenAI Codex session.
- `npx @twsxtd/hapi gemini` - Start a Google Gemini session.

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

- `cli/README.md` - CLI usage and config
- `server/README.md` - Server setup and architecture
- `web/README.md` - Web app behavior and dev workflow

## License

- cli: MIT
- others: LGPLv2
