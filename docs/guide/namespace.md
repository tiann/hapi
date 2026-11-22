---
description: "Share one public HAPI hub across a small team by giving each member an isolated namespace through the access token suffix."
---

# Namespace (Advanced)

Namespaces are intended for small teams sharing a single public HAPI hub. Each team member uses a different namespace to isolate their sessions and machines without running separate hubs.

This is not a default setup path for most users.

## How it works

- The hub uses a single base `CLI_API_TOKEN`.
- Clients append `:<namespace>` to the token for isolation.

## Setup

1. On the hub, configure only the base token:

```
CLI_API_TOKEN="your-base-token"
```

2. For each user, append a namespace in the client token:

```
CLI_API_TOKEN="your-base-token:alice"
```

3. Web login, native app pairing and Telegram binding use the same `base:namespace` token.

## Limitations and gotchas

- Hub-side `CLI_API_TOKEN` must not include `:<namespace>`. The hub validates the token from both the environment variable and `settings.json`, and refuses to start with an error if a suffix is present.
- Namespaces are isolated: sessions, machines, and users are not visible across namespaces.
- The hub and the CLI on the same machine share `~/.hapi/settings.json`. Running `hapi auth login` with a `base:namespace` token there saves it as the hub's `cliApiToken`, and the hub then refuses to start. On the hub machine, give namespaced CLIs their own `HAPI_HOME` or set `CLI_API_TOKEN` in their environment only.
- Passkeys belong to the namespace that was signed in when they were added, and sign in only to that namespace. See [Authentication](./authentication.md#passkeys).
- One machine ID cannot be reused across namespaces.
  - To run multiple namespaces on one machine, use a separate `HAPI_HOME` per namespace, or clear the machine ID with `hapi auth logout` before switching.
- Remote spawn is namespace-scoped. If you need remote spawning for multiple namespaces on the same machine, run a separate runner per namespace (use separate `HAPI_HOME`).
