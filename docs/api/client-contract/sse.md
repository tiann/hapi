# SSE stream (`GET /api/events`)

**Audience:** Implementers of native HAPI clients (iOS / Android). This page specifies the hub's server-sent-events stream: subscription model, framing, resume protocol, the `SyncEvent` union, and the versioned session-patch algorithm. Companion pages: [auth](./auth.md), [REST](./rest.md), [pagination](./pagination.md), [messages](./messages.md).

Source of truth: `hub/src/web/routes/events.ts`, `hub/src/sse/sseManager.ts`, `hub/src/web/sseCompression.ts`, `shared/src/schemas.ts` (`SyncEventSchema`), reference client `web/src/hooks/useSSE.ts`.

---

## Endpoint

`GET /api/events` — long-lived `text/event-stream` response.

| Query param | Values | Notes |
|---|---|---|
| `token` | JWT | Browser `EventSource` cannot set headers, so the auth middleware accepts `?token=` **on this path only** (`hub/src/web/middleware/auth.ts`). Clients that can set headers may use `Authorization: Bearer` instead. |
| `all` | `true` \| `1` | Global subscription: every event in the token's namespace. |
| `sessionId` | session id | Session-scoped subscription. |
| `machineId` | machine id | Machine-scoped subscription (web does not use this). |
| `visibility` | `visible` \| `hidden` | Initial visibility state. Anything other than the literal `visible` is treated as `hidden` (the default). See [Visibility](#visibility). |
| `lastEventId` | event id | Resume cursor for manually rebuilt connections. The standard `Last-Event-ID` **request header wins** over this param when both are present (auto-reconnecting EventSource implementations send the header). |

Up-front checks, before any bytes stream:

| Condition | Response |
|---|---|
| Hub sync engine not ready | `503 {"error":"Not connected"}` |
| `sessionId` unknown | `404 {"error":"Session not found"}` |
| `sessionId` in another namespace | `403 {"error":"Session access denied"}` |
| `machineId` unknown / foreign namespace | `404` / `403` (same pattern) |

A `sessionId` may resolve to a canonical id (superseded/merged sessions); the subscription binds to the **resolved** id.

---

## Framing

Every frame is a standard SSE message whose `data:` line is one JSON-encoded `SyncEvent`:

```
id: 018f3c2a:412:9b1f00aa
data: {"type":"session-updated","sessionId":"...","data":{...}}
```

- **Broadcast events** (replayed and live) carry an `id:` field.
- **`connection-changed`, `heartbeat`, and `toast` frames carry NO `id`.** SSE cursors are sticky: a frame without `id` must keep the previously seen id (native `EventSource` does this automatically; hand-rolled parsers must replicate it). A heartbeat must never reset or blank your cursor.
- The server never sends `retry:`; reconnect policy is entirely client-owned (see [Reconnect policy](#reconnect-policy-normative-recommendation)).

### Event id format

`{epoch}:{seq}:{nsTag}` — treat as opaque; store and echo it back, never interpret it.

| Part | Meaning |
|---|---|
| `epoch` | 8-char random string, fixed per hub **process**. A cursor from before a hub restart can never match. |
| `seq` | Integer, monotonically increasing per hub process (shared across all namespaces/sessions). |
| `nsTag` | First 8 hex chars of `sha256("{epoch}|{namespace}")` — binds the cursor to the namespace it was issued under. |

### Replay ring

The hub keeps the last **256** broadcast events, capped at **2 MiB** of JSON (oldest evicted first; the byte cap always keeps at least one entry). `toast` frames are not recorded (they are visibility-targeted, not broadcast).

---

## Handshake and resume

On subscribe the hub emits, **in this guaranteed order**:

1. `connection-changed` — `{"type":"connection-changed","data":{"status":"connected","subscriptionId":"<uuid>","resume":"ok"|"gap"}}` (no `id`).
2. Replayed events (each with its `id`), when `resume` is `ok`.
3. Live traffic.

Live broadcasts that occur while the replay is being written are queued server-side and flushed after it, so ordering is preserved.

| `resume` verdict | Meaning | Client action |
|---|---|---|
| `ok` | The replay that follows contains **every** event missed since the cursor. | Skip the REST resync entirely. |
| `gap` (or field absent — older hubs) | The hub cannot prove continuity. | Full refetch: session list, session detail(s), message tail sync, and queued-state reconcile for the open session (see [pagination](./pagination.md#queued-state-recovery)). |

`gap` is returned whenever: no cursor was sent, the cursor is malformed, `epoch` differs (hub restarted), `nsTag` differs (cursor issued under a different namespace — e.g. after a token swap on the same hub), `seq` is out of range, or events between the cursor and the ring's oldest entry were evicted.

### Cursor rules (normative)

- Keep one cursor **per subscription filter set** (the `all` / `sessionId` / `machineId` tuple, plus hub + namespace). Never replay a cursor recorded under a different filter set — the hub would replay against the wrong filter and the `ok` verdict would be wrong for what you actually missed.
- Update the cursor **after** the event is durably handled. If handling throws, leave the cursor behind the event so the hub redelivers it (at-least-once delivery; handlers must be idempotent).
- Send the cursor on reconnect via `Last-Event-ID` header or `?lastEventId`.

---

## Reconnect policy (normative recommendation)

These constants come from the web reference client (`web/src/hooks/useSSE.ts`) and the hub (`hub/src/sse/sseManager.ts`); native clients should adopt them.

| Constant | Value | Notes |
|---|---|---|
| Server heartbeat interval | 30 s | `{"type":"heartbeat","namespace":"…","data":{"timestamp":<ms>}}` |
| Staleness threshold | 90 s | No frames (of any kind) for 90 s ⇒ tear down and reconnect. |
| Watchdog tick | 10 s | Staleness check interval; **skip checks while backgrounded**. |
| Foreground-resume staleness check | 45 s | On app-foreground, if the last frame is older than 45 s, reconnect immediately (an OS suspend can kill the socket without any error ever surfacing; one missed heartbeat interval is already enough to distrust it). |
| Connect timeout | 10 s | An attempt that has not reached OPEN in 10 s is likely hung on a dead pooled socket — abandon it and retry on a fresh connection. |
| Backoff | 1 s base, ×2, cap 30 s | Delay for attempt *n* (n ≥ 1) = `min(cap, 1000 · 2^(n-1))`. **First retry is immediate** (jitter only). |
| Jitter | +0–500 ms | Uniform, added to every delay. |
| Slow ceiling | 300 s after 8 attempts | A hub that stays unreachable is usually down for hours; each retry through a relay costs a TLS handshake. |
| Backgrounded | defer retries | Do not schedule retries while backgrounded; reconnect immediately on foreground. Reset the attempt counter to 0 on every successful open. |

Any received frame — heartbeat included — counts as activity for the staleness clock. Do not rely on a platform SSE library's built-in auto-reconnect: it will not honor the backoff, the background deferral, or the connect timeout.

---

## Dual-subscription model

The reference client holds **two** concurrent connections (`web/src/App.tsx`, `web/src/lib/appSseSubscriptions.ts`):

1. **Global** — `all=true`, alive for the whole app session. Drives the session list, machine list, badges, toasts.
2. **Session** — `sessionId=<open session>`, recreated on every session switch. Drives the open chat.

Hub-side delivery (`SSEManager.shouldSend`):

| Event type | Delivered to |
|---|---|
| `connection-changed` | the connection itself |
| `heartbeat` | every connection |
| `toast` | every **visible** connection in the namespace, regardless of filter (no `id`, never replayed) |
| `message-received`, `scheduled-matured` | `all=true` connections + matching `sessionId` connections |
| `session-added` / `session-updated` / `session-removed` / `session-ended` / `messages-invalidated` / `messages-consumed` / `messages-indeterminate` / `messages-requeued` / `message-cancelled` | `all=true` connections + matching `sessionId` connections |
| `machine-updated` | `all=true` connections + matching `machineId` connections |

**The global connection must also handle the message-stream events** (`message-received`, `messages-consumed`, `messages-indeterminate`, `messages-requeued`, `message-cancelled`, `scheduled-matured`): while a session connection is down (reconnect gap) or the session isn't open, the global pipe is the only one alive, and it must still keep queued/optimistic bookkeeping correct — mark local messages consumed, remove cancelled rows, and refresh session-list scheduled counts. The session-scoped connection additionally ingests `message-received` into the message window.

The two connections have **no ordering relationship with each other** — the same `session-updated` patch can arrive on both, in either order. That is why the versioned-patch gate below exists.

---

## SyncEvent union (15 types)

Schema: `SyncEventSchema` in `shared/src/schemas.ts` (discriminated on `type`). All events except `connection-changed` carry `namespace?: string`. Ignore unknown event types.

| `type` | Payload (beyond `type`, `namespace?`) | Client handling |
|---|---|---|
| `session-added` | `sessionId`, `data?: unknown` | Handle exactly like `session-updated` (the reference client shares the branch): a full `Session` upserts; anything else falls back to refetching the session list. |
| `session-updated` | `sessionId`, `data?: Session \| SessionPatch` | See [Versioned patch algorithm](#versioned-patch-algorithm). |
| `session-removed` | `sessionId` | Drop the session from the list, drop its detail cache, clear its message window. |
| `message-received` | `sessionId`, `message: DecryptedMessage` | Ingest into the message window; advance the tail cursor (see [pagination](./pagination.md)). Also fired for the caller's own send (the localId echo). |
| `messages-invalidated` | `sessionId` | Message history changed **structurally** (rewind, fork, import, clear). Session scope: discard the whole window and run a fresh tail sync. Global scope: refetch the session list. |
| `scheduled-matured` | `sessionId` | A scheduled message became due and was handed to the agent. Refetch list/queue indicators. |
| `session-ended` | `sessionId`, `reason?: 'completed'\|'terminated'\|'error'\|'handoff'\|'cleared'` | Session lifecycle signal (the `session-updated` flow still carries the state change). |
| `machine-updated` | `machineId`, `data?: Machine \| MachinePatch \| null` | Full `Machine`: upsert (remove when `active:false`). `null`: machine removed. Patch `{active?, activeAt?, updatedAt?}`: `active:false` ⇒ remove, otherwise refetch machines. `data` absent ⇒ refetch. |
| `toast` | `data: {title, body, sessionId, url}` | Show as in-app toast/banner. Only delivered to visible connections (see [Visibility](#visibility)). |
| `messages-consumed` | `sessionId`, `localIds: string[]`, `invokedAt: number` | The agent consumed queued user messages: stamp `invokedAt`, flip status to `sent`, remove from the queued bar. |
| `messages-indeterminate` | `sessionId`, `localIds: string[]` | A steer was dispatched but its outcome is unknown. Keep the row uninvoked, show an explicit Retry/Cancel resolution, and do not auto-replay it. |
| `messages-requeued` | `sessionId`, `localIds: string[]` | An explicit Retry restored delivery to the normal queue. Clear the indeterminate marker. |
| `message-cancelled` | `sessionId`, `messageId`, `localId?` | A queued message was cancelled: remove the row (match by `messageId` **or** `localId`). |
| `heartbeat` | `data?: {timestamp}` | Feed the staleness watchdog. No other action. **Carries no `id`.** |
| `connection-changed` | `data?: {status, subscriptionId?, resume?: 'ok'\|'gap'}` | Handshake; see [Handshake and resume](#handshake-and-resume). Store `subscriptionId` for visibility reporting. **Carries no `id`.** |

---

## Versioned patch algorithm

The most bug-prone part of the protocol. `session-updated.data` is either a **full `Session`** or a **`SessionPatch`** (`shared/src/schemas.ts`); reference implementation `applySessionDetailPatch` in `web/src/hooks/useSSE.ts`.

1. **Full session** (validates against `SessionSchema` and `data.id === event.sessionId`): replace the cached session wholesale.
2. **Patch** (validates against the strict `SessionPatchSchema` — unknown keys make it fail — and is non-empty): apply field-by-field as below.
3. **Absent or unparseable `data`**: fall back to refetching the session detail and list over REST.

Patch application, field by field:

- **Flat fields** — `active`, `thinking`, `activeAt`, `model`, `modelReasoningEffort`, `effort`, `serviceTier`, `permissionMode`, `collaborationMode`, `copilotAgentMode`, `backgroundTaskCount`: last-write-wins assignment when present. `activeTurnStartedAt` appears in patches but the reference implementation deliberately never applies it from a patch (`web/src/lib/sessionPatch.ts`) — take it from full-session payloads only; the `sse/` fixtures pin this.
- **`updatedAt`** — max-monotonic: `updatedAt = max(cached.updatedAt, patch.updatedAt)`. A stale replay must never move the clock backward.
- **Versioned sub-patches** — `metadata`, `agentState`, `todos`, `teamState` each arrive as a wrapper `{version: number, value: …}`. Apply `value` and store `version` **only when `version` is strictly greater than the cached watermark**:

  | Wrapper | Cached watermark on `Session` | `value` type |
  |---|---|---|
  | `metadata` | `metadataVersion` | `Metadata \| null` |
  | `agentState` | `agentStateVersion` | `AgentState \| null` |
  | `todos` | `todosUpdatedAt` (treat absent as 0) | `TodoItem[]` |
  | `teamState` | `teamStateUpdatedAt` (treat absent as 0) | `TeamState \| null` — `null` means "team deleted": clear it |

  Strictly greater, because the two SSE connections have **no shared ordering** — the same version can arrive twice and an older version can arrive after a newer one. Applying a stale `agentState` would resurrect resolved permission requests; a stale `metadata` would regress the resume/session-id state. (The web session-*list* path tolerates `>=` because re-deriving its summary from an equal version is idempotent; for a single-cache native client, strict `>` is the rule.)
- **Never wholesale-spread the wrapper.** `session.metadata` must become `wrapper.value` — assigning `{version, value}` itself into the session is a classic porting bug.
- **`scratchlistUpdatedAt`** — a bare refetch trigger: the patch carries no entries; its presence means "refetch `GET /api/sessions/:id/scratchlist`". Nothing else to apply.

### Keep-alive noise

The CLI keep-alive makes the hub re-broadcast a patch roughly **every 10 s per active session**, in which typically only `activeAt` moves. Recommendation (web: `isRenderIrrelevantSessionPatch`): treat a patch as render-irrelevant when the only effective change is an `activeAt` delta **< 60 s** (relative-time labels only change at minute boundaries); the session-list path ignores `activeAt` entirely. Apply the data if you like, but do not re-render or re-sort six times a minute for it.

Reference list sort (web): `globalPinned` > `pinned` > `active` > `pendingRequestsCount` (among active) > `updatedAt` desc.

---

## Visibility

`POST /api/visibility` with body `{"subscriptionId": "<from connection-changed>", "visibility": "visible" | "hidden"}` → `{"ok": true}`. Errors: `400` invalid body, `404` unknown `subscriptionId` (or namespace mismatch), `503` hub not ready. Each new connection has a **new** `subscriptionId` — re-report after every reconnect (the web reference reports both of its connections on every foreground/background transition and retries a failed report after 2 s).

Semantics (`hub/src/visibility/visibilityTracker.ts`, `hub/src/push/pushNotificationChannel.ts`): when **any** connection in the namespace is visible, the hub delivers notification events (ready / permission request / task result) as in-app **`toast` SSE frames to the visible connections** and suppresses Web Push for the namespace; Web Push fires only when no visible connection exists (or toast delivery reached zero connections). Native FCM devices (`POST /api/devices/register`) are independent of visibility and fire unconditionally — see [native-companion-contract](../native-companion-contract.md).

Native rule: report `visible` on foreground and `hidden` on background, every time. A native client that stays `visible` while backgrounded suppresses its own (and every PWA's) hub-side push for the namespace, and receives its notifications only as toast frames nobody is looking at.

---

## Gzip

SSE responses are gzip-compressed when `Accept-Encoding` allows it (`hub/src/web/sseCompression.ts`): the hub drives zlib directly and issues a **sync flush after every chunk**, so events arrive immediately despite compression (~75 % ratio on real traffic). Negotiation is q-value-aware (`gzip;q=0` refuses, `*` honored); the response carries `Content-Encoding: gzip` with no `Content-Length`.

Native clients must verify that their HTTP stack **decompresses the stream incrementally** (frames visible per flush, not buffered until EOF). If it does not — or if it only auto-decompresses when it injected `Accept-Encoding` itself — send `Accept-Encoding: identity` and take the uncompressed stream.
