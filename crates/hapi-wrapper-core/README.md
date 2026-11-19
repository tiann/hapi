# hapi-wrapper-core

This library provides the foundations for an optional native HAPI session wrapper.
It implements JavaScript-compatible JSON helpers, resolves CLI configuration from
the environment and settings file, and connects to the hub’s `/cli` namespace
over WebSocket using Engine.IO 4 and Socket.IO 5. The TypeScript product does
not use this crate yet.

A session socket (`sio::client::Client::start_session`) reports its connection
state through a watch channel, starts stopped for an archived session, and after
a server disconnect or a rejected handshake reconnects only on request.

It also provides the pieces the session layer of `cli/src/api/apiSession.ts`
builds on:

- `rest`: the hub REST client (machine registration, session create, fetch and
  message backfill) and the best-effort runner `session-started` webhook.
- `lifecycle::start_marker`: the `ps lstart` marker that identifies a live
  process across PID reuse.
- `rpc::manager`: session-scoped RPC handler registration and dispatch.
- `schemas`: the session metadata checks of `shared/src/schemas.ts`, including
  the full OpenCode rewind record.

Some tests compare results with the TypeScript implementation. They run `bun`
from `cli/`, and start a Socket.IO hub fixture from `hub/node_modules`. Run
`bun install` first.

The PEM files in `tests/fixtures/` contain a self-signed test CA and a localhost
server certificate and private key. They are used only by the TLS tests.

Socket.IO JSON decoding replaces each unpaired UTF-16 surrogate with U+FFFD.
Valid surrogate pairs retain their character, and re-encoding preserves the
normalized string.
