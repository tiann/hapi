# HAPI

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

```bash
npm install -g @twsxtd/hapi
```

Or with Homebrew:

```bash
brew install tiann/tap/hapi
```

Other options: [Installation guide](docs/guide/installation.md)

## Quickstart

1. Start the server:

```bash
hapi server
```

2. Start a coding session:

```bash
hapi
```

3. Open the UI at `http://localhost:3006` and log in with the token in `~/.hapi/settings.json`.

## Docker (server only)

```bash
docker run -d --name hapi -p 3006:3006 -v hapi-data:/data ghcr.io/tiann/hapi-server:latest
```

More setup options: [Installation guide](docs/guide/installation.md)

## Docs

- [Quick Start](docs/guide/quick-start.md)
- [Installation](docs/guide/installation.md)
- [PWA](docs/guide/pwa.md)
- [How it Works](docs/guide/how-it-works.md)
- [Why HAPI](docs/guide/why-hapi.md)
- [FAQ](docs/guide/faq.md)

## Requirements

- Claude CLI installed and logged in (`claude` on PATH) for Claude Code sessions.
- Bun if building from source.

## Build from source

```bash
bun install
bun run build:single-exe
```
