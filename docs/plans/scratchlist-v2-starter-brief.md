# Scratchlist v2 starter brief

**Status:** draft - ready to seed a v2 peer agent when operator is ready to start
**Predecessor session:** `c8ee000d-34d8-4b96-b078-da6b25186a75` (archived, lifecycle=archived, name "PR798 scratchlist (resurrected)") - 2,256 messages spanning 2026-06-02 → 2026-06-07
**v1 issue:** [tiann/hapi#11](https://github.com/heavygee/hapi/issues/11) (filed in fork; upstream tracking is via PR review)
**v1.0 PR (initial):** [tiann/hapi#772](https://github.com/tiann/hapi/pull/772)
**v1.1 PR (final shape, merged to upstream):** [tiann/hapi#798](https://github.com/tiann/hapi/pull/798)
**Final v1.1 commit absorbing styling pass:** `269b4370`
**Cross-PR (collaborator):** [tiann/hapi#827](https://github.com/tiann/hapi/pull/827) (swear01's parallel restyle - dropped in favour of v1.1, with thank-you comment posted)

---

## What v1.0 + v1.1 shipped

Read first: `docs/plans/peer-handoff-scratchlist-11.md` (the original v1 handoff - intake, acceptance, implementation hints, UX notes).

Mental model that must NOT change in v2:

> Scratchlist != queue. **Queue is a conveyor belt** (auto-sends in order). **Scratchlist is a workbench** (held entries, never auto-sent, operator's notes / drafts / parking lot). The visual + interaction language must keep these distinct.

### Shipped surface (v1.0 + v1.1)

- Per-session scratchlist panel, separate from composer + queue.
- Collapsible. Click to expand. State (open/closed + entries) persists in localStorage.
- localStorage key: `hapi-scratchlist-${sessionId}` storing `[{id, text, createdAt}]`.
- localStorage key for FUE: `hapi.fue.v1.scratchlist-toggle`.
- Add / delete / reorder entries.
- Promote-to-composer (copies entry into composer for editing + sending).
- Promote-to-queue (moves entry into existing send-queue).
- Visual distinction from the queue:
  - **Final styling (post v1.1):** neutral surface tokens for inner pill + Add button (`app-chat-user-surface-bg`), amber border kept as the subtle "different destination" accent, amber-500 on Send + active toggle (the moment-of-action destination signal). NO amber fill, NO amber text, NO amber focus ring. (This is the swear01 collaboration outcome - they pushed for less amber, operator agreed it read cleaner.)
- Composer placement: scratchlist toggle icon lives below the existing composer input as a separate icon button (parity with schedule-send). Counter badge under it shows entry count.
- FUE (first-user-experience): pulsing amber dot on the notepad icon for users who have not yet engaged with the feature, dismissed via callout on first click. Click-to-dismiss only - **no auto-timeout**. Counter under the icon takes over once acknowledged.
- Keyboard shortcut: `Ctrl/Cmd + Shift + S` (or whatever was finalised - peer to verify in shipped code).
- Copy-to-clipboard icon on each scratchlist item.
- Test coverage: 728 web tests passing, 34 new (21 storage + 13 component).

### v1.1 was explicitly localStorage-only

The original handoff said "v1 only - defer hub sync to v2 if it gets hairy, localStorage is acceptable for first cut." That deferral held through v1.1.

---

## v2 scope (operator's framing)

> "the code is already in main upstream, but I want to move on to v2 after v1.1 - that context would be valuable"

Primary v2 ask: **hub sync** for scratchlist entries. The localStorage cap means scratchlists are device-local and session-local. v2 should make them follow the operator across devices.

### Suggested v2 sub-scope (peer to refine)

- **A. Hub-side persistence.** Add scratchlist entries to the session record (or a sibling table). Schema decision required: store as an opaque blob keyed by sessionId, OR as a typed table with `{sessionId, entryId, text, createdAt, updatedAt}`. Typed table wins for query / debug / cross-session-listing-someday.
- **B. Sync direction.** Read-through cache pattern: localStorage is the local truth, hub is the durability layer. On panel open, fetch hub state, merge with local; on add/delete, write local first then PATCH hub. Conflict resolution: last-write-wins is fine - this is a single-user notes panel, not a collaborative doc. Don't overengineer.
- **C. Migration of existing localStorage entries.** First time a v2-aware client opens a session that already has localStorage entries, push them up to hub and reconcile. Keep localStorage as the offline cache, not the source of truth.
- **D. SSE event for cross-device update.** When entry added/deleted/edited via REST, emit a `scratchlist-changed` SSE event so the other devices viewing the same session refresh. Consider whether this should piggyback on existing `session-updated` patch flow (in which case `SessionPatchSchema` extends to carry scratchlist count or last-updated) or be a fresh event type. Cross-reference with sibling work in flight on `tiann/hapi#885` (web client refetch storm) - whatever pattern that PR settles on for SSE-cache-write semantics, v2 should follow.
- **E. Authentication / authorization.** Scratchlist entries are operator-private notes. Hub-side route must enforce session ownership the same way other session-scoped routes do. Don't expose scratchlist contents to the namespace-shared session list.

### Things v2 should NOT do (kill criteria)

- **Do NOT make scratchlist a queue.** No auto-send. No scheduled send. The "different destination" signal in the styling exists for a reason - keep it.
- **Do NOT add cross-session scratchlists** ("global notes that show on every session"). That's a different feature. v2 is per-session, just durable.
- **Do NOT add collaborative editing.** Single-user. No CRDTs.
- **Do NOT add rich text / markdown rendering** in the panel itself. Plain text only - the operator can promote-to-composer to format. Keep the panel lightweight.
- **Do NOT add search across scratchlists.** Same reason - separate feature.
- **Do NOT change the styling.** v1.1 styling was hard-won via the swear01 collaboration. Hub sync is a backend feature; the panel UI should be byte-identical.

### Open questions for the operator (don't decide unilaterally)

1. **Schema choice (A above):** opaque blob on `sessions.metadata.scratchlist` vs new typed table. Typed table is the right answer for the long term but requires hub schema migration; blob is a faster v2.
2. **SSE event shape (D above):** piggyback on `session-updated` or new dedicated event. Depends on what `tiann/hapi#885` settles for the patch-vs-event design discussion.
3. **Migration UX (C above):** silent push-up on first open, or one-time prompt "your local scratchlist will sync to your account - ok?" The privacy-paranoid operator might prefer the prompt.
4. **Retention.** Should hub keep scratchlist entries for archived sessions? Operator's just-now behavior of trying to resume an archived session to get its workspace back suggests yes. v2 should preserve scratchlist data even when `lifecycleState=archived`.

---

## Useful predecessor receipts

- Final v1.1 PR description, merge state, and styling-pass commit `269b4370` are the canonical reference for "what v1.1 looks like today."
- Operator's iterative UX feedback is captured in user messages of session `c8ee000d` between 2026-06-04 12:50 and 13:30 (composer placement, counter sizing, FUE callout positioning).
- swear01 collaboration thread: PR #827 review comments + PR #798 cross-references at `commit 269b4370`. swear01 dropped their work in favour of v1.1 with operator's amber-border-only compromise.

---

## Spawning a v2 peer (when operator is ready)

```
- Worktree: ~/coding/hapi/worktrees/scratchlist-v2 from upstream/main as feat/scratchlist-v2
- Agent: cursor + auto + yolo (per operator's standard peer config)
- Read first: docs/operator/AGENTS.md, docs/tooling/new-feature-intake.md, this brief, docs/plans/peer-handoff-scratchlist-11.md
- Constraints: do NOT change the panel UI; v2 is a backend / sync feature. UI changes only if hub sync introduces a sync-state indicator (and even that should be minimal).
- Acceptance gates: typecheck, tests (extend existing 34 tests, add hub-sync tests), Playwright on the live panel verifying no UI regression, manual cross-device test (laptop + phone PWA) confirming entries sync.
```

---

## Why this brief exists

Operator's session `c8ee000d` was archived with a now-dangling worktree symlink (which surfaced the unrelated mkdir-EEXIST bug, separately tracked - see the in-flight peer for that fix). The session itself can't be cleanly resumed because its workspace target is gone, but the design context captured across 2,256 messages is too valuable to lose. This brief is the distilled v2-relevant subset.

A future v2 peer should treat this brief as the "what the predecessor session would have told you" and not need to read the original 2,256 messages.
