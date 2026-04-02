# Codex Subagent Dialog Polish Design

## Summary

Polish the new Codex lifecycle/subagent UI so it feels user-facing rather than debug-facing.

This is a narrow follow-up to:
- clickable subagent preview dialog
- lifecycle block aggregation

Scope:
- Codex only
- web only
- no data-model rewrite

## Problems

### 1. Wait block feels redundant
After lifecycle aggregation, the main lifecycle card already communicates waiting/completed state.
Showing a second details-heavy wait surface is unnecessary.

### 2. Delegated prompt appears twice
The dialog currently shows:
- a summary/prompt section at the top
- then the child transcript starts with the same delegated prompt

That duplication feels clumsy.

### 3. Child transcript rendering is weaker than main chat
Subagent transcript currently renders some content as plain text instead of using the richer Markdown path used in the main chat.

### 4. Dialog lacks an explicit close/return affordance
Relying on overlay/escape/default affordances is not enough.

## Goals

- keep one clear lifecycle card in the parent timeline
- simplify dialog surface
- remove duplicated delegated prompt
- make child agent text render like normal chat
- add explicit close button

## Non-goals

- no new reducer changes unless required for dedupe heuristics
- no child session routes
- no provider parity work

## Proposed changes

### A. Wait block downgrade
For matched Codex lifecycle controls:
- continue folding `CodexWaitAgent` into lifecycle state
- do not expose a separate clickable/details block in the main timeline
- rely on lifecycle card status + latest update instead

This is already mostly true after lifecycle aggregation; polish just ensures no parallel details surface competes with the lifecycle card.

### B. Prompt dedupe in dialog
Use a simple heuristic:
- if dialog summary prompt exists
- and first child transcript block is a `user-text`
- and normalized text matches or one contains the other after trim
- hide that first child prompt block inside the dialog transcript view

This keeps the summary prompt once, not twice.

### C. Child transcript rendering parity
In the dialog transcript renderer:
- `agent-text` should use `MarkdownRenderer`
- `agent-reasoning` can remain visually quieter, but still preserve formatting cleanly
- keep existing user bubble / tool card rendering

### D. Explicit close button
Add a footer/button inside the dialog:
- label: `Close`
- closes the dialog directly

Optional extra copy:
- `Back to conversation`

Prefer simple `Close`.

## Success criteria

- no obvious duplicate delegated prompt in dialog
- child agent response supports Markdown rendering
- explicit close button exists
- lifecycle card remains the single primary entry point

## Final decision

Implement a small web-only polish batch in `CodexSubagentPreviewCard.tsx` and its tests, keeping lifecycle aggregation as-is.
