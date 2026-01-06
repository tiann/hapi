# HAPI

HAPI means "哈皮" a Chinese transliteration of [Happy](https://github.com/slopus/happy). Great credit to the original project.

Run Claude Code / Codex / Gemini sessions locally and control them remotely through a Web / PWA / Telegram Mini App.

> **Why HAPI?** HAPI is a local-first alternative to Happy. See [Why Not Happy?](docs/guide/why-hapi.md) for the key differences.

## Features

- **Seamless Handoff** - Work locally with native Claude Code or Codex, switch to remote when needed, switch back anytime.
- **AFK Without Stopping** - Step away from your desk? Keep approving AI requests from your phone. HAPI pushes permission requests to Telegram or your browser—approve or deny with one tap.
- **See What AI Sees** - Browse project files and Git diffs directly in the web app. No SSH needed—just open the session and check what changed.
- **Stay in the Loop** - Real-time todo progress shows you exactly where AI is in a multi-step task. No more guessing if it's stuck or making progress.
- **Your AI, Your Choice** - Switch between Claude Code, Codex, and Gemini from the same interface. Different models for different tasks, one unified workflow.
- **Terminal Anywhere** - Need to run a quick command? Access a real terminal session from your phone or browser, directly connected to the working machine.

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
