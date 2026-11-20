# hapi-wrapper-core

This library provides the foundations for an optional native HAPI session wrapper.
It implements JavaScript-compatible JSON helpers, resolves CLI configuration from
the environment and settings file, and connects to the hub’s `/cli` namespace
over WebSocket using Engine.IO 4 and Socket.IO 5. The TypeScript product does
not use this crate yet.

A session socket (`sio::client::Client::start_session`) reports its connection
state through a watch channel, starts stopped for an archived session, and after
a server disconnect or a rejected handshake reconnects only on request.

On top of the socket it provides the session layer of `cli/src/api/apiSession.ts`:

- `rest`: the hub REST client (machine registration, session create, fetch and
  message backfill) and the best-effort runner `session-started` webhook.
- `lifecycle::start_marker`: the `ps lstart` marker that identifies a live
  process across PID reuse.
- `rpc::manager`: session-scoped RPC handler registration and dispatch.
- `session::bootstrap`: create or reopen a session, report a runner-started
  session through the webhook, and start its client.
- `session::metadata`: machine and session metadata, worktree discovery, and the
  fields kept when a session is reopened, including the Claude rewind intent.
- `session::incoming_filter`: incoming message dedup by id and sequence cursor,
  backfill and rewind bookkeeping, and the typed user message check.
- `session::echo`: bookkeeping for prompts that the agent may echo back.
- `session::versioned_ack`: queued compare-and-swap updates for metadata and
  agent state, retried with jittered backoff.
- `session::client`: RPC registration and `session-alive` on every connect,
  `update` handling, the hub-archived latch, the stoppable 10 s keepalive,
  incoming dedup with backfill after reconnect, the emit API, prompt-echo
  bookkeeping, and flush and close.
- `schemas`: the session metadata checks of `shared/src/schemas.ts`, including
  the full OpenCode rewind record.

The standalone `queue::MessageQueue2` groups consecutive messages by mode and
supports isolated turns, reservations, and deferred batch acknowledgements.
Reset permits late confirmation of a discarded reservation, as in the CLI.

Some tests compare results with the TypeScript implementation. They run `bun`
and the CLI's `vitest` from `cli/`, and start a Socket.IO hub fixture from
`hub/node_modules`. Run `bun install` first.

The PEM files in `tests/fixtures/` contain a self-signed test CA and a localhost
server certificate and private key. They are used only by the TLS tests.

Socket.IO JSON decoding replaces each unpaired UTF-16 surrogate with U+FFFD.
Valid surrogate pairs retain their character, and re-encoding preserves the
normalized string.
