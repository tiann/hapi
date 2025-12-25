# Why Not Happy?

[Happy](https://github.com/slopus/happy) is an excellent project. So why build HAPI?

**The short answer**: Happy is designed for cloud hosting with multiple users. HAPI is designed for self-hosting with a single user. These different goals lead to fundamentally different architectures.

Happy's cloud-first design requires:
- End-to-end encryption (because you don't trust the server)
- Distributed database + cache + storage (because you need to scale)
- Complex deployment (Docker, multiple services, config files)

HAPI's local-first design simplifies everything:
- No E2EE needed (your data never leaves your machine)
- Single embedded database (no scaling required)
- One-command deployment (single binary, zero config)

**TL;DR**: If you want to self-host for personal use, HAPI removes all the complexity that Happy needs for its cloud service.

---

## 1. Architecture Overview

### Happy: Cloud-First

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                               PUBLIC INTERNET                                 │
│                                                                               │
│                                                                               │
│      ┌─────────────┐                      ┌─────────────────────────────────┐   │
│      │             │                      │                                │   │
│      │  Mobile App │◄─────── E2EE ───────►│         Cloud Server           │   │
│      │             │                      │                                │   │
│      └─────────────┘                      │  ┌───────────────────────────┐  │   │
│                                           │  │                          │  │   │
│                                           │  │    Encrypted Database    │  │   │
│                                           │  │    (server cannot read)  │  │   │
│                                           │  │                          │  │   │
│                                           │  └───────────────────────────┘  │   │
│                                           │                                │   │
│                                           └────────────────┬────────────────┘   │
│                                                            │                   │
│                                                            │ E2EE              │
│                                                            │                   │
└──────────────────────────────────────────────────────────────┼───────────────────┘
                                                             │
┌──────────────────────────────────────────────────────────────┼─────────────────────┐
│                               PRIVATE NETWORK              │                    │
│                                                            │                    │
│                                                            ▼                    │
│                              ┌──────────────────────────────────────────────┐    │
│                              │                                             │    │
│                              │                    CLI                      │    │
│                              │                                             │    │
│                              │   ┌────────────────────────────────────┐     │    │
│                              │   │         Encryption Keys            │    │    │
│                              │   │   (only client holds the keys)     │    │    │
│                              │   └────────────────────────────────────┘     │    │
│                              │                                             │    │
│                              └──────────────────────────────────────────────┘    │
│                                                                                 │
└───────────────────────────────────────────────────────────────────────────────────┘


Data Flow:
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                  │
│   CLI ◄───────► Cloud Server ◄───────► App                                       │
│    │               │                    │                                        │
│    │   (encrypt)   │   (ciphertext)     │   (decrypt)                            │
│    ▼               ▼                    ▼                                        │
│  Keys ──────► [Encrypted Data] ◄────── Keys                                      │
│                    │                                                             │
│                    ▼                                                             │
│              Server stores                                                       │
│              encrypted blobs                                                     │
│              (zero knowledge)                                                    │
│                                                                                  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### HAPI: Local-First

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                               PRIVATE NETWORK                                    │
│                                                                                  │
│    ┌──────────────────────────────────────────────────────────────────────────┐    │
│    │                                                                        │    │
│    │                      Single Process / Binary                           │    │
│    │                                                                        │    │
│    │    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐             │    │
│    │    │              │    │              │    │              │            │    │
│    │    │     CLI      │◄──►│    Server    │◄──►│   Web App    │            │    │
│    │    │              │    │              │    │  (embedded)  │            │    │
│    │    └──────────────┘    └──────┬───────┘    └──────────────┘             │    │
│    │                               │                                        │    │
│    │                               ▼                                        │    │
│    │                      ┌────────────────┐                                │    │
│    │                      │                │                                │    │
│    │                      │  Local Database│                                │    │
│    │                      │  (plaintext)   │                                │    │
│    │                      │                │                                │    │
│    │                      └────────────────┘                                │    │
│    │                                                                        │    │
│    └──────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                         │
│                                        │ localhost                               │
└────────────────────────────────────────┼───────────────────────────────────────────┘
                                         │
                                         ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                              TUNNEL (Optional)                                  │
│                                                                                 │
│                    localhost ────────► public URL (TLS)                         │
│                                                                                 │
└────────────────────────────────────────┬──────────────────────────────────────────┘
                                         │
                                         ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                               PUBLIC INTERNET                                   │
│                                                                                 │
│                      ┌───────────────────────────────┐                           │
│                      │                               │                          │
│                      │        Remote Clients         │                          │
│                      │       (PWA / Mini App)        │                          │
│                      │                               │                          │
│                      └───────────────────────────────┘                           │
│                                                                                 │
└───────────────────────────────────────────────────────────────────────────────────┘


Data Flow:
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                  │
│   CLI ◄────────► Server ◄────────► App                                            │
│                    │                                                             │
│                    │  (same machine / process)                                   │
│                    ▼                                                             │
│             Local Database                                                       │
│             (data never leaves)                                                  │
│                    │                                                             │
│                    ▼                                                             │
│              Tunnel provides                                                     │
│              external access                                                     │
│              (TLS encryption)                                                    │
│                                                                                  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Key Architectural Differences

### 2.1 Data Location

| Aspect | Happy | HAPI |
|--------|-------|------|
| **Where data lives** | Cloud server | Your local machine |
| **Who can access** | Server stores encrypted blobs (cannot read) | Only you (data never uploaded) |
| **Trust model** | Don't trust server → need E2EE | Trust local environment → TLS sufficient |

### 2.2 Deployment Model

```
Happy:
┌───────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   Distributed Services (4+ components)                              │
│                                                                     │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│   │ Database │  │  Cache   │  │ Storage  │  │  Server  │            │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘             │
│                                                                     │
│   Requires: Container orchestration, multiple config files          │
│                                                                     │
└───────────────────────────────────────────────────────────────────────┘

HAPI:
┌───────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   Single Binary (everything bundled)                                │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │  CLI + Server + Web App + Database (embedded)             │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                     │
│   Requires: One command to run                                      │
│                                                                     │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.3 Security Approach

| Aspect | Happy | HAPI |
|--------|-------|------|
| **Problem to solve** | Data on untrusted server | External access to local data |
| **Solution** | End-to-end encryption | Tunnel with TLS |
| **Complexity** | High (key management, crypto) | Low (tunnel setup) |
| **Data at rest** | Encrypted | Plaintext (protected by OS) |

---

## 3. Why Different Architectures?

### Happy's Constraints

```
Goal: Multi-user cloud platform
         │
         ├──► Users don't trust your server
         │         │
         │         └──► Must encrypt everything (E2EE)
         │
         ├──► Many concurrent users
         │         │
         │         └──► Must scale horizontally (distributed DB + cache)
         │
         └──► Multiple devices per user
                   │
                   └──► Must sync state across devices (complex sync logic)

Result: Sophisticated but complex architecture
```

### HAPI's Simplifications

```
Goal: Single-user self-hosted tool
         │
         ├──► Data stays on your machine
         │         │
         │         └──► No E2EE needed (you trust yourself)
         │
         ├──► Only one user
         │         │
         │         └──► No scaling needed (simple embedded database)
         │
         └──► One primary device
                   │
                   └──► Minimal sync logic (tunnel for remote access)

Result: Simple and portable architecture
```

---

## 4. Summary

| Dimension | Happy | HAPI |
|-----------|-------|------|
| **Philosophy** | Cloud-first | Local-first |
| **Data location** | Server (encrypted) | Local (plaintext) |
| **Deployment** | Multiple services | Single binary |
| **Scaling** | Horizontal | None needed |
| **Encryption** | Application-layer E2EE | Transport-layer TLS |
| **Target user** | Teams, cloud users | Individuals, self-hosters |

---

## 5. Conclusion

The architectural differences stem from fundamentally different product goals:

- **Happy**: Built for multi-user cloud scenarios. Solves the "untrusted server" problem with E2EE, at the cost of deployment complexity.

- **HAPI**: Built for single-user self-hosted scenarios. Solves the "remote access" problem with tunneling, achieving one-command deployment.

**Choose Happy if**: You need multi-user collaboration or team sharing.

**Choose HAPI if**: You want personal use, data sovereignty, and minimal setup.
