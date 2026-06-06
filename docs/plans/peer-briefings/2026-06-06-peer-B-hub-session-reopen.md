# Peer B briefing - hub session reopen endpoint + web button

**Branch:** `feat/hub-session-reopen-endpoint`
**Worktree:** `~/coding/hapi/worktrees/hub-session-reopen/`
**Base:** `upstream/main` @ `66ba312`
**Demo topology:** clean (you only need the worktree; no fork-soup layering)

---

## Parent

- Orchestrator session: `24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1` (Cursor uuid `6904d349-f576-489f-bcd7-972f37f3942a`)
- Operator request: "no more custom surgery, every session must be one-click revivable from the web UI"

## Intake status (orchestrator completed)

- [x] **1 Code search:** no `reopen` route in `hub/src/web/routes/sessions.ts`. Archive route exists at `app.post('/sessions/:id/archive')` line 255 of that file. Existing resurrection logic lives in `scripts/tooling/hapi-resurrect-session.sh` (fork-private; do NOT reference it in upstream PR). 92 of 99 sessions on the operator's machine are currently `archived` and have no UI affordance to revive.
- [x] **2 Upstream search:** `gh issue list --repo tiann/hapi --search 'session archived crashed unarchive resume reopen'` → empty. **No prior upstream coverage; you file the issue first.**
- [x] **3 Playback:** operator confirmed on 2026-06-06 18:51 BST ("give me several textbook by the book PRs"). Earlier statement: "At MOST this should be a simple button click on the session, to unarchive that would then bring the session back into active state."
- [ ] **4 Issue:** **YOU FILE THIS FIRST** - see "Step 1" below
- [ ] **5 Demo topology:** clean

## Your assignment (feature peer)

**Own:** issue filing → hub route implementation → web UI button + dialog → tests (route + e2e or component) → fork-stage cold-review PR → upstream PR → babysit until merged.
**Do NOT redo:** worktree creation, branch creation, search.

---

## The feature

Today, a `lifecycleState=archived` session has no operator path back to it from the web UI. The session row may or may not appear under "inactive"; even if visible, clicking does nothing recoverable. The operator's transcript, metadata, and (often) `cursorSessionId` are intact in `hapi.db`, but recovering requires shell access + sqlite knowledge + understanding of the cursor-agent flavor's protocol metadata.

This PR delivers two things:

1. **`POST /api/sessions/:id/reopen`** - hub route that revives an archived session in-place
2. **"Reopen" button** on inactive session rows in the web UI

Acceptance: every row in the inactive-sessions list has a single "Reopen" button that, when clicked, transitions the session to running with full transcript intact (or fails loud with a clear error if the metadata required for resume is unrecoverable).

## The 99-session distribution justifying this (don't include in upstream issue body verbatim - it's operator-specific)

```
lifecycleState=archived: 92    archiveReason=User terminated     87  intentional
                               archiveReason=Session crashed       4  bug victims
                               archiveReason=Local launch failed   1  bug victims
                               archiveReason=NULL                   7  pre-metadata
lifecycleState=running:   6
```

68+ of 99 sessions are mechanically resurrectable from existing metadata; the operator wants the UI to expose that.

## Suggested reopen semantics

```
POST /api/sessions/:id/reopen
Authorization: Bearer <jwt>

Response 200: { sessionId: <id>, lifecycleState: 'inactive', cursorSessionProtocol?: 'stream-json' | 'acp', resumed: true }
Response 404: session not found
Response 409: session not archived (already running) — idempotent suggestion: return current state with 200 instead
Response 422: session metadata incomplete for safe reopen (e.g. flavor=cursor + no cursorSessionId + no fallback path); body must describe what's missing
```

Server-side logic (rough sketch):

