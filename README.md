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

The hub displays a URL and two QR codes. Then connect a client:

- **Web / PWA (free):** open the web URL in a browser, or scan the web QR code. [Install it as a PWA](docs/guide/pwa.md) for a home-screen app and push notifications.
- **Native apps (paid):** install HAPI from the [App Store](https://apps.apple.com/app/id6805699104) or [Google Play](https://play.google.com/store/apps/details?id=run.hapi.companion), then scan the companion QR. See [Native apps](docs/guide/native-apps.md) for pairing.

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

## Clients

- **Web / PWA (free)** - The full-featured web app, including the remote terminal and voice assistant. Works in any browser and installs as a PWA. See [Web / PWA](docs/guide/pwa.md).
- **Native iOS / Android apps (paid)** - SwiftUI/UIKit and Kotlin Compose clients with chat, approvals, session creation, files, dictation, and native push notifications. See the [native app guide](docs/guide/native-apps.md) for capabilities and pairing.

<a href="https://apps.apple.com/app/id6805699104"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download on the App Store" height="48"></a>
<a href="https://play.google.com/store/apps/details?id=run.hapi.companion"><img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Get it on Google Play" height="72"></a>

Developers can build the apps from source: [iOS](ios/README.md), [Android](android/README.md). Protocol: [client contract](docs/api/client-contract/index.md).

## Build from source

Requires Bun 1.4.4.

```bash
bun install
bun run build:single-exe
```

## Credits

HAPI means "哈皮" a Chinese transliteration of [Happy](https://github.com/slopus/happy). Great credit to the original project.
