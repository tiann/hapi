# Message pagination, windowing, and optimistic sends

**Audience:** Implementers of native HAPI clients (iOS / Android). This page specifies the message paging protocol (`GET /api/sessions/:id/messages`), the epoch reset contract, the tail-sync loop, recommended client windowing, and the optimistic-send / cancel lifecycle. Companion pages: [sse](./sse.md), [messages](./messages.md), [rest](./rest.md).

Source of truth: `shared/src/apiTypes.ts` (`MessagesQuerySchema`, `MessagesResponse`, `SendMessageRequestSchema`), `hub/src/web/routes/messages.ts`, `hub/src/sync/messageService.ts`, `hub/src/store/messages.ts`, reference client `web/src/lib/message-window-store.ts` + `web/src/lib/messages.ts`.

---

## Position key

Messages are ordered by a **compound position**, not by `seq` alone:

```
position = (at, seq)   where at = invokedAt ?? createdAt
```

Ascending by `at`, ties broken by `seq`. Rationale: a queued user message sits at its `createdAt` until the agent consumes it, at which point `invokedAt` is stamped and the row **moves forward** to its invocation position. `seq` (per-session insert counter) alone would freeze queued rows at enqueue order. Every cursor in this protocol is therefore a `(seq, at)` **pair** — both halves are always required together.

---

## `GET /api/sessions/:id/messages`

Query parameters (`MessagesQuerySchema`; all numbers coerced from strings):

| Param | Type | Constraint |
|---|---|---|
| `limit` | int | 1–200. **Default 50** when omitted (the web reference always sends 200). |
| `beforeSeq` + `beforeAt` | int + int | Page strictly older than this position. Pairwise required. |
| `afterSeq` + `afterAt` | int + int | Page strictly newer than this position. Pairwise required. |
| `untilSeq` + `untilAt` | int + int | Inclusive snapshot head for a catch-up loop. Pairwise required; **requires an `after` cursor**. |
| `epoch` | int ≥ 0 | Client's cached epoch. **Requires an `after` cursor.** |

Validation rules (violations are `400 {"error":"Invalid query","issues":…}`):

- `beforeAt`⇄`beforeSeq`, `afterAt`⇄`afterSeq`, `untilAt`⇄`untilSeq` must each be provided together.
- `before` and `after` are **mutually exclusive**.
- `until` and `epoch` are only valid alongside `after`.

Session errors: `404` not found, `403` foreign namespace (see [errors](./errors.md)).

### Response shape

```ts
type MessagesResponse = {
  messages: DecryptedMessage[]          // ascending display order
  page: {
    direction: 'latest' | 'before' | 'after'
    limit: number
    epoch: number                       // server's current epoch for this session
    reset: boolean                      // true ⇒ discard your window, this page replaces it
    nextBeforeSeq: number | null        // cursor for the next OLDER page
    nextBeforeAt: number | null
    nextAfterSeq: number | null         // cursor for the next NEWER page
    nextAfterAt: number | null
    snapshotHeadSeq: number | null      // newest position at snapshot time
    snapshotHeadAt: number | null
    hasMore: boolean                    // more rows exist in the requested direction
  }
}
```

### `latest` (no cursor)

Newest `limit` rows by position, **plus** — out of band — every uninvoked local user message (queued rows, including future-scheduled ones), so a fresh client still sees the queued bar even when those rows fall outside the page. The out-of-band rows are pinned to every latest response and do **not** affect the cursor: `nextBefore*` anchors to the oldest row of the position-ordered page proper. `hasMore` = at least one row exists before that. If a page contains only server-side-filtered rows (see [messages](./messages.md)), the hub auto-advances to older pages until it can return something or history is exhausted.

### `before`

Rows strictly older than the cursor. `nextBefore*` = oldest row of this page; `hasMore` = at least one row older than that. The response also carries the current `epoch` — compare it to your cached one (see below).

### `after`

Rows strictly newer than the cursor, bounded by an **inclusive snapshot head** = `min(until, currentHead)` (or whichever exists). This keeps a catch-up loop from chasing messages appended while it runs. Responses:

- Client `epoch` ≠ server epoch ⇒ the server ignores the cursor and returns the **latest page with `reset: true`** (`direction: 'latest'`).
- Snapshot head ≤ cursor ⇒ empty page, `hasMore: false`, `nextAfter*` echoes the cursor.
- Otherwise: `nextAfter*` = last row's position, `hasMore` = `nextAfter < snapshotHead`.

---

## Epoch

`epoch` is a per-session monotonic counter (`message_epochs` table, starts at 0) that is bumped whenever history changes in a way that invalidates composite cursors (`hub/src/store/messages.ts`):