```typescript
app.post('/sessions/:id/reopen', async (c) => {
    const sessionResult = requireSessionFromParam(c, engine, { requireActive: false });
    // ...
    const session = sessionResult.session;
    const meta = session.metadata as Metadata;

    // Already running? idempotent return
    if (meta.lifecycleState !== 'archived') return c.json({ sessionId, lifecycleState: meta.lifecycleState, resumed: false });

    // For cursor flavor: ensure protocol metadata is sufficient
    if (meta.flavor === 'cursor') {
        if (!meta.cursorSessionId) {
            return c.json({
                error: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                missing: ['cursorSessionId']
            }, 422);
        }
        // Default missing protocol → stream-json (legacy pre-#799 behaviour - matches isLegacyCursorSession)
        if (!meta.cursorSessionProtocol) {
            meta.cursorSessionProtocol = 'stream-json';
        }
    }

    // Restore metadata: clear archive fields, set inactive
    const patched: Metadata = {
        ...meta,
        lifecycleState: 'inactive',
        archivedAt: null,
        archivedBy: null,
        archiveReason: null
    };
    await engine.updateSessionMetadata(sessionId, patched);

    // Trigger resume (reuse existing /resume internal handler)
    const resumeResult = await engine.resumeSession(sessionId);

    return c.json({ sessionId, lifecycleState: 'inactive', cursorSessionProtocol: patched.cursorSessionProtocol, resumed: resumeResult.ok });
});
```

(Pseudocode - exact engine API names need verification when you read `hub/src/engine/` and `hub/src/web/routes/sessions.ts` lines 131-172 for the existing `/resume` handler.)

## Web UI scope

In the inactive-sessions list component (find via `rg -l 'archived|inactive.*session' web/src/components/` — likely `SessionList` / `InactiveSessionsList` / similar):

