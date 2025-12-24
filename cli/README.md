# hapi CLI

Run Claude Code or Codex sessions from your terminal and control them remotely through the hapi server.

## What it does
- Starts Claude Code sessions and registers them with hapi-server.
- Starts Codex mode for OpenAI-based sessions.
- Provides an MCP stdio bridge for external tools.
- Manages a background daemon for long-running sessions.
- Includes diagnostics and auth helpers.

## Typical flow
1. Start the server and set env vars (see ../server/README.md).
2. Set the same CLI_API_TOKEN on this machine or run `hapi auth login`.
3. Run `hapi` to start a session.
4. Use the web app or Telegram Mini App to monitor and control.

## Quickstart
```bash
# Point to the server if it is not on localhost:3006
export HAPI_BOT_URL="https://your-server-domain"

hapi              # prompts for CLI_API_TOKEN and saves it locally
```

## Commands
- `hapi` - start a Claude Code session (passes through Claude CLI flags)
- `hapi codex` - start Codex mode
- `hapi mcp` - start MCP stdio bridge
- `hapi auth` - login/status/logout for CLI_API_TOKEN
- `hapi server` - start the bundled server (single binary workflow)
- `hapi daemon` - manage background service
- `hapi doctor` - diagnostics and cleanup

## Configuration
Required:
- `CLI_API_TOKEN` - shared secret; must match the server
- `HAPI_BOT_URL` - server base URL (default: http://localhost:3006)

`CLI_API_TOKEN` can be set via env or stored in `~/.hapi/settings.json` (env wins).

Optional:
- `HAPI_HOME` - config/data directory (default: ~/.hapi)
- `HAPI_EXPERIMENTAL` - enable experimental features (true/1/yes)
- `HAPI_HTTP_MCP_URL` - default MCP target for `hapi mcp`
- `HAPI_CLAUDE_PATH` - path to a specific `claude` executable

## Requirements
- Claude CLI installed and logged in (`claude` on PATH).
- Bun for building from source.

## Build from source
From the repo root:
```bash
bun install
bun run build:cli
bun run build:cli:exe
```

For an all-in-one binary that also embeds the web app:
```bash
bun run build:single-exe
```

## Related docs
- `../server/README.md`
- `../web/README.md`
