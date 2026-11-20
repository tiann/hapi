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

The `permission` module ports the CLI's shared permission bookkeeping
(`cli/src/modules/common/permission/BasePermissionHandler.ts`): mode- and
name-based auto-approval, pending requests mirrored into `agentState`, and
cancellation of orphaned or superseded requests. It does not depend on a
transport; `response_handler` returns the closure that an RPC layer registers
for the `permission` method.
