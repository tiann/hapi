# hapi

Code on the go controlling Claude Code from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
# Download the prebuilt hapi binary for your platform
# (macOS/Linux/Windows x64/arm64) and place it on your PATH.
```

## Usage

```bash
hapi
```

This will:
1. Start a Claude Code session
2. Register the session with your `hapi-server` instance
3. Allow real-time session control from the Telegram Mini App

## Commands

- `hapi auth` – Manage authentication
- `hapi codex` – Start Codex mode
- `hapi mcp` – Start MCP stdio bridge
- `hapi connect` – Not available in direct-connect mode
- `hapi notify` – Not available in direct-connect mode
- `hapi daemon` – Manage background service
- `hapi doctor` – System diagnostics & troubleshooting

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

## Environment Variables

- `HAPPY_BOT_URL` - Bot URL (default: http://localhost:3006)
- `CLI_API_TOKEN` - Shared secret for bot authentication (required)
- `HAPI_HOME_DIR` - Custom home directory for hapi data (default: ~/.config/hapi)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

## Requirements

- Prebuilt hapi binary (no Bun or Node required at runtime)
- Claude CLI installed & logged in (`claude` command available in PATH)
- Bun (for building from source)

## Building the executable

```bash
# From repo root
bun run build:cli:exe
bun run build:cli:exe -- --target bun-darwin-x64

# Platform-only target uses the host arch
bun run build:cli:exe -- --target bun-linux

# Build all targets
bun run build:cli:exe:all
```

Note: Windows arm64 builds require arm64 tool archives in `cli/tools/archives`.

## License

MIT
