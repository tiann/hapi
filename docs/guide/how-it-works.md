# How it Works

HAPI connects coding agents, a self-hosted hub, and web/native clients for remote control.

## Architecture Overview

```text
CLI + Agent  <---- Socket.IO /cli ---->  Hub + SQLite
Runner       <---- Socket.IO /cli ---->       |
  |                                          | REST + SSE
  +-- spawns CLI sessions                    |
                                     Web / PWA / Mini App
                                     Native iOS / Android
```

The hub can run on your local desktop or a remote host (VPS, cloud, etc.).
Clients reach it directly or through an optional tunnel/reverse proxy. Use an
HTTPS hub origin for native pairing; see [Deployment](./deployment.md).

## Components

### HAPI CLI

The CLI is a wrapper around AI coding agents. It supports multiple agent flavors out of the box — see [Supported agents](./agents.md) for the full list. It:

- Starts and manages coding sessions
- Registers sessions with the HAPI hub
- Relays messages and permission requests
- Provides MCP (Model Context Protocol) tools

**Key Commands:**
```bash
hapi              # Choose an agent interactively and start a session
hapi <agent>      # Start a supported agent directly (required in scripts)
hapi runner start # Run background service for remote session spawning
hapi ping-peer --list  # Shell peer shortlist (prefer MCP list_peers in-session)
```

MCP peer tools (same hub/namespace as the session): `list_peers` (discover), `inspect_peer` (read), `ping_peer` (message). These work from runner-spawned sessions even when the hub is on another host - see [Installation → Split hub + remote runner](./installation.md#split-hub-remote-runner-peer-discovery).

### HAPI Hub

The hub is the central service that connects everything:

- **HTTP API** - RESTful endpoints for sessions, messages, permissions
- **Socket.IO** - Real-time bidirectional communication with CLI
- **SSE (Server-Sent Events)** - Live updates pushed to web and native clients
- **SQLite Database** - Persistent storage for sessions and messages
- **Telegram Bot** - Notifications and Mini App integration

### Web App

A React-based PWA usable in a browser, as an installed PWA, or as a Telegram Mini App:

- **Session List** - View all active and past sessions
- **Chat Interface** - Send messages and view agent responses
- **Permission Management** - Approve or deny tool access
- **File Browser** - Browse project files and view git diffs
- **Terminal View** - Run commands on the working machine from your browser
- **Voice Assistant** - Talk to your agent and approve permissions by voice (see [Voice input and assistant](./voice-assistant.md))
- **Session References** - Copy a session reference or mention another conversation for context
- **Remote Spawn** - Start new sessions on any connected machine

### Native apps

The iOS SwiftUI/UIKit and Android Kotlin Compose apps are independent clients
of the hub. Both support sessions/chat, approvals and questions, new sessions,
attachments, files/Git, Scratchlist, dictation and native push. Their interactive
traffic uses the same REST + SSE client API; background notifications use
FCM/APNs with the [native push contract](../api/native-companion-contract.md).

The apps have their own navigation and rendering. Protocol fixture conformance
does not imply web UI parity: the terminal, Work Graph and realtime voice
controls remain web features. See [Native apps](./native-apps.md) for current
capabilities, platform differences and build/pairing instructions.

## Data Flow

### Starting a Session

```
1. User runs `hapi` and chooses an agent
         │
         ▼
2. CLI starts the selected agent
         │
         ▼
3. CLI connects to hub via Socket.IO
         │
         ▼
4. Hub creates session in database
         │
         ▼
5. Web/native clients receive SSE update
         │
         ▼
6. Session appears in mobile app
```

### Permission Request Flow

```
1. AI agent requests tool permission (e.g., file edit)
         │
         ▼
2. CLI sends permission request to hub
         │
         ▼
3. Hub stores request and sends SSE + configured notifications
         │
         ▼
4. User receives notification on phone
         │
         ▼
5. User approves/denies in a native or web client
         │
         ▼
6. Hub relays decision to CLI via Socket.IO
         │
         ▼
7. CLI informs AI agent, execution continues
```

### Message Flow

```
User (Phone)                 Hub                     CLI
     │                         │                       │
     │──── Send message ──────►│                       │
     │                         │─── Socket.IO emit ───►│
     │                         │                       │
     │                         │                       ├── AI processes
     │                         │                       │
     │                         │◄── Stream response ───│
     │◄─────── SSE ────────────│                       │
     │                         │                       │
```

## Communication Protocols

### CLI ↔ Hub: Socket.IO

Real-time bidirectional communication for:
- Session registration and heartbeat
- Message relay (user input → agent)
- Permission requests and responses
- Metadata and state updates
- RPC method invocation

### Hub ↔ Web/native clients: REST + SSE

- **REST API** for actions (send message, approve permission)
- **SSE stream** for real-time updates (new messages, status changes)

### External Access: Tunnel

For remote access outside your local network:
- **Built-in relay** (`hapi hub --relay`) - Managed tunwg tunnel (WireGuard + TLS), no third-party account required
- **Cloudflare Tunnel** (recommended) - Free, secure, reliable
- **Tailscale** - Mesh VPN for private networks
- **ngrok** - Quick setup for testing

## Seamless Handoff

HAPI's defining feature is the ability to seamlessly hand off control between local terminal and remote devices without losing session state.

### Local Mode

When working in local mode, you have the full terminal experience — it is the native agent CLI (Claude Code, Codex, OpenCode, and more):

- Direct keyboard input with instant response
- Full terminal UI with syntax highlighting
- Best for focused, uninterrupted coding sessions
- Agent tools run on your machine; model requests use the provider configured in the agent

### Remote Mode

Switch to remote mode when you need to step away:

- Control via Web/PWA/Telegram from any device
- Approve permissions on the go
- Monitor progress while away from your desk
- Session continues running on your local machine

### How Switching Works

```
┌─────────────────┐                    ┌─────────────────┐
│   Local Mode    │◄──────────────────►│   Remote Mode   │
│   (Terminal)    │                    │   (Phone/Web)   │
└─────────────────┘                    └─────────────────┘
        │                                      │
        │  ┌────────────────────────────┐      │
        └─►│  Same Session, Same State  │◄─────┘
           └────────────────────────────┘
```

**Local → Remote:**
- Open the session on your phone/web and send a message
- HAPI keeps the conversation going on the same working machine

**Remote → Local:**
- Continue typing in the terminal
- If the terminal shows the remote-control screen, press double-space to return to local input

Some agents keep both interfaces available at once, so no switch is needed.
For Codex terminal-exit and resume behavior, see [Usage and limits](./codex-shared-sessions.md).

### Use Cases

1. **Remote Control While Away** - Start a session at your desk, continue from your phone during commute or coffee break

2. **Permission Approval** - AI requests file access, you get notified on phone, approve with one tap, session continues

3. **Multi-Device Collaboration** - View session progress on your phone while your desktop does the heavy lifting
