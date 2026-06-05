# FEATURE PEER — you own this session end-to-end

**Operator:** Continue only in this HAPI session. Orchestrator Cursor chat is not the implementation lane.

---

## Parent

- Orchestrator Cursor: `a890acd1-8251-482c-87a6-7d2cb6e47b84`
- Operator replacement session (PR watcher): `1bcef191-6ba7-4951-8b2f-978693fc0966`
- Trigger repro session (archived, do not revive): `29f35bbf-2b1e-4eee-918e-52419aea71c2`

## Operator request (verbatim)

> properly this time, create a peer agent to file the issue and cleanly create the fix

Context: orchestrator previously implemented without `@spawn-peer-agents`. Operator wants upstream issue + clean fix via **this peer only**.

---

## Intake status (orchestrator DONE — do not redo)

- [x] **1 Code search** — `web/src/hooks/useSSE.ts` global early-return skips `markMessagesConsumed`; `web/src/lib/messages.ts` `mergeMessages`; `router.tsx` `resolveSessionId` + `resumeSession` before send; `hub` `requireActive` → 409 inactive
- [x] **2 Upstream search** — [#758](https://github.com/tiann/hapi/issues/758) filed (queued bar); [#744](https://github.com/tiann/hapi/issues/744) closed / [#745](https://github.com/tiann/hapi/pull/745) merged (different: resume id before init when `--resume` was used)
- [x] **3 Playback** — operator confirmed queued UI desync + separate 409 on never-started archived session (`29f35bbf`, zero messages, `POST /resume` 409)
- [x] **4 Issue** — #758 exists; **second issue YOU must file** (see Track B)
- [x] **5 Demo topology** — **soup** — manifest layer `fix/global-sse-messages-consumed` in `~/.config/hapi/driver-manifest.yaml` (orchestrator added; you run `hapi-sync-fork-main` if rebuild blocks)

## Your assignment (feature peer)

| Track | Own | Do NOT redo |
|-------|-----|-------------|
| **A — #758 queued bar** | §6 gates, `hapi-driver-rebuild --build-web --verify`, upstream PR, link Fixes #758 | Root cause; commit `760d7a8` on branch `fix/global-sse-messages-consumed` |
| **B — never-started inactive send** | File `tiann/hapi` issue with repro; implement fix + tests; second commit on same branch OR stacked branch + second PR (prefer one PR if tightly related web UX) | #744 scope (resume id after `--resume` spawn) |

### Track A (#758) — already implemented

- Global SSE: call `markMessagesConsumed` / `removeOptimisticMessage` before early return
- `mergeMessages`: preserve `invokedAt` when incoming has `null`
- Test: `web/src/lib/messages.test.ts`
- Run: `cd web && npm test -- --run src/lib/messages.test.ts src/hooks/useSSE.test.ts`

### Track B (new issue) — you file + fix

**Problem:** Session archived with **no user messages** and **no `cursorSessionId`** (runner never spawned agent). Web shows "Sending will resume automatically" but `resolveSessionId` → `resumeSession` → **409** `resume_unavailable`. No `POST /messages`; draft never saved. Repro: `29f35bbf` journal — only `POST /resume` 409, message count 0.

**Suggested fix direction (pick minimal correct):**

1. If inactive + no resume target → **skip resume**, start runner on first send (or clear banner + actionable error).
2. Do not claim auto-resume when `cursorSessionId` absent and session never had a turn.
3. Tests for `useSendMessage` / resume guard.

**Out of scope:** Re-opening `29f35bbf`; hub DB patches; `hapi-driver` hand-edits.

### Gates (mandatory before operator dogfood)

- `bun typecheck` (repo root)
- `cd web && npm test` (at least affected files)
- Cold review your diff vs `upstream/main`
- `hapi-driver-rebuild --build-web --verify` after manifest layer
- Operator dogfood: queue while busy → bar clears on `Collected batch`; inactive never-started → first send works or clear error

### PR rules

- Branch from `upstream/main` product code only
- No `docs/operator/`, `docs/plans/`, root `AGENTS.md` in PR diff
- Link #758; link new issue for Track B
- Push to `heavygee/hapi` or fork remote per `github-identity-management`; `gh pr create` → `tiann/hapi`

### Read first

- `~/coding/skills/spawn-peer-agents/SKILL.md`
- `docs/operator/AGENTS.md`
- `docs/tooling/new-feature-intake.md`

---

## Worktree

`~/coding/hapi-queued-sse-fix` @ `fix/global-sse-messages-consumed`

---

## Do not

- Implement in `~/coding/hapi-driver`
- Re-litigate orchestrator mistakes in chat — ship
