# Web Tool Use Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce chat noise in `web` by grouping root-level consecutive tool-use chains into expandable timeline cards while preserving chronological readability and complete detail access.

**Architecture:** Keep the existing raw message fetch / pagination contract unchanged in phase A. Build a new Web-only visible projection layer on top of reconciled `ChatBlock[]`: contiguous eligible root-level execution tool calls become one `ToolGroupBlock`, always collapsed by default, while interactive tool cards such as approvals and user questions remain standalone timeline items and act as hard grouping boundaries. Historical groups that start at the current oldest visible boundary are marked as incomplete and, when expanded, automatically request older pages until the group boundary is complete or history ends.

**Tech Stack:** React 19, TypeScript, assistant-ui external runtime, existing `ChatBlock` reducer pipeline, Tailwind UI, Vitest, Testing Library, project i18n dictionaries.

---

## Agreed Product Decisions

- Grouping boundary: same assistant-side contiguous root-level tool chain
- Default state: collapsed
- No auto-expand for grouped execution tools, including running / error states
- Interactive tool cards such as approval / `AskUserQuestion` / `request_user_input` stay standalone and break grouping
- Group header priority: target objects first (files, commands, touched targets), not raw tool counts first
- Expanded body: compact row list first; per row click opens detail
- History policy: grouped timeline should be retained; do not add a second-stage “keep only latest N groups” trim
- Phase A scope: do not change hub API semantics; optimize the Web visible layer first
- Incomplete historical group: auto-load older pages on expand

## File Structure

- New: `web/src/chat/toolGroups.ts` — group eligible root-level tool calls into visible `ToolGroupBlock`s; compute summary, auto-open state, and incomplete-history markers
- New: `web/src/chat/toolGroups.test.ts` — grouping boundary, eligibility, stable-id, auto-open, and incomplete-history regression tests
- New: `web/src/components/ToolCard/ToolGroupCard.tsx` — expandable grouped tool card with compact rows, inline interactive rows, and auto-hydration state
- New: `web/src/components/ToolCard/ToolGroupCard.test.tsx` — grouped card rendering / expansion / loading / interactive-row regressions
- Modify: `web/src/lib/assistant-runtime.ts` — accept grouped visible blocks and emit grouped tool artifacts to assistant-ui
- Modify: `web/src/components/AssistantChat/messages/ToolMessage.tsx` — render grouped artifact vs single tool artifact
- Modify: `web/src/components/AssistantChat/context.tsx` — expose older-history loader + has-more state to grouped tool UI
- Modify: `web/src/components/AssistantChat/HappyThread.tsx` — provide scroll-preserving older-page loader that grouped cards can reuse when expanding incomplete history
- Modify: `web/src/components/SessionChat.tsx` — project reconciled blocks into grouped visible blocks before building runtime / outline state
- Modify: `web/src/lib/locales/en.ts` — grouped tool card copy
- Modify: `web/src/lib/locales/zh-CN.ts` — grouped tool card copy

## Eligibility Rules

The grouping layer should group only **root-level, non-subagent, non-plan, non-summary** tool cards that primarily represent execution noise:

- Include: read/search/bash/edit/write/mcp-like execution tools and equivalent plain tool cards
- Exclude: subagent launch / wait / close cards, plan/update-plan cards, task/team orchestration cards, and other cards that already act as high-signal standalone milestones
- Keep single eligible tool cards standalone; only collapse runs with length `>= 2`
- Interactive rows (`pending permission`, `AskUserQuestion`, `request_user_input`) are hard boundaries: they stay standalone and are never absorbed into an execution-tool group

### Task 1: Visible grouping projection

**Files:**
- Create: `web/src/chat/toolGroups.ts`
- Test: `web/src/chat/toolGroups.test.ts`
- Modify: `web/src/components/SessionChat.tsx`

- [ ] Define `ToolGroupBlock` and `VisibleChatBlock` in `toolGroups.ts` rather than mutating the core reducer `ChatBlock` union
- [ ] Add `isEligibleForToolGrouping(block: ToolCallBlock): boolean` with the agreed exclusions (`isSubagentToolName`, plan-like cards, other milestone cards)
- [ ] Add `buildVisibleChatBlocks(blocks, options)` that scans reconciled root blocks once, groups contiguous eligible tool runs, and leaves every other block unchanged
- [ ] Use `firstToolId` as the stable UI key for normal groups and `lastToolId` as the stable UI key when the group is truncated on the older-history edge, so append and prepend flows do not constantly remount the card
- [ ] Compute `historyState` / `needsOlderHistory` only for the oldest visible grouped run when `hasMoreMessages === true`; do not mark mid-thread groups incomplete
- [ ] Set grouped execution-tool cards to collapsed-by-default with no state-based auto-open behavior
- [ ] Compute summary metadata that favors targets first: touched file paths, command previews, URL / query labels, then fallback to tool names and counts
- [ ] Wire `SessionChat` to build grouped visible blocks **after** `reconcileChatBlocks(...)` and use grouped blocks for assistant runtime rendering while keeping the existing outline source behavior unchanged for user-message anchors

