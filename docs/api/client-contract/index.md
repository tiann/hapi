# Native client contract

**Audience:** Implementers of native HAPI clients — the iOS app (`ios/`), the Android app (`android/`), and any other non-web client that talks to a hub's client API. These pages are the primary spec for that work: every claim is grounded in hub/web source, and each section names its source file so implementers (human or AI agent) can verify against code.

**Scope:** The HTTP contract between a client and one hub — pairing and auth, REST endpoints, SSE streaming, message pagination, message decoding, and error semantics. Core session/chat features use **REST + SSE**. Web terminals additionally use the JWT-authenticated Socket.IO `/terminal` namespace, outside this contract; `/cli` is the internal CLI↔hub namespace and is not a native-client API.

For installation, pairing and the features exposed by each app, see the
[native app guide](../../guide/native-apps.md). An endpoint documented here
does not imply that both apps expose a corresponding UI.

## Pages

| Page | Contents |
|------|----------|
| [Auth](./auth.md) | Pairing deeplink, access-token grammar, JWT exchange, silent re-auth, namespaces, credential storage |
| [REST](./rest.md) | Interactive client APIs, other hub surfaces, request/response shapes, gzip negotiation |
| [SSE](./sse.md) | `GET /api/events` stream: subscription modes, resume handshake, event ids, reconnect policy |
| [Pagination](./pagination.md) | Message window: composite cursors, epoch reset, optimistic-send reconciliation |
| [Messages](./messages.md) | `DecryptedMessage.content` decoding tree (`codex` / `output` / `event` families) |
| [Errors](./errors.md) | `{status, code}` table, error body shapes, RPC-wrapped failure modes |

## Versioning

Source of truth: `hub/src/web/server.ts` (`/health` route), `shared/src/version.ts`.

`GET /health` requires no auth and returns:

```json
{
  "status": "ok",
  "protocolVersion": 1,
  "capabilities": {
    "workGraph": true,
    "titleSuggestion": false
  }
}
```

- `protocolVersion` is the wire-protocol generation (`PROTOCOL_VERSION` in `shared/src/version.ts`, currently `1`), separate from app/hub release versions. Both native apps require it to equal their supported version and stop pairing on any mismatch. Sources: iOS `HapiClient/Auth/HubPairingService.swift`; Android `feature/pairing/PairingViewModel.kt`.
- `capabilities` is **additive**: new hub features appear as new keys. Clients must ignore unknown keys and treat missing keys as "not supported". Feature-gate on capability keys, never on hub build versions.

## Executable spec: golden fixtures

The prose in [Messages](./messages.md) describes the decoding tree, but the *normative* artifact is `shared/fixtures/` — machine-generated golden files produced from the web implementation's chat pipeline (`web/src/chat/`). A native client's protocol module must reproduce those fixtures exactly; CI regenerates them whenever the web pipeline changes, so drift is caught automatically.

The fixtures and native conformance suites are present in this repository.
Regenerate fixtures from the repo root with `bun run gen:fixtures`; never
hand-edit generated JSON. See the native package READMEs for conformance checks.
Fixtures pin protocol decoding and state transitions, not visual presentation
or feature parity between native apps and the web.

## Relationship to the companion push contract

The [native companion contract](../native-companion-contract.md) specifies
Android/iOS device registration (`POST /api/devices/register`), encrypted
push envelopes, direct FCM/APNs delivery, and the shared push relay. A native
client implements this contract for interactive features and that contract
for background push. Where they overlap (auth, send-message, approve/deny),
this contract is the more detailed spec.
