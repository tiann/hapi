# hapi

Code on the go controlling Claude Code from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g hapi
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
- `HAPPY_HOME_DIR` - Custom home directory for hapi data (default: ~/.happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

## Requirements

- Node.js >= 20.0.0
  - Required by `eventsource-parser@3.0.5`, which is required by
  `@modelcontextprotocol/sdk`, which we used to implement permission forwarding
  to mobile app
- Claude CLI installed & logged in (`claude` command available in PATH)

## License

MIT
