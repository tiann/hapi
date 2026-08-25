# Golden protocol fixtures

Machine-generated conformance fixtures for the HAPI client protocol. The
**web implementation is the source of truth**: every `expected*` value in
every file is produced by running the real web implementation over
hand-authored wire inputs, then applying the normative projection each suite
documents below. Native clients (iOS `HapiProtocol`, Android
`:core:protocol`) port the same logic and must reproduce the expectations
from the inputs exactly.

Three suites:

| Suite | Pins | Web source of truth |
|-------|------|---------------------|
| `chat/` | message decode/render pipeline (normalize → reduce → group) | `web/src/chat/` |
| `sse/` | `session-updated` versioned-patch application | `applySessionDetailPatch` in `web/src/lib/sessionPatch.ts` |
| `pagination/` | message window: paging cursors, epoch resets, optimistic sends, trims | `web/src/lib/message-window-store.ts` + `web/src/lib/messages.ts` |

Never edit the JSON by hand — edit the case definitions in
`web/scripts/fixtures/` (`cases/`, `sse/cases.ts`, `pagination/cases.ts`) and
regenerate.

## Layout

```
shared/fixtures/
├── VERSION                  # current fixtureVersion (single integer + \n)
├── chat/<name>.json         # one fixture per case
├── sse/<name>.json
├── pagination/<name>.json
├── catalogs/modes.json      # reference tables (see Catalogs below)
└── README.md
```

## How to consume (all suites)

- **iOS** (`ios/`, SPM test target): resolve the repo checkout from the test
  file's own location and load every `<suite>/*.json`, e.g.
  `URL(fileURLWithPath: #filePath)` → walk up to the package root →
  `../../shared/fixtures`. Decode the inputs, run the ported implementation,
  project, and compare against the stored expectations.
- **Android** (`android/`, `:core:protocol` JVM tests): pass the directory via
  Gradle — `tasks.withType<Test> { systemProperty("hapi.fixtures.dir",
  rootDir.resolve("../shared/fixtures")) }` — and read it with
  `System.getProperty("hapi.fixtures.dir")` in the test.
- Iterate **all** files in a suite directory (fail on zero files) so newly
  added fixtures are picked up without native-side changes.

### Acceptance bar

Exact match on the normative projection: serialize your computed output and
the fixture's stored expectation to **canonical JSON** (recursively sorted
object keys; numbers as JSON numbers; no `undefined`/absent-key differences)
and compare for equality. Field order in the files is already canonical
(sorted keys, 4-space indent, LF, trailing newline), so a key-sorted
structural deep-compare is equivalent.

### fixtureVersion policy

`fixtureVersion` (mirrored in `VERSION`, shared by all suites) is bumped when
a document schema or a normative projection changes shape. Native suites must
**fail loudly when the on-disk version is newer than the version they
support** (do not silently skip), and should tolerate older versions only if
they explicitly implement them. Additive new fixture *files* and new wire
cases do not bump the version.

---

# Chat suite (`chat/`)

Runs the real web pipeline (`normalizeDecryptedMessage` → `reduceChatBlocks`
→ `buildVisibleChatBlocks`) over wire messages, then projects.

## Document schema (`fixtureVersion: 1`)

```jsonc
{
    "fixtureVersion": 1,
    "name": "claude-assistant-text",        // equals the file name
    "description": "…",
    "input": {
        "messages": [ /* DecryptedMessage[] exactly as GET /sessions/:id/messages returns them */ ],
        "agentState": null,                 // session.agentState (permission requests) or null
        "options": { "hasMoreMessages": false }  // older history exists beyond `messages`
    },
    "expected": {
        "blocks": [ /* projected ChatBlock[] (pre tool-grouping) */ ],
        "hasReadyEvent": false,
        "latestUsage": null,                // or { inputTokens, outputTokens, contextSize, contextWindow }
        "visibleBlocks": [ /* projected blocks after tool-grouping */ ]
    }
}
```

Per fixture, the acceptance comparison covers `blocks`, `hasReadyEvent`,
`latestUsage`, and `visibleBlocks`.

## Normative field contract

