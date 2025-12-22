# hapi

HAPI means "哈皮," a Chinese transliteration of [happy](https://github.com/slopus/happy), great credit to the original Happy project.

Run Claude Code / Codex / Coding Agent sessions locally and control them remotely through a Web / PWA / Telegram mini App.

## Quickstart (single executable)

1. Download the prebuilt `hapi` binary for your platform and put it on your PATH.

2. Start the server on a machine you control:

```bash
export CLI_API_TOKEN="shared-secret"
export WEBAPP_URL="https://your-domain.example"   # required for Telegram Mini App
export TELEGRAM_BOT_TOKEN="..."
export ALLOWED_CHAT_IDS="12345678"

hapi server
```

If you only want the web app + CLI, you can skip TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_IDS.
To enable Telegram later, set TELEGRAM_BOT_TOKEN and WEBAPP_URL, start the server, send `/start`
to the bot to get your chat ID, set ALLOWED_CHAT_IDS, and restart the server.

3. If the server has no public IP, expose it over HTTPS:
- Cloudflare Tunnel docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Tailscale docs: https://tailscale.com/kb/
- Telegram Mini Apps require HTTPS.

4. Run the CLI on the machine where you want sessions:

```bash
# If the server is not on localhost:3006
export HAPI_BOT_URL="https://your-domain.example"

hapi
```

The CLI will prompt for `CLI_API_TOKEN` and save it locally.

5. Open the UI:
- In Telegram, run `/app` in the bot chat.
- In a browser, open `WEBAPP_URL` and log in with `CLI_API_TOKEN`.

## CLI config file
You can store the token in `~/.hapi/settings.json` instead of an env var.
Environment variables take priority over the file.

Example:
```json
{
    "cliApiToken": "shared-secret"
}
```

## Requirements
- Claude CLI installed and logged in (`claude` on PATH).
- A Telegram bot token from @BotFather (for Mini App access).
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

Build CLI-only binaries:
```bash
bun run build:cli:exe
bun run build:cli:exe:all
```

## Docs
- `cli/README.md` - CLI usage and config
- `server/README.md` - server setup and architecture
- `web/README.md` - web app behavior and dev workflow
