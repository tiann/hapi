# hapi-wrapper-core

This library provides the foundations for an optional native HAPI session wrapper.
It implements JavaScript-compatible JSON helpers, resolves CLI configuration from
the environment and settings file, and connects to the hub’s `/cli` namespace
over WebSocket using Engine.IO 4 and Socket.IO 5. The TypeScript product does
not use this crate yet.

The PEM files in `tests/fixtures/` contain a self-signed test CA and a localhost
server certificate and private key. They are used only by the TLS tests.

Socket.IO JSON decoding replaces each unpaired UTF-16 surrogate with U+FFFD.
Valid surrogate pairs retain their character, and re-encoding preserves the
normalized string.

The `hooks` module ports Claude's hook bridge: the token-protected loopback
server (`cli/src/claude/utils/startHookServer.ts`), the `hook-forwarder`
command that relays hook stdin to it (`sessionHookForwarder.ts`), and the
generated hook settings file (`cli/src/modules/common/hooks/generateHookSettings.ts`).
Unlike the TypeScript writer, the settings file is created with mode 0600 and
renamed into place, because its command line carries the hook token.
