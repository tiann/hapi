# Peer C briefing - preserve cursorSessionId on crash-archive

**Branch:** `fix/preserve-cursor-session-id-on-crash`
**Worktree:** `~/coding/hapi/worktrees/preserve-cursor-session-id/`
**Base:** `upstream/main` @ `66ba312`
**Demo topology:** clean

---

## Parent

- Orchestrator session: `24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1` (Cursor uuid `6904d349-f576-489f-bcd7-972f37f3942a`)
- Operator request: ensure no archive path silently strips the protocol metadata needed to resume a crashed cursor session

## Intake status (orchestrator completed)

- [x] **1 Code search:** verified via DB audit that some archived sessions on the operator's machine had `cursorSessionId` set in metadata, others did not. Two of today's incident sessions (5806aa57, 74216b80) required manual sqlite patching to restore `cursorSessionId` before resume worked. The clearing path has not been pinpointed yet - **your first code-search task** is to map every site that calls `updateSessionMetadata` / sets `archiveReason` / writes to `sessions.metadata` and identify which one(s) drop `cursorSessionId`.
- [x] **2 Upstream search:** `gh issue list --repo tiann/hapi --search 'cursorSessionId archive metadata cleared'` → empty.
- [x] **3 Playback:** operator confirmed 2026-06-06 18:51 BST
- [ ] **4 Issue:** **YOU FILE THIS FIRST** - see "Step 1" below; note that scope confirmation requires the Step 2 code-search outcome
- [ ] **5 Demo topology:** clean

## Your assignment

**Own:** code-search to locate the offending archive path → file upstream issue (cite the exact site) → fix → regression test → fork-stage cold-review PR → upstream PR → babysit.

This PR is SMALLER scope than Peer A and Peer B; it's a metadata-preservation bug fix with a single-line or few-line patch. The work is mostly in the code-search + test design, not the fix itself.

---

## The bug

On 2026-06-06 the operator hit two sessions that were marked `lifecycleState=archived` with `archiveReason='Session crashed'` (or similar). Recovering them required directly patching `metadata.cursorSessionId` back in via sqlite, then setting `metadata.cursorSessionProtocol='stream-json'`, then POSTing `/resume`. The patch was needed because the metadata that the hub had written when archiving did not include `cursorSessionId` even though the underlying Cursor chat was still intact on disk.

If `cursorSessionId` is correctly preserved on archive, Peer B's `POST /sessions/:id/reopen` works for these sessions out of the box. Today, Peer B has to return 422 for them and ask the operator to do disk-side discovery.

## Where to start the code search

```bash
cd ~/coding/hapi/worktrees/preserve-cursor-session-id
# find every site that touches session metadata in the archive path
rg -nE 'archive(Session|d)|setArchive|lifecycleState\s*=\s*.archived.|archiveReason' hub/src cli/src shared/src 2>/dev/null
# find every site that writes cursorSessionId
rg -nE 'cursorSessionId\s*[:=]|setCursorSessionId|onSessionFoundWithProtocol' hub/src cli/src shared/src 2>/dev/null
# look at the lifecycle/state machine
rg -nE 'lifecycleState.*archived|archivedSession|archiveSession' hub/src/engine 2>/dev/null
```

Likely suspects:

- `hub/src/engine/sessionLifecycle.ts` / `sessionModel.ts` / similar
- `cli/src/cursor/runCursor.ts` or `loop.ts` (cli side; reports session state to hub on crash)
- `cli/src/agent/sessionBase.ts` (generic session base; reports to hub via sync)

Investigate the metadata-write paths in order of likelihood:

1. **CLI crash path:** when cursor-agent exits unexpectedly, what does the cli write to hub before terminating? Does it call something like `setSessionState('archived', reason)` that REPLACES the entire metadata vs MERGING?
2. **Hub archive route:** `app.post('/sessions/:id/archive')` (line 255 of `sessions.ts`) - does it patch or overwrite?
3. **Sync engine:** `engine.applyMetadataPatch` vs `engine.replaceMetadata` etc.

The likely bug: somewhere in the archive flow, a partial `Metadata` object is constructed (with `lifecycleState`, `archivedAt`, `archivedBy`, `archiveReason`) and then `set` rather than `merge`d into the session's metadata - clobbering `cursorSessionId`, `cursorSessionProtocol`, and other flavor-specific fields.

When you find the offending site: capture the exact file:line, the patch shape, and the suggested fix, then proceed to file the issue.

---

## Step 1 — File the upstream issue (after Step 2 code-search nails down the site)

**Title:** `Cursor sessionId can be cleared from session metadata on crash-archive, blocking future resume even when chat data is on disk`

**Body file:** write to `/tmp/peer-C-issue-body.md`, then `gh issue create`. Sanitize: no operator hostnames, no `~/coding/hapi/worktrees/` paths, no `docs/plans/` references. The body should describe:

