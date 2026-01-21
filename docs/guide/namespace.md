# Namespace (Advanced)

Namespaces are intended for small teams sharing a single public HAPI server. Each team member uses a different namespace to isolate their sessions and machines without running separate servers.

This is not a default setup path for most users.

## How it works

- The server uses a single base `CLI_API_TOKEN`.
- Clients append `:<namespace>` to the token for isolation.

## Setup

1. On the server, configure only the base token:

```
CLI_API_TOKEN="your-base-token"
```

2. For each user, append a namespace in the client token:

```
CLI_API_TOKEN="your-base-token:alice"
```

3. Web login and Telegram binding should use the same `base:namespace` token.

## Limitations and gotchas

- Server-side `CLI_API_TOKEN` must not include `:<namespace>`. If it does, the server will strip the suffix and log a warning.
- Namespaces are isolated: sessions, machines, and users are not visible across namespaces.
- One machine ID cannot be reused across namespaces.
  - To run multiple namespaces on one machine, use a separate `HAPI_HOME` per namespace, or clear the machine ID with `hapi auth logout` before switching.
- Remote spawn is namespace-scoped. If you need remote spawning for multiple namespaces on the same machine, run a separate runner per namespace (use separate `HAPI_HOME`).
