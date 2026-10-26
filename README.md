# HAPI

Run official Claude Code / Codex / Cursor Agent / Grok Build / OpenCode / Kimi / Copilot / Antigravity / Pi / DeepSeek Harness sessions and control them remotely through native iOS / Android apps, Web / PWA, or Telegram Mini App.

> **Why HAPI?** HAPI is a local-first alternative to Happy. See [Why Not Happy?](docs/guide/why-hapi.md) for the key differences.

## Features

- **Seamless Handoff** - Work locally, switch to remote when needed, switch back anytime. No context loss, no session restart.
- **Shared Codex Sessions** - Use Codex from your terminal and phone at the same time. Requires Codex 0.154.0+. [Usage and limits](docs/guide/codex-shared-sessions.md).
- **Native First** - HAPI wraps your AI agent instead of replacing it. Same terminal, same experience, same muscle memory.
- **AFK Without Stopping** - Step away from your desk? Approve AI requests from your phone with one tap.
- **Your AI, Your Choice** - Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, Kimi, Copilot, Antigravity, Pi, DeepSeek Harness—different agents, one unified workflow.
- **Terminal Anywhere** - Run commands from your phone's browser or desktop web app, directly connected to the working machine.
- **Voice Control** - Use dictation in native apps, or talk to your AI agent hands-free with the web voice assistant.
- **Workspace Browser** - Opt-in via one or more `hapi runner start --workspace-root <path>` flags: browse scoped file trees from the web and start sessions in allowed subdirectories.

## Demo

https://github.com/user-attachments/assets/38230353-94c6-4dbe-9c29-b2a2cc457546

## Getting Started

```bash
npx @twsxtd/hapi hub --relay     # start hub with E2E encrypted relay
npx @twsxtd/hapi                 # choose an agent and start a session
```

`hapi server` remains supported as an alias.

Use `hapi <agent> [options]` to start an agent directly, for example `hapi claude`
or `hapi codex`. Scripts must specify the agent explicitly. `hapi --help` shows
HAPI's commands and supported agents.

The hub displays a URL and two QR codes. Open the web URL in a browser, or pair a native app using the companion QR. See [Native apps](docs/guide/native-apps.md) for build and pairing instructions.

> The relay uses WireGuard + TLS for end-to-end encryption. Your data is encrypted from your device to your machine.

For self-hosted options (Cloudflare Tunnel, Tailscale), see [Installation](docs/guide/installation.md)

## Docs

- [Native apps (iOS / Android)](docs/guide/native-apps.md)
- [Web / PWA](docs/guide/pwa.md)
- [How it Works](docs/guide/how-it-works.md)
- [Supported Agents](docs/guide/agents.md)
- [Voice Assistant](docs/guide/voice-assistant.md)
- [Why HAPI](docs/guide/why-hapi.md)
- [FAQ](docs/guide/faq.md)

## Native apps (iOS / Android)

The repository includes SwiftUI/UIKit and Kotlin Compose clients with chat, approvals, session creation, files, dictation, and push notifications. See the [native app guide](docs/guide/native-apps.md) for capabilities, platform differences and pairing. Build instructions: [iOS](ios/README.md) and [Android](android/README.md). Developer protocol: [client contract](docs/api/client-contract/index.md).

## Build from source

Requires Bun 1.4.0.

```bash
bun install
bun run build:single-exe
```

## Credits

HAPI means "哈皮" a Chinese transliteration of [Happy](https://github.com/slopus/happy). Great credit to the original project.