- a new row lands **before** the current head position (out-of-order insert, e.g. transcript import with an earlier timestamp);
- a queued message is deleted (cancel);
- rewind / history replace (`replaceSessionMessagesFrom`);
- messages are copied/merged between sessions (both sides), fork hydration.

Client contract:

- **`after` request** — always send your cached `epoch`. On mismatch the server answers with the latest page and `reset: true`; **discard the entire local window** and replace it with that page.
- **`before` request** — the response's `page.epoch` may differ from your cached one; if it does, your cursors are meaningless: drop cursor state, flag the window for a latest reset, and run a fresh tail sync (web: `fetchOlderMessages` → `epoch-reset` outcome).
- A structural change is also announced live via the `messages-invalidated` SSE event — on the open session, clear the window and tail-sync from scratch.

---

## Tail-sync loop

Run after connect, after an SSE `resume: 'gap'` handshake, on session open, and when told to (`messages-invalidated`). Reference: `runTailSync` in `web/src/lib/message-window-store.ts`.

1. **No usable state** (no newest cursor, no cached epoch, or a reset is pending): `GET …/messages?limit=200` (latest), replace/merge into the window, store `page.epoch`, `nextBefore*` (older-page cursor) and `snapshotHead*` (newest cursor). Done.
2. **Have cursor + epoch**: loop
   - `GET …/messages?afterSeq&afterAt&epoch[&untilSeq&untilAt]&limit=200`, where `after` starts at your newest cursor and `until` is the `snapshotHead*` captured from the **first** response of the loop (fixes the target so the loop terminates).
   - `page.reset` or `direction: 'latest'` ⇒ replace the window with this page; stop.
   - Otherwise merge the rows, advance `after = nextAfter*`, update the newest cursor to `max(current, nextAfter)`; stop when `hasMore` is false.
   - Guard: if `nextAfter` did not advance past the previous cursor, abort with an error (protocol violation, do not spin).

New live rows keep arriving via the SSE `message-received` event; ingest them and advance the newest cursor to `max(current, incoming position)`. Only run one tail sync at a time per session; if events force another (e.g. a reset was flagged mid-loop), queue a trailing run.

---

## Client windowing (normative recommendation)