- Reproducible symptom (archive after crash → metadata missing `cursorSessionId` → resume rejected)
- Exact file:line of the offending overwrite (from your code-search)
- Why it matters (Peer B's reopen endpoint becomes lossless if this is fixed)
- Suggested patch shape (merge-not-replace, or preserve-cursor-fields-on-archive)
- Reference to the routing default in `cursorProtocol.isLegacyCursorSession` for why preserving the id is sufficient (no extra protocol metadata required)

Sample structure:

```markdown
## Summary

When a Cursor session is archived after an unexpected exit (`archiveReason='Session crashed'` or similar), `sessions.metadata.cursorSessionId` is cleared. The transcript and the on-disk Cursor chat data remain intact, but the hub has no way to route a `/resume` to the right cursor-agent session because the protocol id is gone. The fork-side `POST /sessions/:id/reopen` (companion PR) cannot help here either - it would need to do disk-side discovery to recover an id that was already in metadata seconds before.

## Root cause

`<file>:<line>` constructs a partial `Metadata` shape `{lifecycleState: 'archived', archivedAt, archivedBy, archiveReason}` and **replaces** the session's metadata with it instead of **merging**. Any flavor-specific fields (`cursorSessionId`, `cursorSessionProtocol`, `codexSessionId`, etc.) are dropped.

## Fix

Two options:

1. Change the archive write to a `mergeMetadata` shape (preserves all other fields by default)
2. Explicitly carry forward `cursorSessionId` / `cursorSessionProtocol` / other flavor ids when constructing the archive-state metadata

Option 1 is the principled fix; Option 2 is the surgical fix.

## Test

Regression test: archive a session that has `cursorSessionId='abc'`, then read metadata back - the id must still be there.

Patch ready in `heavygee/hapi#<NN>` (fork PR coming).
```

---

## Step 2 — Implement the fix

Apply whichever option (merge-not-replace or explicit carry-forward) the operator and the bot review prefer. The principled fix (merge) is usually cleaner.

If you go with merge: introduce or audit `engine.mergeSessionMetadata(sessionId, patch)` and switch the archive-write call site to use it. Verify no other call site was depending on the replacement behaviour.

## Step 3 — Tests

```bash
cd ~/coding/hapi/worktrees/preserve-cursor-session-id
bun test hub/src/engine/  # whichever file you touched
bun test hub/src/web/routes/sessions.test.ts  # ensure existing archive tests still pass
```

Regression coverage:

1. **Cursor session archive preserves `cursorSessionId`** - archive a session with `cursorSessionId='abc'`, read metadata, assert id still present
2. **Cursor session archive preserves `cursorSessionProtocol`** - same shape, different field
3. **Codex session archive preserves `codexSessionId`** - prove the fix is generic across flavors
4. **Crash-path specifically:** simulate cli reporting `archiveReason='Session crashed'` and verify metadata not clobbered
5. **Round-trip:** archive → reopen (if Peer B's endpoint exists in your worktree; otherwise `resume` directly) → session active with original metadata intact

## Step 4 — Cold-review fork PR

```bash
cd ~/coding/hapi/worktrees/preserve-cursor-session-id
git push -u origin fix/preserve-cursor-session-id-on-crash
gh pr create --repo heavygee/hapi --base main --head fix/preserve-cursor-session-id-on-crash \
    --title 'fix(hub): preserve flavor session ids in metadata across archive transitions' \
    --body-file /tmp/peer-C-fork-pr-body.md \
    --draft
```

## Step 5 — Upstream PR

```bash
hapi-pr-create \
    --title 'fix(hub): preserve flavor session ids in metadata across archive transitions' \
    --body-file /tmp/peer-C-upstream-pr-body.md
```

Body must include `Closes tiann/hapi#<issue-number>`.

## Step 6 — Babysit

Same shape. `hapi-pr-reply` for every thread. Never `gh pr comment`. Never push with unresolved threads.

## When you're done

```bash
hapi-ping-peer 24f3ec91-9ff7-44c3-94c4-8d6f2da4eaa1 "Peer C: fix/preserve-cursor-session-id-on-crash - upstream issue #<N>, fork PR #<M> cold-review-clean, upstream PR #<K> opened, all tests pass"
```

## Hooks/policy

Same as Peers A and B.

## Links

- Postmortem: `docs/plans/2026-06-06-cursor-auth-queue-drop-and-systemic-resurrection.md`
- Operator's resurrection playbook (fork-private, do not link in upstream): `docs/operator/session-resurrection.md`
- Routing default: `cli/src/cursor/utils/cursorProtocol.ts` `isLegacyCursorSession()` - confirms that preserving `cursorSessionId` (without `cursorSessionProtocol`) is sufficient for legacy routing to work
- Procedure: `docs/operator/repo-layout-and-dev-flow.md`, `docs/tooling/pr-review-loop.md`