The projection keeps **structure + semantics** and drops web-presentation and
advisory detail. Whatever is absent below is intentionally NOT part of the
contract — natives may derive their own equivalents but must not expect it in
fixtures. Implementation: `web/scripts/fixtures/projection.ts` (keep in sync
with this list).

Optional fields are present only when they carry a value; `invokedAt` is
omitted when null. `localId` is always present (nullable) on the block kinds
that carry it.

### Every block

`kind`, `id`, `createdAt`, `invokedAt?`

### Per kind

| kind | normative fields |
|------|------------------|
| `user-text` | `localId`, `text`, `attachments?` — each `{ id, filename, mimeType, size, path }` |
| `agent-text` | `localId`, `text` |
| `agent-reasoning` | `localId`, `text` |
| `cli-output` | `localId`, `text`, `source` (`'user' \| 'assistant'`) |
| `codex-review` | `localId`, `review` (verbatim normalized review object) |
| `generated-image` | `localId`, `imageId`, `fileName`, `mimeType` |
| `agent-event` | `event` — the normalized AgentEvent object verbatim (`type` + typed payload fields) |
| `tool-call` | `localId`, `tool`, `children?` (recursively projected; omitted when empty) |
| `tool-group` (visibleBlocks only) | `firstToolId`, `lastToolId`, `tools` (projected `tool-call` blocks in order; membership + order + count) |

### `tool` object

`{ id, name, state, input?, result?, permission? }`

- `state`: `'pending' | 'running' | 'completed' | 'error'`
- `input`: verbatim wire value (may be `null` when only the result was seen)
- `result`: verbatim wire value, present once a result/progress landed —
  including hub truncation markers (`…[hapi: truncated N chars]…`) byte-for-byte
- `permission?`: `{ status, mode?, decision?, allowedTools?, answers?, reason? }`
  — `status`: `'pending' | 'approved' | 'denied' | 'canceled'`

### Top level

- `hasReadyEvent`: boolean (a `ready` event is consumed, never a block)
- `latestUsage`: `null` or `{ inputTokens, outputTokens, contextSize, contextWindow }`
  (`contextWindow` nullable; `contextSize` already folds cache tokens in)

### Dropped (web-presentation / advisory — not in fixtures)

Block level: `meta`, `usage` (per-block), `model`, `durationMs`, `status`
(optimistic-send state), `originalText`, `streamId`, `uuid`/`parentUUID`,
`agentTimestamp`. Tool level: `createdAt`/`startedAt`/`completedAt`/
`execStartedAt`/`execCompletedAt` (timing), `description`, `nativeTitle`,
`nativeKind`, `progress`. Permission level: `id`, `date`, `createdAt`,
`completedAt`. Attachments: `previewUrl`. Generated image: `source`.
Tool group: `defaultOpen`, `historyState`, `needsOlderHistory`,
`activityTitle`, `presentationMode`, `summary`. Top level: `latestGoal`,
`latestUsage.cacheCreation`/`cacheRead`/`model`/`timestamp`.

---

# SSE session-patch suite (`sse/`)

Pins the versioned-patch algorithm for `session-updated` events carrying a
`SessionPatch` (contract: `docs/api/client-contract/sse.md`, "Versioned patch
algorithm"). Expectations are computed by the real web fold —
`applySessionDetailPatch` in `web/src/lib/sessionPatch.ts`.

## Document schema (`fixtureVersion: 1`)

```jsonc
{
    "fixtureVersion": 1,
    "name": "metadata-newer-version-applied",   // equals the file name
    "description": "…",
    "initialSession": { /* full Session as cached before the first patch */ },
    "patches": [ /* SessionPatch payloads in arrival order */ ],
    "expectedPatchResults": [ "applied" | "unchanged", … ],  // aligned with patches
    "expectedSession": { /* Session after folding all patches */ }
}
```

## Replay contract

Fold over `patches` in order:

```
next = applySessionDetailPatch(session, patch)   // your port
results[i] = next == null ? "unchanged" : "applied"
session = next ?? session
```

Compare `results` against `expectedPatchResults` and the final session
against `expectedSession` (canonical-JSON equality). `unchanged` is
normative: it means the call reported "nothing changed — keep the previous
object identity" (version-gated wrapper, sub-minute `activeAt` keep-alive,
no-op assignment). A port that applies a stale wrapper, or that treats a
keep-alive as a change, fails on the verdict even when the final session
happens to match.

