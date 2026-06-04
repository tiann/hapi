# Plan: warn live sessions before a hub restart (and how seamless reconnect lands)

**Status:** open, waiting on operator go/no-go for scope
**Filed:** 2026-06-01 22:30 BST
**Trigger:** operator noted that the patient-drain timeout would "log which sessions were still WORKING before proceeding" but live sessions/agents themselves have no advance warning of an incoming restart
**Related:**
- `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md` (DONE — runner survival across rebuilds, **not** session-side reconnect)
- `docs/plans/2026-06-01-sessions-health-null-id-tag.md` (open — health-script returns null id/tag for WORKING entries)
- Commit `212ce0e` (patient drain in `hapi-use-worktree` + `hapi-restart-hub`)

---

## Honest inventory of what already exists for hub-restart reconnect

| Surface | Already in place | Reference |
|---------|------------------|-----------|
| Web socket.io auto-reconnect | yes (`reconnectionAttempts: Infinity`, 1-5s delay) | `web/src/hooks/useTerminalSocket.ts:121-124` |
| Web SSE auto-reconnect | yes (timer + attempt counter) | `web/src/hooks/useSSE.ts:141-142` |
| Runner -> hub socket.io reconnect | yes (same lib) | runner uses socket.io |
| Web "Reconnecting..." banner | yes — reasons: `heartbeatTimeout`, `visibilityRecovery`, `closed`, `error` | `web/src/components/ReconnectingBanner.tsx` |
| Sessions + messages survive restart | yes (DB persistence) | `~/.hapi/hapi.db`, schema v10 |
| `SyncEvent` distribution infrastructure | yes — 12 event types, SSEManager + socket.io fanout | `shared/src/schemas.ts:303-366`, `hub/src/sse/sseManager.ts` |
| Runner survival across **rebuilds** (NOT restarts) | yes (DONE 2026-05-31) | `HAPI_DISABLE_VERSION_HANDOFF=1` |

**What "seamless" looks like today, end-to-end:** hub stops -> web socket drops -> web shows generic "Reconnecting..." banner -> ~5-30s later hub is back -> sockets reconnect -> session + history intact -> user resumes. The brief disconnect window flashes UI state and any mid-turn streaming tokens in the network buffer are lost, but the session itself continues.

## The gap operator is pointing at

1. **No advance warning.** Clients learn about the restart only when the socket dies. The reason shown is `closed` (or worse, `heartbeatTimeout`) — indistinguishable from a network blip. There is no eta, no "your work is safe", no "the operator did this on purpose".
2. **Mid-turn token buffer is lost.** Streaming tokens in flight (agent backend -> runner -> hub -> web) at stop time disappear. Persisted message rows survive; the UX flickers.
3. **Runner does not pause new submissions.** My patient-drain at the operator wrapper layer waits for `WORKING=0` *before* stopping the hub, but agents that start a *new* turn 5 seconds before the drain timeout will catch the restart mid-flight. The agents don't know the clock is ticking.
4. **No `system-state` SyncEvent type.** The distribution infrastructure is built; the event vocabulary just doesn't include "hub restarting" yet.

## Why the existing 2026-05-31 plan does not solve this

That plan was for the **runner** committing suicide when soup source mtimes changed during rebuild. Fix landed (`HAPI_DISABLE_VERSION_HANDOFF=1`). It keeps the runner alive through rebuilds. It does nothing for the case where the **hub** itself restarts — the runner reconnects via socket.io auto-reconnect, but with no warning and no in-flight protection.

## Proposed scope (layered, ship-in-isolation friendly)

### Layer A — Warn-broadcast (minimal viable)

**Goal:** when a wrapper begins a patient drain, all live SSE/socket.io clients see a banner: "Hub restarting in ~30s — your work is safe, will reconnect automatically."

**Approach (fork-local, no shared-schema churn):**
- `~/.hapi/restart-notice.json` written by `hapi-use-worktree` / `hapi-restart-hub` before draining: `{ "startedAt": "...Z", "etaSeconds": 600, "reason": "hapi-use-worktree", "caller": "operator" }`. Auto-cleared on wrapper exit (trap).
- New hub route: `GET /api/system/restart-notice` returns the file contents or `{ notice: null }`. Returns `notice: null` if `now > startedAt + etaSeconds` (auto-expire).
- New web component `RestartIncomingBanner` polls the route every 10s; renders above `ReconnectingBanner` when a notice is active.
- No `SyncEvent` schema change. No socket.io event. No protocol change. Pure additive endpoint + UI.

**Cost:** ~3 files, ~100-150 LOC, no shared-package churn, no runner changes.

**Limitation:** poll-every-10s for a banner that activates ~minutes per day. Trivial cost.

### Layer B — Runner pause-on-receipt

**Goal:** runner stops submitting *new* turns to its backend when a restart notice is live; in-flight turns complete within the drain window.

**Approach:**
- Runner adds a `restartNoticeWatcher` that polls the same endpoint OR (better) subscribes to the SSE channel.
- New runner state `pausing-for-hub-restart`. Existing turn completes; queued turns held; backend receives no new prompts.
- After hub restart completes (notice cleared), runner resumes.

**Cost:** state-machine surgery in `cli/src/runner/run.ts`. Medium blast radius. Worth its own peer agent.

### Layer C — In-flight token replay

**Goal:** mid-turn streaming UX does not flicker. After reconnect, the web client receives any tokens that landed in the DB between disconnect and reconnect.

**Approach:**
- Web client tracks `lastSeenMessageSeq` per session.
- On reconnect, web requests `GET /api/sessions/:id/messages?sinceSeq=N`.
- Backfills missing tokens; renders without losing context.
- (May already partially work — message catchup on `session-updated` event handling needs audit.)

**Cost:** changes to message-fetching hooks + a new query param on an existing route. Probably small but needs careful audit of the existing `useSSE` + `useTerminalSocket` paths.

## Recommended order

A (small, fork-local, immediate operator-visibility win) -> separate plan/peer for B -> separate plan/peer for C.

A alone addresses the operator's stated complaint ("agents/sessions can use being made aware that there is a logged restart request incoming") without touching the wire protocol or runner state machine.

## Out of scope

- Upstream PR for any of this until A is dogfooded for at least 2 weeks. The hub-restart-warn problem is fork-shaped (30+ agent dogfood density); upstream users on stable `@twsxtd/hapi` rarely restart their hub.
- Changing `hub.stop()` itself to wait for in-flight messages to drain. That's a separate sub-feature inside Layer A/B and would require careful auditing of all `webServer?.stop()`, `syncEngine?.stop()`, `sseManager?.stop()` shutdowns in `hub/src/startHub.ts:308-317`.

## Operator decision needed

Pick a scope and I will execute:
1. **Layer A only** — quick win, single commit, fork-local
2. **Layer A + write plan docs for B and C** — covers visibility now, queues the deeper work
3. **Write all three plans, spawn a feature peer for the whole stack** — proper new-feature-intake discipline; deserves a sibling peer agent
4. **Hold entirely** — capture the inventory only, defer until the next contention bites
