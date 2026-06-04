# Peer handoff: per-session scratchlist (issue #11)

**Issue:** https://github.com/heavygee/hapi/issues/11
**Spawn location:** new worktree at `~/coding/hapi/worktrees/scratchlist-per-session` (branch `feat/scratchlist-per-session`)
**Owner peer task:** ship the feature end-to-end, including upstream PR.

---

## Step 0 -- intake (done vs owned by you)

**Done by orchestrator before spawning you:**
- Issue filed: #11
- Mental model nailed down: scratchlist is **NOT** the queue. Queue = conveyor belt (send these in order). Scratchlist = workbench (held, not sent, operator's notes).
- Related (filed) bug: session `7d706262` -- queue items consumed but not removed. **Not your bug**; mentioned for context.

**Owned by you:**
- Web UI for the scratchlist panel (per session, collapsible, separate from composer + queue)
- Persist entries (localStorage minimum; hub-synced is nicer if cheap)
- Promote-to-composer / promote-to-queue / delete actions
- Clear visual distinction from the queue
- Tests
- Branch from `upstream/main`, push, open PR to `tiann/hapi`

---

## Acceptance (from issue #11)

- [ ] Per-session scratchlist UI (collapsed by default, expand to view)
- [ ] Add / delete / reorder entries
- [ ] Promote-to-composer copies into composer for editing + sending
- [ ] Promote-to-queue moves into the existing send-queue
- [ ] Persists across reloads
- [ ] Visual distinction from queue (different colour, label "held -- not sent")
- [ ] Test coverage for the state transitions

---

## Implementation hints

- Find the session page in `web/src/routes/sessions/` (or similar)
- Find the existing queue UI -- reuse its panel layout pattern for visual consistency, but pick a clearly different colour
- localStorage key suggestion: `hapi-scratchlist-${sessionId}` storing JSON array of `{id, text, createdAt}`
- Hub sync (if implemented): use existing user-prefs / settings endpoint pattern; otherwise defer to v2
- Promote-to-composer: emit an event the composer listens for (`setComposerText(text)`)
- Promote-to-queue: call the queue's add-item API (whatever the existing queue uses)

## UX considerations

- Reorder via drag-and-drop is nice but not required for v1; simple up/down arrows fine
- Confirm-on-delete only if the entry is non-trivial (e.g. >100 chars) -- otherwise just delete fast
- Keyboard shortcut to focus the scratchlist add-input would be nice (`Ctrl/Cmd + Shift + S` suggested -- check for conflicts)

---

## Constraints

- Branch off `upstream/main` only; don't include `docs/operator/` or `docs/plans/` in the PR diff
- No backend schema changes for v1 (localStorage-only is fine)
- Worktrees in `~/coding/hapi/worktrees/`

## When done

- Open PR to `tiann/hapi`, link issue #11
- Comment on issue #11 with the PR link
- Ping orchestrator session
