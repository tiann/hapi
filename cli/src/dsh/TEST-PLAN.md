# DSH Integration Test Plan (PR #1574)

## Goal

Verify the DeepSeek Harness integration against its correctness contracts:

1. **Event integrity** — no duplicates, no gaps (at-most-once journal)
2. **Recovery** — reconnect/restart gap-fill converges (attach → subscribed barrier → buffer → backfill → replay → live)
3. **Identity binding** — HAPI message localId ↔ native seq (fork/rewind anchors, rpcId correlation)
4. **State consistency** — dsh_state projections monotonic, per-key never regresses
5. **Security** — allowlisted typed protocol, attachment path + aggregate-size validation
6. **Durability** — root + per-child cursors persist in metadata across restarts

## Existing coverage

| File | Tests | Notes |
|---|---|---|
| `cli/src/dsh/DshClient.test.ts` | 8 | wire client happy paths |
| `cli/src/dsh/DshEventBridge.test.ts` | 5 | happy path, approvals, queue/jobs/projection folds |
| `cli/src/dsh/DshProjector.test.ts` | 11 | chunk streaming, block-end dedupe |
| `cli/src/dsh/DshRuntime.test.ts` | 4 | spawn/exit/timeout/install |
| `cli/src/dsh/DshSession.integration.test.ts` | 1 | E2E happy path |
| `shared/src/dsh.test.ts` | 6 | DshActionSchema allowlist |
| `hub/src/web/routes/dsh.test.ts` | 7 | route gating + validation |
| `hub/src/sync/conversationHistoryDsh.test.ts` | 2 | fork/rewind orchestration |
| `web` (DshSessionPanels/SubagentsModal/message-window-store) | ~12 | UI folds |

**Gap**: recovery paths (reconnect, backfill failure, races, restart) and
identity binding are untested — exactly what the review bots keep flagging.

## Test matrix

### P0 — DshEventBridge recovery state machine (fixture-host unit)

| ID | Scenario | Assert |
|---|---|---|
| A1 | First generation: subscribed → backfill (history returns events) → projected + cursor | gap-free, ordered |
| A2 | Live root events arriving during initial backfill → buffered → replayed | seq-sorted, no dupes |
| A3 | Backfill fails → generation aborts → retry succeeds | events arrive, buffer sealed during failure |
| A4 | Host stream closes before subscription → attached=false → reconnect | no hang, recovers |
| A5 | Streams close → reconnect → gap-fill anchored at lastForwardedSeq | no dupes, no gaps |
| A6 | Live root events arriving before reconnect backfill → buffered | no loss |
| A7 | Child events record per-child cursor + onChildCursor callback | cursor exact |
| A8 | Unknown child events during root backfill → dynamic seal → subagent.list discovery → backfill → release | no loss |
| A9 | Child backfill fails → abort → next generation retries → releases | buffer preserved, cursor unadvanced |
| A10 | Live child events during child replay → buffered → replayed | no dupes |
| A11 | Low-seq bootstrap projection never overwrites newer live frame | per-key guard |
| A12 | emitState low-seq patch never regresses overall seq | monotonic |
| A13 | question/resolved emits questions=null | no empty dialog |
| A14 | Reconnect resets projectionsSeeded → re-bootstrap | state restored |

### P0 — Prompt identity binding (fixture E2E)

| ID | Scenario | Assert |
|---|---|---|
| E1 | Queue prompt → user/message with source.rpcId → localId bound | fork anchor correct |
| E2 | Mux user/message beats the prompt HTTP response | still bound (pre-registered rpcId) |
| E3 | Rejected prompt → binding cleaned | no pollution of later prompts |
| E4 | session-ready emitted only after bridge ready | queued prompt cannot corrupt anchors |
| E5 | Intervening unary RPC between reservation and prompt | cannot consume the rpcId (promptDirect) |

### P1 — Fork / rewind / resume (hub + cli)

| ID | Scenario | Assert |
|---|---|---|
| F1 | Fork cursor probe succeeds → nativeCursor = tail seq | child cursor correct |
| F2 | Probe fails → fallback atSeq / live seq | no prefix replay |
| F3 | Rewind archive CAS fails → cleanupFailedForkChild called | no orphan child |
| F4 | Fork childMetadata.dshEventCursor = nativeCursor | persisted |
| G1 | resolveAgentResumeId resolves dshSessionId | resume dispatches runDsh |

### P1 — Cursor durability

| ID | Scenario | Assert |
|---|---|---|
| H1 | flushCursor writes dshChildCursors (merged, not overwritten) | metadata correct |
| H2 | Child-only activity arms the throttle | persists without root events |
| H3 | sessionFactory preserves dshChildCursors | restart recovery |

### P2 — Runtime / security / web

| ID | Scenario | Assert |
|---|---|---|
| D1 | readDshRuntimeVersion reads dsh package manifest (2 parents) | correct version |
| D2 | Explicit override + missing → spawn error (no auto-install) | fails loud |
| I1 | DshActionSchema rejects prompt / model.select / fork | allowlist |
| I2 | Attachment validation uses HAPI row id (fork child native id differs) | images accepted |
| J1 | Window trim excludes dsh_native; keeps only newest dsh_state | 400 budget intact |
| J2 | Reasoning-effort mutation guard allows dsh | picker works |
| K1 | Usage events forward contextWindow; contextTokens not forced to 0 | web context bar |

## Status (2026-08-16)

- **P0 A-series (11)**: ✅ all green — `DshEventBridge.recovery.test.ts`
  (also surfaced + fixed a real bug: sealed-buffer release re-buffered
  frames while journalRecoveryInFlight was active → forceForward)
- **P0 C-series (3)**: ✅ `DshClient.test.ts` (promptDirect rpcId,
  mismatch throw, reservation isolation)
- **P0 E-series (5)**: ✅ `DshPromptIdentity.test.ts` (rpcId binds localId,
  event-beats-HTTP race, rejected-prompt cleanup, no-rpcId events inert)
- **P1 F/G-series (4)**: ✅ `conversationHistoryDsh.test.ts` (child cursor
  seed, absent cursor, rewind CAS failure cleanup, resume-id resolution)
- **P1 H-series (2)**: ✅ `sessionFactory.dsh.test.ts` (DSH resume identity
  round-trips pickExistingSessionMetadata)
- **P2 D-series (3)**: ✅ `DshRuntime.test.ts` (manifest path, unreadable
  manifest, override-missing spawn error)
- Full suites: cli dsh 51 passed / hub 1106 / shared 269 / web 31

## Execution

- Level 1 (P0 unit): `cd cli && bunx vitest run src/dsh/`
- Level 2 (hub): `cd hub && bun test src/sync/conversationHistoryDsh.test.ts`
- Level 3 (web): `cd web && bunx vitest run src/lib/message-window-store.test.ts src/components/SessionChat.test.tsx`
- Level 4 (manual, test env 43006): real-host resume/restart/fork/subagent/upload sweeps

## Fixture capabilities

- [x] Configurable `session.history` responses (success/empty/events/failure)
- [x] Root `session/subscribed` frame on mux open
- [x] Disconnect mux/host sockets mid-test (reconnect trigger)
- [x] `subagent.list` + `subagent.history` default handlers
- [ ] Multi-page history (hasMore pagination) — low value; pagination is
  exercised via the anchor-reached stop condition in backfill tests
