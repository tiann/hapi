# Peer handoff: queued bar stale after CLI consume (#758)

## Parent

- Orchestrator Cursor chat: `a890acd1-8251-482c-87a6-7d2cb6e47b84` (do not continue implementation there)
- Trigger session: `9cb8c89f-d8c5-4315-88c1-3a327dce8e20` (server-setup / Organizr bazarr 502)

## Feature peer session (operator continues here)

- **URL:** https://hapi.tail9944ee.ts.net/sessions/b53dd642-5c45-493e-959f-8e1f15c8c521
- **Worktree:** `~/coding/hapi-queued-sse-fix` — also `PEER_MIGRATION.md` at repo root

## Intake status (orchestrator completed)

- [x] 1 Code search — `web/src/hooks/useSSE.ts` global early-return; `QueuedMessagesBar` + `isQueuedForInvocation`
- [x] 2 Upstream search — no prior issue; filed https://github.com/tiann/hapi/issues/758
- [x] 3 Playback — operator reported queued UI while runner had collected batch (14:59 push → 15:01:43 collect in runner log)
- [x] 4 Issue — #758
- [x] 5 Demo topology — **soup** — layer `fix/global-sse-messages-consumed` in `~/.config/hapi/driver-manifest.yaml`

## Your assignment (feature peer)

- Own: **§6 gates** (web typecheck, broader web tests if fast), **§7 operator handoff** (confirm bar clears on consume), **upstream PR** from worktree
- Do NOT redo: root-cause analysis, initial fix commit
- Worktree: `~/coding/hapi-queued-sse-fix` @ `fix/global-sse-messages-consumed` (commit `760d7a8` or later)
- Read: `docs/operator/AGENTS.md`, `docs/tooling/new-feature-intake.md`
- PR targets `tiann/hapi` `main`; no `docs/operator/` or `docs/plans/` in PR diff
- Link PR to #758 in body

## Fix summary

Global SSE (`scope: 'global'`, `all: true`) returned on `messages-consumed` without `markMessagesConsumed`. Session-scoped SSE normally applies the ack; during reconnect or another selected session, only global receives the event → floating bar stuck while DB has `invoked_at`.

## Operator dogfood

1. `hapi-driver-rebuild --build-web` (after manifest layer added)
2. Open a busy session, queue a message, watch bar clear when runner log shows `Collected batch` (not only when agent exits)
3. Optional: switch to another session in sidebar while message queues on first session; return — bar should not show consumed rows
