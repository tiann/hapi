# How it Works

HAPI consists of three interconnected components that work together to provide remote AI agent control.

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Your Local Machine                               │
│                                                                            │
│   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐       │
│   │              │         │              │         │              │       │
│   │   HAPI CLI   │◄───────►│ HAPI Server  │◄───────►│   Web App    │       │
│   │              │ Socket  │              │   SSE   │  (embedded)  │       │
│   │  + AI Agent  │   .IO   │  + SQLite    │         │              │       │
│   │              │         │  + REST API  │         │              │       │
│   └──────────────┘         └──────┬───────┘         └──────────────┘       │
│                                   │                                        │
│                                   │ localhost:3006                         │
└───────────────────────────────────┼────────────────────────────────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  Tunnel (Optional)│
                          │  Cloudflare/ngrok │
                          └─────────┬─────────┘
                                    │
┌───────────────────────────────────┼────────────────────────────────────────┐
│                           Public Internet                                  │
│                                   │                                        │
│         ┌─────────────────────────┼─────────────────────────┐              │
│         │                         ▼                         │              │
│         │    ┌──────────────┐           ┌──────────────┐    │              │
│         │    │              │           │              │    │              │
│         │    │  Telegram    │           │    PWA /     │    │              │
│         │    │  Mini App    │           │   Browser    │    │              │
│         │    │              │           │              │    │              │
│         │    └──────────────┘           └──────────────┘    │              │
│         │                                                   │              │
│         └───────────────────────────────────────────────────┘              │
│                            Your Phone                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

## Components

### HAPI CLI

The CLI is a wrapper around AI coding agents (Claude Code, Codex, Gemini). It:

- Starts and manages coding sessions
- Registers sessions with the HAPI server
- Relays messages and permission requests
- Provides MCP (Model Context Protocol) tools

**Key Commands:**
```bash
hapi              # Start Claude Code session
hapi codex        # Start OpenAI Codex session
hapi gemini       # Start Google Gemini session
hapi daemon start # Run background service for remote session spawning
```

### HAPI Server

The server is the central hub that connects everything:

- **HTTP API** - RESTful endpoints for sessions, messages, permissions
- **Socket.IO** - Real-time bidirectional communication with CLI
- **SSE (Server-Sent Events)** - Live updates pushed to web clients
- **SQLite Database** - Persistent storage for sessions and messages
- **Telegram Bot** - Notifications and Mini App integration

### Web App

A React-based PWA that provides the mobile interface:

- **Session List** - View all active and past sessions
- **Chat Interface** - Send messages and view agent responses
- **Permission Management** - Approve or deny tool access
- **File Browser** - Browse project files and view git diffs
- **Remote Spawn** - Start new sessions on any connected machine

## Data Flow

### Starting a Session

```
1. User runs `hapi` in terminal
         │
         ▼
2. CLI starts Claude Code (or other agent)
         │
         ▼
3. CLI connects to server via Socket.IO
         │
         ▼
4. Server creates session in database
         │
         ▼
5. Web clients receive SSE update
         │
         ▼
6. Session appears in mobile app
```

### Permission Request Flow

```
1. AI agent requests tool permission (e.g., file edit)
         │
         ▼
2. CLI sends permission request to server
         │
         ▼
3. Server stores request and notifies via SSE + Telegram
         │
         ▼
4. User receives notification on phone
         │
         ▼
5. User approves/denies in web app or Telegram
         │
         ▼
6. Server relays decision to CLI via Socket.IO
         │
         ▼
7. CLI informs AI agent, execution continues
```

### Message Flow

```
User (Phone)                Server                    CLI
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

### CLI ↔ Server: Socket.IO

Real-time bidirectional communication for:
- Session registration and heartbeat
- Message relay (user input → agent)
- Permission requests and responses
- Metadata and state updates
- RPC method invocation

### Server ↔ Web: REST + SSE

- **REST API** for actions (send message, approve permission)
- **SSE stream** for real-time updates (new messages, status changes)

### External Access: Tunnel

For remote access outside your local network:
- **Cloudflare Tunnel** (recommended) - Free, secure, reliable
- **Tailscale** - Mesh VPN for private networks
- **ngrok** - Quick setup for testing
