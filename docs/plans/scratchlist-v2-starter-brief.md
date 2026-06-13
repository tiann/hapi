# Scratchlist v2 starter brief

**Status (2026-06-13 17:41):** v2.0 SHIPPED. PR [tiann/hapi#896](https://github.com/tiann/hapi/pull/896) open against upstream (issue [#893](https://github.com/tiann/hapi/issues/893), v2.1 tracking issue [#894](https://github.com/tiann/hapi/issues/894)). Branch `heavygee:feat/scratchlist-v2`, commit `604d70df`, +2605/-11 across 24 files. All gates green (hub 456/456, web 982/982, cli 964/964, Playwright 10/10 on v1 panel fixture confirms zero UI regression). Manual cross-device test (laptop + phone PWA) deferred to operator (cannot run from agent shell). Sibling peer 7b422b92 added `todos`/`teamState`/versioned `metadata`/versioned `agentState` to the same `SessionPatchSchema` for Fix B' (#895); v2 peer added `scratchlistUpdatedAt?: number` adjacent - merges cleanly either order. CI on #896 pending at report time.

**Original status (pre-spawn):** decisions made by operator 2026-06-13; v2 peer spawning now
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

### Operator decisions (RESOLVED 2026-06-13)

These were open questions; operator has decided. Peer should treat each as canonical and not relitigate without flagging it back to orchestrator first.

#### 1. Schema choice (A above): TYPED TABLE

> Operator: "I want typed table. Eventually, this data will be visible to and referenced by the overseer as context for the operator's thoughts/plans/desires for this session - I want that readily available and have our ability to reference/link things autonomously by the overseer as they find useful. Schema should enable that future feature from jump."

Implication for peer: design a new `session_scratchlist` (or similar) table with typed columns - `{sessionId, entryId, text, createdAt, updatedAt}` minimum. Plan ahead for the "overseer will read this" use case: ensure the schema supports indexing by sessionId and timestamp queries. Index on `(sessionId, createdAt)` recommended. Don't store as opaque blob on `sessions.metadata`.

#### 2. SSE event shape (D above): PIGGYBACK on `session-updated`

> Operator: "the creation of one of these will be exceedingly rare, vs regular composer typing. follow the 80/20 on that piggyback vs not decision. is there a compelling reason to make a new event for something this rare?"

Implication for peer: extend `SessionPatchSchema` (in `shared/src/schemas.ts`, the `.strict()` zod object that today only carries `active`/`thinking`/`activeAt`/`updatedAt`/`model`/etc.) with a `scratchlistUpdatedAt?: number` (or similar minimal token). Web client's existing `session-updated` SSE handler then patches the cache on receipt. Don't invent a new event type.

This is the same direction the sibling `tiann/hapi#884` Fix B will take (extend `SessionPatchSchema` to include `todos`/`teamState`/`metadata`/`agentState`). Peer should expect that Fix B work to land in parallel - if there's a merge conflict in `SessionPatchSchema`, the v2 peer should add their `scratchlistUpdatedAt` field cleanly alongside whatever Fix B adds; either order works.

#### 3. Migration UX (C above): SILENT push-up + one-time banner

> Operator: "silent - the user has no reason to prefer localstorage, that was merely our expediency. they will have already expected this to be stored in the hub db. a banner similar to the 'upgrading your cursor sessions to acp' would be apropos."

Implication for peer: study `web/src/components/CursorMigrationBanner.tsx` (the existing ACP-upgrade banner) for the dismissal/persistence pattern. Mirror it: first time a v2-aware client encounters localStorage entries on a session, push them up to hub silently AND surface a non-blocking banner explaining what happened, with click-to-dismiss + state persistence so it doesn't reappear. Banner copy should explain (a) what's now in the hub (b) that nothing was lost (c) it now syncs across devices.

#### 4. Retention on archive vs delete: KEEP on archive, prompt-on-delete

> Operator: "yes, but deleted sessions should also delete scratchlists. If a session with scratchlist is attempted to be deleted, there should be an option given to the operator 'you still have scratchlist items in this session. would you like to migrate a summary of this session to a new session and retain your scratchlist there? or just delete' - will need some workshopping on this one, the point is, there might be value for 'future work' here, that would be ideal not to 'lose'."

Implication for peer: TWO scopes to separate.

- **v2.0 (this PR):** scratchlist persists when `lifecycleState=archived`. Resume re-reads from hub. Archive does NOT delete scratchlist data. Delete-session does cascade-delete scratchlist data. Same enforcement as other session-scoped data.

- **v2.1 (a follow-up issue, NOT this PR):** the "delete with summarize-and-migrate" UX flow. This is genuinely workshopping territory - it touches summarisation (which model? cost? cancellable?), the new-session creation flow, and operator UX. **Peer should file a separate tracking issue against `tiann/hapi` for v2.1 with a design proposal section, then move on.** Do NOT implement the prompt in v2.0. The simpler "are you sure? this will also delete N scratchlist entries" confirmation IS in scope for v2.0; the summarize-and-migrate flow is not.

The reason for the split: v2.0 is a clean-shaped feature (storage + sync + migration). v2.1 is a UX feature with hard model/cost/UX questions that need their own design pass. Trying to land both in one PR will bloat reviewer cognitive load and risk scope creep.


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
