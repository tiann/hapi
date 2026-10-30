# Why HAPI?

[Happy](https://github.com/slopus/happy) is an excellent project. So why build HAPI?

**The short answer**: Happy uses a centralized server that stores your encrypted data. HAPI is decentralized — each user runs their own hub, and the optional network relay forwards encrypted traffic rather than hosting your conversation history. These different goals lead to fundamentally different architectures.

## TL;DR

| Aspect | Happy | HAPI |
|--------|-------|------|
| **Architecture** | Centralized (cloud server stores encrypted data) | Decentralized (each user runs own hub) |
| **Users** | Multi-user on shared server | Any number (each runs own hub) |
| **Session history** | Encrypted on server (server cannot read) | Stored on your own hub |
| **Encryption** | Application-layer E2EE (client encrypts before sending) | WireGuard + TLS via relay; HTTPS for self-hosted remote access |
| **Deployment** | Multiple services (PostgreSQL, Redis, app server) | Single binary |
| **Complexity** | High (E2EE, key management, scaling) | Low (one command) |

**Choose HAPI if**: You want data sovereignty, self-hosting, and minimal setup.

**Choose Happy if**: You need a managed cloud service with multi-user collaboration.

## Architecture Comparison

### Happy: Centralized Cloud

Happy's centralized design requires:

- **Application-layer E2EE** — Clients encrypt before sending; the server stores encrypted blobs it cannot read
- **Distributed database + cache** — PostgreSQL + Redis for multi-user scaling
- **Complex deployment** — Docker, multiple services, config files

```
┌─────────────────────────────────────────────────────────────────────────┐
│                             PUBLIC INTERNET                             │
│                                                                         │
│   ┌─────────────┐                    ┌─────────────────────────────────┐│
│   │             │                    │        Cloud Server             ││
│   │  Mobile App │◄───── E2EE ───────►│                                 ││
│   │             │                    │  ┌─────────────────────────────┐││
│   └─────────────┘                    │  │   Encrypted Database        │││
│                                      │  │   (server cannot read)      │││
│                                      │  └─────────────────────────────┘││
│                                      └────────────────┬────────────────┘│
│                                                       │ E2EE            │
└───────────────────────────────────────────────────────┼─────────────────┘
                                                        ▼
                                             ┌───────────────────┐
                                             │       CLI         │
                                             │ (holds the keys)  │
                                             └───────────────────┘
```

The server stores encrypted data — it never sees plaintext, but it does hold your data.

### HAPI: Decentralized

Each user runs their own hub. HAPI offers two modes of remote access:

- **Self-hosted** (own server / Cloudflare Tunnel / Tailscale) — You choose the host and HTTPS endpoint
- **Public relay** (`hapi hub --relay`) — E2E encrypted via tunwg (WireGuard + TLS); the relay only forwards opaque packets
- **Single embedded database** — SQLite, no external services
- **One-command deployment** — Single binary, zero config

#### Mode 1: Self-Hosted (own server or tunnel)

You operate the hub and choose how to expose it. Use HTTPS for remote access; a third-party proxy that terminates TLS is part of that trust boundary.

```
┌────────────────────────────────────────────────────────────────────────┐
│                       YOUR NETWORK / TUNNEL                            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                   Single Process / Binary                      │   │
│   │                                                                │   │
│   │  ┌──────────┐    ┌──────────┐    ┌──────────┐                  │   │
│   │  │   CLI    │◄──►│   Hub    │◄──►│ Web App  │                  │   │
│   │  └──────────┘    └────┬─────┘    └──────────┘                  │   │
│   │                       │                                        │   │
│   │                       ▼                                        │   │
│   │              ┌────────────────┐                                │   │
│   │              │ Local Database │                                │   │
│   │              │  (plaintext)   │                                │   │
│   │              └────────────────┘                                │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                            │                                           │
│                            ▼ HTTPS                                     │
│               ┌────────────────────────┐                               │
│               │ Cloudflare / Tailscale │                               │
│               │ / Public IP / etc.     │                               │
│               └────────────────────────┘                               │
└────────────────────────────────────────────────────────────────────────┘
```

#### Mode 2: Public Relay (E2E encrypted)

The relay server only forwards encrypted packets — it cannot read your data.

```
┌────────────────────────────────────────────────────────────────────────┐
│                       YOUR MACHINE                                     │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                   Single Process / Binary                      │   │
│   │                                                                │   │
│   │  ┌──────────┐    ┌──────────┐    ┌──────────┐                  │   │
│   │  │   CLI    │◄──►│   Hub    │◄──►│ Web App  │                  │   │
│   │  └──────────┘    └────┬─────┘    └──────────┘                  │   │
│   │                       │                                        │   │
│   │                       ▼                                        │   │
│   │              ┌────────────────┐                                │   │
│   │              │ Local Database │                                │   │
│   │              │  (plaintext)   │                                │   │
│   │              └────────────────┘                                │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                            │                                           │
│                            ▼ tunwg (WireGuard + TLS)                   │
└────────────────────────────┼───────────────────────────────────────────┘
                             │ E2E encrypted
                    ┌────────▼────────┐
                    │  Relay Server   │
                    │  (forwards only,│
                    │  cannot read)   │
                    └────────┬────────┘
                             │ E2E encrypted
                    ┌────────▼────────┐
                    │  Your Phone /   │
                    │  Browser        │
                    └─────────────────┘
```

## Key Differences

### Data Location

| Aspect | Happy | HAPI |
|--------|-------|------|
| **Where session history lives** | Cloud server (encrypted blobs) | Your own hub |
| **Who stores it** | Central server holds encrypted data | Your hub; clients may cache data |
| **Data at rest** | Encrypted (server cannot read) | Plaintext (protected by OS) |
| **Server's role** | Stores encrypted data + syncs devices | Your hub stores history; optional relay forwards traffic |

### Deployment Model

**Happy** requires orchestrating multiple components:

```
┌───────────────────────────────────────────────────────────────────┐
│   Distributed Services (4+ components)                            │
│                                                                   │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│   │ Database │  │  Cache   │  │ Storage  │  │  Server  │          │
│   │(Postgres)│  │ (Redis)  │  │ (Files)  │  │(Node.js) │          │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘          │
│                                                                   │
│   Requires: Container orchestration, multiple config files        │
└───────────────────────────────────────────────────────────────────┘
```

**HAPI** bundles everything:

```
┌───────────────────────────────────────────────────────────────────┐
│   Single Binary (everything bundled)                              │
│                                                                   │
│   ┌─────────────────────────────────────────────────────────────┐ │
│   │  CLI + Hub + Web App + Database (SQLite, embedded)          │ │
│   └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│   Requires: One command to run                                    │
└───────────────────────────────────────────────────────────────────┘
```

### Security Approach

| Aspect | Happy | HAPI (self-hosted) | HAPI (relay) |
|--------|-------|-------------------|--------------|
| **Problem** | Data on untrusted server | Remote access to local hub | Remote access via third-party relay |
| **Solution** | Application-layer E2EE | HTTPS (you control the path) | WireGuard + TLS (tunwg) |
| **Key management** | Client holds keys; server never sees plaintext | Not needed | Handled by tunwg automatically |
| **Data at rest** | Encrypted on server | Plaintext on your machine | Plaintext on your machine |

## Why Different Architectures?

### Happy: Centralized

```
Goal: Multi-user cloud platform
         │
         ├──► Server stores user data
         │         └──► Must encrypt everything (application-layer E2EE)
         │
         ├──► Many concurrent users on one server
         │         └──► Must scale horizontally (PostgreSQL, Redis)
         │
         └──► Multiple devices per user
                   └──► Must sync encrypted state across devices
```

**Result**: Sophisticated infrastructure with zero-knowledge server

### HAPI: Decentralized

```
Goal: Self-hosted tool — each user runs their own hub
         │
         ├──► History stored on your own hub
         │         └──► No central HAPI history store
         │
         ├──► Each user has their own hub
         │         └──► No horizontal scaling needed; unlimited users in aggregate
         │
         ├──► Self-hosted access (own server/tunnel)
         │         └──► Your hub behind your chosen HTTPS endpoint
         │
         └──► Public relay access
                   └──► WireGuard + TLS (tunwg) — relay forwards only
```

**Result**: Simple, portable, one-command deployment

## Summary

| Dimension | Happy | HAPI |
|-----------|-------|------|
| **Architecture** | Centralized cloud server | Decentralized (each user runs own hub) |
| **Server's role** | Stores encrypted data | Your hub stores history; optional relay forwards traffic |
| **Data location** | Server (encrypted, zero-knowledge) | Local (plaintext, your machine) |
| **Deployment** | Multiple services (PostgreSQL, Redis, Node.js) | Single binary (embedded SQLite) |
| **Encryption** | Application-layer E2EE (client-side) | WireGuard + TLS (relay) or HTTPS (self-hosted) |
| **Scaling** | Horizontal (multi-user on shared server) | Per-user (each runs own hub) |
| **Target user** | Managed cloud service users | Self-hosters who want data sovereignty |

## Conclusion

The architectural differences stem from a centralized vs decentralized design:

- **Happy**: Centralized cloud server that stores your encrypted data. The server never sees plaintext (zero-knowledge), but it does hold your data. This requires application-layer E2EE, key management, and distributed infrastructure (PostgreSQL, Redis, scaling).

- **HAPI**: Decentralized — you run the hub that stores your session history, on your workstation or another host you control. Remote access uses your own HTTPS endpoint or the built-in encrypted network relay. The CLI, hub, web app, and SQLite database ship in one binary.

The core tradeoff: Happy encrypts data for storage on its server; HAPI puts the history store under your control. Coding agents and optional voice, title-generation, and notification features still use their configured providers. See the [Privacy Policy](../privacy.md) for those data flows and native push relay metadata.