1. Add a "Reopen" button next to each archived row
2. On click → `POST /api/sessions/:id/reopen` via the existing api client (don't roll your own fetch — use `web/src/api/` helpers)
3. On 200 → optimistically transition row out of inactive list; full refresh from `GET /api/sessions` to confirm
4. On 422 → toast: "This session cannot be reopened automatically. Missing: <fields>." with a "Show details" affordance
5. On 5xx / network → toast with retry button

Component test: cover button render, click handler firing, 200/422/500 toast paths.

---

## Step 1 — File the upstream issue FIRST

**Title:** `Web UI: no affordance to reopen / unarchive a session; archived sessions with full transcript are effectively lost`

**Body file:** write to `/tmp/peer-B-issue-body.md`, then `gh issue create -R tiann/hapi --title '...' --body-file /tmp/peer-B-issue-body.md`. Suggested content (sanitize before posting; do NOT include operator-specific session counts that leak local DB state):

```markdown
## Summary

A HAPI session that enters `lifecycleState=archived` (operator termination, crash, or local launch failure) has full transcript and metadata intact in `hapi.db`, but the web UI provides no path back. The only way to revive one today is shell access + sqlite metadata patching + manual `POST /api/sessions/:id/resume`. This is a resilience gap that hits any operator who keeps sessions long enough to accumulate archived ones - especially after a crash where the operator did not deliberately end the session.

## Why the data is there but unreachable

- `messages` table is preserved on archive (verified)
- `sessions.metadata` is preserved on archive in most paths (occasional drops of `cursorSessionId` exist - separate bug, separate issue)
- `POST /api/sessions/:id/resume` (`hub/src/web/routes/sessions.ts:131`) works for archived sessions when given the right preconditions, but is never invoked by the UI for archived rows

## Proposal

1. **New route:** `POST /api/sessions/:id/reopen` that:
    - is idempotent (running session → 200 no-op)
    - clears `lifecycleState=archived`, `archivedAt`, `archivedBy`, `archiveReason`
    - for `flavor=cursor`: defaults `cursorSessionProtocol='stream-json'` when missing (preserves the pre-#799 default that `isLegacyCursorSession` already enforces in routing)
    - triggers the same internal handler `/resume` already calls
    - returns 422 with `{missing: [...]}` if metadata is unrecoverable (e.g. missing `cursorSessionId`)
2. **Web UI:** a "Reopen" button on every inactive-list row. Confirm dialog for "User terminated" archives (operator may have terminated intentionally); direct action for "Session crashed" / "Local launch failed".

## Acceptance criteria

- Every archived session is reopenable in 1 click OR shows a clear actionable error
- Reopening a Cursor pre-#799 session (no `cursorSessionProtocol` metadata) routes correctly to `cursorLegacyRemoteLauncher` (no regression vs current `isLegacyCursorSession` default)
- Reopening is idempotent
- Unit + route tests cover the four response shapes (200 idempotent, 200 reopen, 404, 422)
- Web component tests cover button render + click handler + toast paths

Patch ready in `heavygee/hapi#<NN>` (fork PR coming). Happy to open the upstream PR if maintainers prefer.
```

After filing, **capture the issue number** for `Closes #N`.

---

## Step 2 — Implement

```bash
cd ~/coding/hapi/worktrees/hub-session-reopen
git log --oneline -1     # 66ba312
git branch --show-current # feat/hub-session-reopen-endpoint
```

Files to touch:

- `hub/src/web/routes/sessions.ts` — add `POST /sessions/:id/reopen`
- `hub/src/web/routes/sessions.test.ts` — add route tests
- `hub/src/engine/*` — extend the engine API if `updateSessionMetadata` and `resumeSession` aren't already exposed in the right shape; otherwise reuse
- `shared/src/apiTypes.ts` — add `ReopenSessionResponseSchema` (response shape)
- `web/src/components/<InactiveSessionsList or similar>.tsx` — add button + click handler
- `web/src/api/sessions.ts` — add `reopenSession(sessionId)` helper
- Web component test for the button

Patterns to follow (idiomatic to this codebase):

- Hono routing with zod schemas
- Use `requireSessionFromParam(c, engine, { requireActive: false })` since archived sessions are not active
- Mirror the auth/error pattern from `/sessions/:id/resume` (line 131-172 of `sessions.ts`)

## Step 3 — Tests

```bash
cd ~/coding/hapi/worktrees/hub-session-reopen
bun test hub/src/web/routes/sessions.test.ts
bun test web/src/components/  # whichever file you added
```

Coverage:

1. Reopen archived cursor stream-json session (full metadata) → 200, resumed=true
2. Reopen archived cursor session with `cursorSessionProtocol` missing → 200, protocol defaulted to `stream-json`
3. Reopen archived session with missing `cursorSessionId` (cursor flavor) → 422, body lists `missing: ['cursorSessionId']`
4. Reopen non-archived session → 200, resumed=false (idempotent)
5. Reopen non-existent session → 404
6. Web component: button renders for archived rows, NOT for running rows; click fires reopen; 200 → row transitions; 422 → toast with missing-fields detail; 500 → toast with retry

## Step 4 — Cold-review gate (fork PR FIRST)

```bash
cd ~/coding/hapi/worktrees/hub-session-reopen
git push -u origin feat/hub-session-reopen-endpoint
gh pr create --repo heavygee/hapi --base main --head feat/hub-session-reopen-endpoint \
    --title 'feat(hub+web): POST /sessions/:id/reopen + UI button to revive archived sessions' \
    --body-file /tmp/peer-B-fork-pr-body.md \
    --draft
```

Same protocol as Peer A: wait for bot review, address findings via `hapi-pr-reply` (NEVER `gh pr comment`), operator applies `cold-review-clean` when satisfied, then close the fork PR.

## Step 5 — Upstream PR (after cold-review-clean)

```bash
hapi-pr-create \
    --title 'feat(hub+web): POST /sessions/:id/reopen + UI button to revive archived sessions' \
    --body-file /tmp/peer-B-upstream-pr-body.md
```

Body must include `Closes tiann/hapi#<issue-number>`. `hapi-pr-create` enforces it + runs leak scan.

## Step 6 — Babysit

Same shape as Peer A. Address every thread via `hapi-pr-reply`. Never push with unresolved threads.

## When you're done

```bash
hapi-ping-peer 24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1 "Peer B: feat/hub-session-reopen-endpoint - upstream issue #<N>, fork PR #<M> cold-review-clean, upstream PR #<K> opened, all tests pass"
```

## Hooks/policy

Same as Peer A: no stashes, no top-level PR comments on PRs with unresolved threads, no push with unresolved threads, canonical worktree layout, never edit `driver/` by hand.

## Links

- Postmortem: `docs/plans/2026-06-06-cursor-auth-queue-drop-and-systemic-resurrection.md`
- Operator's reference resurrection script (fork-private; cite shape only, NEVER paste path into upstream PR): `scripts/tooling/hapi-resurrect-session.sh`
- Procedure: `docs/operator/repo-layout-and-dev-flow.md`, `docs/tooling/pr-review-loop.md`