Constants from the web reference (`web/src/lib/message-window-store.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `PAGE_SIZE` | 200 | Request size for every page fetch. |
| `VISIBLE_WINDOW_SIZE` | 400 | Max regular rows kept in **tail** mode (following live bottom). |
| `HISTORY_WINDOW_SIZE` | 600 | Max regular rows kept in **history** mode (user scrolled back). |
| `OLDER_LOAD_WINDOW_SIZE` | 800 | Temporary cap while an older page is being merged (prepend). |
| `AGENT_RUN_WINDOW_SIZE` | 800 | Separate trim bucket for codex `agent-run-*` rows so background-agent traces don't evict chat. |

Rules:

- **Tail mode** trims from the top (oldest dropped). Dropping rows ⇒ set `hasMore: true` and recompute the older-page cursor from the oldest kept row.
- **History mode** trims from the bottom (newest dropped). Dropping newest rows means your window no longer reaches the tail ⇒ flag "latest reset required": on returning to tail mode, discard cursors and fetch a fresh latest page rather than trusting stale ones.
- **Queued rows are never trimmed** (user messages with `invokedAt === null`, see below) — they are re-merged after every trim.
- Persist the window (messages + cursors + epoch) per session for instant cold-start rendering; on re-activation with a persisted cursor, still fetch a fresh latest page first (another client may have advanced the session by many pages) and reconcile.

---

## Optimistic sends

Send: `POST /api/sessions/:id/messages` (see constraints below). Reference: `web/src/hooks/mutations/useSendMessage.ts`, `mergeMessages` in `web/src/lib/messages.ts`.

Lifecycle:

1. Generate a client-side `localId` and append an **optimistic row**: `{id: localId, seq: null, localId, invokedAt: null, scheduledAt, createdAt: now, status:'sending', content: {role:'user', content:{type:'text', text, attachments?}, meta:{deliveryMode}}}`. A row is *optimistic* iff `id === localId`.
2. On POST success: status → `queued` if the session is currently thinking, else `sent`. On failure: drop the row and restore the composer (or keep it as `failed` with a retry affordance when attachments are involved).
3. **Echo**: the hub emits `message-received` carrying the stored row (server `id`, real `seq`, same `localId`). Merging a stored row whose `localId` matches an optimistic row **replaces** the optimistic one, preserving the client-side `status` and any already-known `invokedAt` the server row lacks. Fallback when no `localId` echo matches: drop an optimistic `sent` row when a server user message lands within **10 s** of the same position.
4. **`messages-consumed {localIds, invokedAt}`** (SSE): stamp `invokedAt` and flip status to `sent` on matching rows (skip `failed` ones). This is what moves a message out of the queued bar and into the thread at its invocation position.
5. **`messages-indeterminate {localIds}`** (SSE): the steer outcome is unknown. Keep `invokedAt: null`, mark `deliveryState:'indeterminate'`, exclude the row from automatic replay, and show explicit Retry/Cancel actions.
6. **`messages-requeued {localIds}`** (SSE): an explicit Retry restored normal queue delivery; clear `deliveryState`.
7. **`message-cancelled {messageId, localId?}`** (SSE): remove the row (match either id).

**Queued semantics**: a user message is "queued" iff `invokedAt === null` **strictly**, `deliveryState !== 'indeterminate'`, and `status !== 'failed'`. An indeterminate row remains visible in the unresolved-delivery bar but is not eligible for automatic delivery. `undefined` means already-invoked (rows from pre-V8 hubs omit the field) — only rows explicitly carrying `null` belong in the queued bar. Server-side, rows sent without a `localId` are stamped invoked at insert and can never be queued.

### Queued-state recovery

After a reconnect whose handshake said `resume: 'gap'` (an `ok` resume replayed the consume/cancel events already), the consumed/cancelled events for your queued rows may have been lost. Reference: `web/src/lib/queued-state-reconciliation.ts`.

1. Finish a tail sync.
2. Collect candidate `localId`s: user rows with `invokedAt === null`, excluding optimistic rows still `sending`/`failed`.
3. `POST /api/sessions/:id/messages/queued-state` with `{"localIds": […]}` (max 1000 per call; batch above that) → `{queuedLocalIds: string[], invokedLocalMessages: [{localId, invokedAt}]}`.
4. Apply `invokedLocalMessages` exactly like `messages-consumed`; drop candidates that are in **neither** list (deleted server-side).

---

## Send constraints

`POST /api/sessions/:id/messages` body (`SendMessageRequestSchema`):

| Field | Type | Rules |
|---|---|---|
| `text` | string | Required (route also accepts empty text when `attachments` is non-empty). |
| `localId` | string | Optional but **required for `scheduledAt`**, and required in practice: without it the row is stamped invoked at insert (no queue/ack/cancel path). |
| `attachments` | `AttachmentMetadata[]` | Optional. Not allowed with `scheduledAt`. |
| `scheduledAt` | epoch ms | Optional. Must be ≤ now + **7 days**; requires `localId`; no attachments; never `steer`. |
| `deliveryMode` | `'queue'` \| `'steer'` | Optional, default `queue`. `steer` is honored only for **Pi-flavor** sessions and never for scheduled sends — the hub silently normalizes everything else to `queue`, and deferred/replayed delivery (reconnect backfill, retries, scheduled release) always degrades `steer` to `queue`. |

Response `{"ok": true}`. Sending to an inactive session returns `409 {"error":"Session is inactive","code":"session_inactive"}` — resume/reopen first, and note the resumed session **may have a different id** (migrate drafts and re-target, see [rest](./rest.md)).

---

## Cancel and steer

**Cancel**: `DELETE /api/sessions/:id/messages/:messageId` — `:messageId` may be the server id **or** the `localId`. Response union (`CancelMessageResponseSchema`):

| Response | Meaning | Client action |
|---|---|---|
| `{"status":"cancelled","localId":string\|null}` | Row deleted (or already gone). Bumps the epoch. | Remove the row. |
| `{"status":"invoked","message":DecryptedMessage}` | Too late — the agent consumed it before the cancel landed. | **Ingest the returned message** as the authoritative row (correct `invokedAt`, status `sent`); do not resurrect the queued snapshot. |
| `{"status":"busy","localId":string}` | A live steer is still resolving. | Restore the row as indeterminate; reconcile queued state before allowing Retry/Cancel. |

Other subscribers learn the same outcome via `message-cancelled` / `messages-consumed` SSE events.

**Steer a queued message into the current turn**: `POST /api/sessions/:id/messages/:messageId/steer` (Pi sessions) → `SteerQueuedMessageResponseSchema`:

| Response | Client action |
|---|---|
| `{"status":"steered","localId"}` | Keep the row queued-side; it is being injected into the live turn. |
| `{"status":"invoked","message"}` | Already consumed — ingest the message. |
| `{"status":"failed","error","localId":string\|null}` | Surface the error; the row remains queued. |