Both inputs are stored **schema-normalized**: `initialSession` is the parse
output of `SessionSchema` and every patch is the parse output of the strict
`SessionPatchSchema` (zod defaults applied, e.g. `TodoItem.priority`), so
consumers decode the JSON verbatim — no schema re-run needed. The generator
validates every authored patch against the wire schema, and the web
self-check re-validates on every test run, so fixtures cannot drift from
`shared/src/schemas.ts`.

Behavior deliberately pinned (see the individual descriptions):

- versioned wrappers (`metadata`/`agentState`/`todos`/`teamState`) apply only
  when `version` is **strictly greater** than the cached watermark; equal and
  older versions are dropped regardless of value; absent `todosUpdatedAt`/
  `teamStateUpdatedAt` watermarks count as 0
- `teamState` wrapper with `value: null` clears the field (absent in
  `expectedSession`) and still stores the watermark
- `updatedAt` is max-monotonic; an older `updatedAt` alone is `unchanged`
- flat fields are last-write-wins; a `serviceTier` key explicitly present as
  `null` clears it
- `activeTurnStartedAt` is **not applied** by the patch path (web behavior:
  no assignment branch) — a patch carrying only it is `unchanged`
- a patch whose only effective change is an `activeAt` delta < 60s is
  `unchanged` and the cached `activeAt` does **not** move
- `scratchlistUpdatedAt` is a refetch trigger only: `unchanged`, no session
  mutation

---

# Pagination suite (`pagination/`)

Pins the message-window store: paging requests it must issue, epoch-reset
handling, optimistic-send reconciliation, queued-row lifecycle, and window
trimming (contract: `docs/api/client-contract/pagination.md`). Expectations
are recorded from the real web store (`web/src/lib/message-window-store.ts`)
driven by a scripted ApiClient.

## Document schema (`fixtureVersion: 1`)

```jsonc
{
    "fixtureVersion": 1,
    "name": "older-page-epoch-mismatch-resets",   // equals the file name
    "description": "…",
    "ops": [ /* operation script, in order; see below */ ],
    "expectedState": { /* final window projection, see below */ }
}
```

## Operations

Replay each op strictly sequentially against your ported store. Ops that hit
the server carry `responses` — the scripted `GET /messages` replies, consumed
FIFO — and the machine-recorded `expectedRequests`: the exact query objects
the web store sent (`limit` only for a latest page; `beforeAt`+`beforeSeq`+
`limit` for older pages; `afterAt`+`afterSeq`+`untilAt`+`untilSeq`+`epoch`+
`limit` for tail catch-up, where `untilAt`/`untilSeq` are `null` on the first
loop request). Your port must issue the same requests in the same order and
consume every scripted response.

| `op` | Store operation (web name) | Notes |
|------|----------------------------|-------|
| `sync-tail` | `syncTailMessages` | Full tail sync; latest page when no usable cursor, else the after-cursor loop. |
| `fetch-older` | `fetchOlderMessages` | One older page. `expectedOutcome` is `{kind:'applied', hasMore, addedRenderableCount}` or `{kind:'stopped', reason}`. On an epoch mismatch the store runs an internal tail sync — its request/response belong to this same op and the outcome is `stopped`/`epoch-reset`. |
| `sse-messages` | `ingestIncomingMessages` | SSE `message-received` delivery (also advances the newest cursor when an epoch is cached — even past rows the pipeline hides). |
| `append-optimistic` | `appendOptimisticMessage` | Local optimistic row (`id === localId`). Does **not** advance the newest cursor. |
| `update-status` | `updateMessageStatus` | Client send-state transition by `localId`. |
| `messages-consumed` | `markMessagesConsumed` | SSE event: stamp `invokedAt`, flip status to `sent` (skip `failed`), re-sort by position; never advances the newest cursor. |
| `message-cancelled` | `removeOptimisticMessage` | SSE event / optimistic DELETE removal; matches `localId` **or** `id`; idempotent. |
| `cancel-invoked` | remove + append | DELETE answered `{"status":"invoked"}`: remove by `localId`, then ingest the returned `message` with client status `sent` (the harness adds the status). |
| `set-view-mode` | `setMessageViewMode` | `tail` re-entry trims to the visible window and, after a history overflow, forces a latest reset. |
| `queued-state` | reconcile round trip | Collect candidates (user rows with `invokedAt === null`, pinned in `expectedCandidates`, window order), apply `invoked` entries like `messages-consumed`, then drop candidates in neither `queuedLocalIds` nor `invoked`. |