### Task 2: Grouped card UI + detail access

**Files:**
- Create: `web/src/components/ToolCard/ToolGroupCard.tsx`
- Test: `web/src/components/ToolCard/ToolGroupCard.test.tsx`
- Modify: `web/src/components/AssistantChat/messages/ToolMessage.tsx`
- Modify: `web/src/lib/assistant-runtime.ts`
- Modify: `web/src/lib/locales/en.ts`
- Modify: `web/src/lib/locales/zh-CN.ts`

- [ ] Extend the assistant runtime converter so a grouped visible block becomes one assistant-ui tool message whose artifact is the full `ToolGroupBlock`
- [ ] In `ToolMessage.tsx`, branch on artifact shape: existing `ToolCallBlock` path stays untouched; new grouped artifact path renders `ToolGroupCard`
- [ ] Render the collapsed header with target-centric copy such as “3 files read”, “2 commands”, “edited `foo.ts` +2”, plus status badges for running / error / pending
- [ ] Keep the header clickable; collapsed state should not render heavy input/result payloads into the visible DOM
- [ ] Expanded state should render a compact row list first; each non-interactive row opens a dialog that reuses existing single-tool detail rendering expectations (input, trace, result)
- [ ] Ensure approval / question tool cards continue through the existing standalone rendering path and never appear inside grouped execution-tool cards
- [ ] Add i18n keys for grouped card labels: tool activity, load details, loading older details, incomplete history, more rows, row status labels, and empty fallbacks

### Task 3: Auto-load older history for incomplete groups

**Files:**
- Modify: `web/src/components/AssistantChat/context.tsx`
- Modify: `web/src/components/AssistantChat/HappyThread.tsx`
- Modify: `web/src/components/ToolCard/ToolGroupCard.tsx`
- Modify: `web/src/components/SessionChat.tsx`

- [ ] Extend `HappyChatContextValue` with the minimal grouped-history contract, e.g. `hasMoreMessages`, `loadOlderForToolGroup(anchorId)` and any loading flag needed by the card
- [ ] Reuse `HappyThread`’s existing scroll-preserving older-page loader instead of inventing a second pagination path
- [ ] Implement `loadOlderForToolGroup(anchorId)` so one expansion can loop page-by-page until the matching grouped run is no longer marked `needsOlderHistory` or `hasMoreMessages` becomes false
- [ ] Preserve user scroll anchor during auto-hydration, exactly like manual “load older” already does
- [ ] Preserve the group’s open state while older pages prepend; the stable-id strategy from Task 1 should keep React state from collapsing on every hydration step
- [ ] Surface a small inline loading affordance while older details are being hydrated; if history ends and the group is still partial, replace the loader with a terminal hint instead of retrying forever

### Task 4: Verification

**Files:**
- No additional source files beyond the tests above unless verification exposes defects

- [ ] Add regression coverage in `web/src/chat/toolGroups.test.ts` for: boundary splitting on assistant text, single-tool passthrough, exclusion of subagent / plan / interactive cards, collapsed-default behavior, target-summary extraction, and incomplete oldest-group detection
- [ ] Add UI coverage in `web/src/components/ToolCard/ToolGroupCard.test.tsx` for: collapsed target-first header, expand/collapse behavior, compact row rendering, standalone interactive-card separation, and auto-load indicator states
- [ ] If the grouped-history loader touches thread behavior, extend `web/src/components/AssistantChat/HappyThread.test.tsx` with one regression that verifies grouped expansion reuses scroll-preserving older loads
- [ ] Run: `cd web && bun run test -- src/chat/toolGroups.test.ts src/components/ToolCard/ToolGroupCard.test.tsx src/components/AssistantChat/HappyThread.test.tsx`
- [ ] Run: `cd web && bun run typecheck`
- [ ] Manual smoke in browser: long read/search/edit chain collapses into one card and stays collapsed by default; approval / question cards remain standalone; expanding an oldest historical group auto-fetches older pages and keeps scroll stable

## Notes / Non-Goals for Phase A

- Do **not** change hub `/messages` API shape, pagination cursor format, or server-side persistence in this task
- Do **not** add a second trimming rule that discards older grouped tool runs after grouping
- Do **not** refactor nested subagent child timelines in this change; keep grouping limited to root-level Web chat noise
- Do **not** create one-off temporary tests; keep only durable regression coverage that protects grouping, interaction, and history loading behavior
