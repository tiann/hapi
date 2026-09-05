---
name: hapi-session-control
description: Create, wait for, inspect, message, stop, archive, or delete HAPI coding-agent sessions across machines and workspaces. Use for delegated work, peer messages, session links or IDs, result collection, and cleanup.
---

# HAPI session control

Use the `hapi` CLI. Treat non-zero exit status or JSON with `"ok": false` as failure.

## Safety invariant

- New delegated work always gets a fresh session via `hapi spawn-peer`.
- Never list, select, resume, inspect, stop, archive, or message a pre-existing session unless the user supplied its exact session ID in the current request. A `/sessions/<id>` citation supplies that exact ID. A child returned by your own successful `spawn-peer` call is not pre-existing.
- Never substitute a different or previously known session when creation, delivery, lookup, or verification fails. Report the failure instead.
- Do not use raw Hub HTTP calls. The CLI enforces namespace, freshness, remit delivery, and cleanup rules.

## Fresh delegation

Choose an explicit absolute working directory on the selected machine and a remit. Then run:

```sh
hapi machines --json
hapi spawn-peer --dir <path> --name <title> --agent <flavor> --message-file - --json
```

`machines` returns exact machine IDs and their advertised workspace roots. Pass the remit on stdin. Use `--machine <exact-machine-id>` only when the user selected another runner. Optional runtime selectors are `--model`, `--effort`, `--permission-mode`, and `--session-type`. `--effort` supports Claude, Grok, Pi, and AGY effort plus Codex and OpenCode reasoning effort; omit it for other flavors.

For caller-managed retry after an ambiguous transport failure, add `--remit-id <new-uuid>` to the first call and reuse that UUID only with the identical spawn request. The CLI also retries one ambiguous response internally with the same remit ID.

The successful JSON contains `sessionId` and `remitId`. Wait for that remit's result:

```sh
hapi wait-peer <exact-session-id> --remit-id <remit-id> --json
```

After collecting the result—or if waiting fails—clean up the child you created:

```sh
hapi archive-peer <exact-session-id> --json
```

If spawn fails after allocating a child, the Hub performs compensating stop/archive cleanup. Do not retry against the returned child ID. Treat cleanup failure as an error; never substitute a pre-existing session.

## User-selected existing session

Only with an exact ID supplied by the user:

```sh
hapi inspect-peer <exact-session-id> --json
hapi ping-peer <exact-session-id> --message-file - --json
hapi abort-peer <exact-session-id> --json
hapi stop-peer <exact-session-id> --json
hapi archive-peer <exact-session-id> --json
hapi delete-peer <exact-session-id> --json
```

If `ping-peer` reports an ambiguous send failure, its JSON includes `remitId`. Retry only the identical message to the same exact session with `--remit-id <that-uuid>`.

`abort-peer` cancels the current turn, `stop-peer` terminates the process without archiving, `archive-peer` terminates and archives, and `delete-peer` removes an inactive record. Stop and archive are idempotent.