## `expectedState` projection (normative)

```jsonc
{
    "messages": [ { "id", "localId", "seq", "createdAt",
                    "invokedAt"?,     // wire tri-state: absent / null / number
                    "scheduledAt"?,   // wire tri-state
                    "status"?,        // client send state when present
                    "queued": bool,   // user row ∧ invokedAt === null ∧ status ≠ 'failed'
                    "optimistic": bool } ],   // localId ∧ id === localId
    "hasMore": bool,                  // older history exists (server flag ∨ trim)
    "epoch": number | null,
    "viewMode": "tail" | "history",
    "olderCursor": { "at", "seq" } | null,   // next before-request position
    "newestCursor": { "at", "seq" } | null   // next after-request position
}
```

`messages` order is normative (position order: `at = invokedAt ?? createdAt`,
ties by `seq`). The cursors are the store's compound paging positions (web
internals `oldestPosition*` / `newestPosition*`); everything else that is
web-internal (render/version counters, notification throttling, persistence)
is intentionally NOT part of the contract.

Determinism notes: the web store's only wall-clock reads gate notification
throttling and never touch this projection, so no time injection is needed —
replays are exact. Fixtures keep every position pair distinct (no `(at, seq)`
ties), so the web's id tie-break (`localeCompare`) never decides an order;
native ports should still break full ties with an ASCII id comparison.

---

# Catalogs

`catalogs/` holds reference tables generated from `shared/src` modules (not
from the chat pipeline) by the same generator, with the same canonical
serialization and drift gate. Never edit them by hand.

- **`catalogs/modes.json`** — generated from `shared/src/modes.ts`
  (`web/scripts/fixtures/modesCatalog.ts` imports the module directly, like
  the chat pipeline):
  - `permissionModesByFlavor`: for every `AGENT_FLAVORS` entry, the permission
    modes offered for that flavor **in offer order**, each as
    `{ mode, label, tone }` (`tone`: `'neutral' | 'info' | 'warning' |
    'danger'`). An empty array means the flavor exposes no runtime permission
    switching (e.g. `pi`).
  - `codexCollaborationModes`: the codex-only collaboration axis as
    `{ mode, label }` pairs.

  Natives port this table (mode ids, order, labels, tones) and should compare
  their port against the file in tests the same way as the chat fixtures:
  canonical-JSON equality.

---

# Regeneration & drift gate

```bash
bun run gen:fixtures        # from the repo root (runs web/scripts/generate-fixtures.ts)
```

Output is byte-deterministic (canonical serialization), so `git status` after
a regeneration is the drift signal: when `web/src/chat/**`,
`web/src/lib/sessionPatch.ts`, `web/src/lib/message-window-store.ts` or
`web/src/lib/messages.ts` change behavior, regenerated fixtures differ, the
diff gets committed, and the native conformance suites go red until the ports
catch up. The web-side self-checks (all in `bun run test:web`) re-run every
stored input against the live implementation and fail on any divergence from
the stored expectations or from canonical serialization:

- `web/src/chat/fixtures.test.ts` — chat suite (also rebuilds
  `catalogs/modes.json` from `shared/src/modes.ts` and compares)
- `web/src/lib/sessionPatch.fixtures.test.ts` — sse suite
- `web/src/lib/message-window-store.fixtures.test.ts` — pagination suite
