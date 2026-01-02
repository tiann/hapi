# HAPI

HAPI means "哈皮" a Chinese transliteration of [Happy](https://github.com/slopus/happy). Great credit to the original project.

Run Claude Code / Codex / Gemini sessions locally and control them remotely through a Web / PWA / Telegram Mini App.

> **Why HAPI?** HAPI is a local-first alternative to Happy. See [Why Not Happy?](docs/guide/why-hapi.md) for the key differences.

## Features

- **Seamless Handoff** - Work locally with native Claude Code or Codex, switch to remote when needed, switch back anytime.
- Start AI coding sessions from any machine.
- Monitor and control sessions from your phone or browser.
- Approve or deny tool permissions remotely.
- Browse files and view git diffs.
- Track session progress with todo lists.
- Supports multiple AI backends: Claude Code, Codex, and Gemini.

## Getting Started

```bash
npx @twsxtd/hapi server # start the server locally
npx @twsxtd/hapi # run claude code 
```

Open `http://<server-ip>:3006` and login with the token, if you need to access it remotely, see [Remote access](/guide/installation#remote-access)

More options: [Quick Start](docs/guide/quick-start.md) | [Installation](docs/guide/installation.md)

## Docs

- [PWA](docs/guide/pwa.md)
- [How it Works](docs/guide/how-it-works.md)
- [Why HAPI](docs/guide/why-hapi.md)
- [FAQ](docs/guide/faq.md)

## Build from source

```bash
bun install
bun run build:single-exe
```
