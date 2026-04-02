# Codex Subagent Clickable Card Design

## Summary

Add a **Codex-first clickable subagent card/dialog UI** on top of the existing in-session nesting pipeline.

Scope:
- keep single parent session
- no child session model
- no SessionList tree
- no standalone route/page
- no provider-wide redesign

Goal:
- when `CodexSpawnAgent` has nested child blocks, show a **subagent preview card** instead of dumping those child blocks inline under the main chat flow
- clicking that card opens a dialog with the nested child transcript
- preserve existing `block.children` data model

This is a UI follow-up to the already completed data-path work:
- `docs/superpowers/specs/2026-04-02-codex-subagent-nesting-design.md`
- `docs/superpowers/plans/2026-04-02-codex-block-and-subagent-nesting-implementation.md`

## Problem

Current behavior after the recent Codex work:
- parent replay can attach child transcript events
- web normalization preserves sidechain metadata
- reducer groups child messages into `CodexSpawnAgent.children`

But rendering still uses the generic nested-block path:
- `ToolMessage.tsx`
- `HappyNestedBlockList`

So child content is rendered as a plain indented block list.

This is better than flat root duplication, but it still does **not** feel like a dedicated subagent interaction.

The user expectation is closer to co-Code:
- visible subagent frame/card under the spawn tool
- clear subagent identity / prompt summary / message count
- click to inspect the child dialog transcript

## Evidence

### Data path already exists
Files now in place:
- `cli/src/codex/utils/codexSessionScanner.ts`
- `cli/src/codex/utils/codexEventConverter.ts`
- `web/src/chat/normalizeAgent.ts`
- `web/src/chat/normalizeUser.ts`
- `web/src/chat/reducer.ts`

Key fact:
- child transcript blocks already land in `CodexSpawnAgent.children`

So the missing piece is mostly presentation.

### Current UI path is generic
File:
- `web/src/components/AssistantChat/messages/ToolMessage.tsx`

Current behavior:
- any non-`Task` tool with children renders
  - `div.mt-2.pl-3`
  - `HappyNestedBlockList blocks={block.children}`

There is no `CodexSpawnAgent` special-case renderer.

## Goals

### Functional goals
- Detect `CodexSpawnAgent` blocks with nested children
- Render a dedicated subagent summary card below the spawn tool card
- Open a dialog/sheet/popover containing the nested child transcript
- Keep nested child blocks **out of the default always-open inline view**
- Preserve current root timeline and tool block ordering

### UX goals
- visually obvious: “this spawn produced a child agent conversation”
- compact in main timeline
- easy to inspect details on demand
- child transcript should still render with the existing block renderers once opened

### Success criteria
For a `CodexSpawnAgent` block with children:
- main timeline shows a dedicated clickable subagent card
- card shows useful summary:
  - nickname/agent id when available
  - delegated prompt preview when available
  - child block count
- clicking card opens a dialog with the nested child transcript
- child blocks no longer render fully expanded inline by default

## Non-goals

Out of scope:
- child session route/page
- back button / parent-child session navigation
- changing Claude behavior
- rebuilding `ToolCard` architecture from scratch
- changing reducer grouping semantics unless needed for UI ergonomics

## Recommended approach

### Option A — ToolMessage special-case (recommended)
Add a `CodexSpawnAgent`-specific child renderer at the chat-message layer.

Pattern:
- keep `ToolCard` as-is for the tool itself
- if `block.tool.name === 'CodexSpawnAgent' && block.children.length > 0`
  - render a new `CodexSubagentPreviewCard`
  - dialog body renders `HappyNestedBlockList` over `block.children`

Pros:
- minimal blast radius
- reuses existing nested block renderer
- no schema or reducer redesign
- easiest to ship and verify

Cons:
- special-case lives in view layer
- summary extraction logic needs a small helper

### Option B — ToolCard internal special-case
Push preview/dialog logic into `ToolCard`.

Pros:
- all tool-specific UX concentrated in ToolCard

Cons:
- `ToolCard` becomes responsible for rendering child transcript content
- harder to keep child-dialog-only logic separate from generic tool UI

### Option C — new block kind for subagent preview
Add a new reducer-emitted `subagent-preview` block kind.

Pros:
- explicit model

Cons:
- larger reducer/type churn
- unnecessary because `block.children` already exists

## Scope decision

Use **Option A**.

## Proposed design

### 1. Add a Codex subagent preview component

New component candidates:
- `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.tsx`

Props:
- `block: ToolCallBlock`
- `metadata`
- `api`
- `sessionId`
- `disabled`
- `onDone`

Responsibilities:
- show compact clickable card
- show summary metadata
- host dialog with nested transcript

### 2. Summary extraction

Use existing `CodexSpawnAgent` tool input/result and child blocks.

Summary candidates:
- title: `Subagent conversation`
- subtitle pieces:
  - nickname from tool result
  - `agent_id`
  - prompt preview from spawn input `message`
  - child block count

Need only lightweight heuristics.

### 3. Main timeline rendering rule

In `ToolMessage.tsx` and `HappyNestedBlockList`:
- existing `Task` behavior unchanged
- new branch:
  - if block is `CodexSpawnAgent` and has children
  - render `CodexSubagentPreviewCard`
  - do **not** also inline-expand `block.children`
- for all other tools:
  - keep current nested rendering

### 4. Dialog body rendering

Dialog body should reuse existing nested renderer:
- `HappyNestedBlockList blocks={block.children}`

This keeps:
- child user messages
- child agent text
- child tool cards
- child agent events

### 5. Test strategy

#### Unit / component tests
Files:
- `web/src/chat/reducer.test.ts`
- `web/src/components/AssistantChat/messages/ToolMessage.test.tsx` or dedicated preview test file

Need assertions for:
- `CodexSpawnAgent` with children renders preview CTA/card text
- child prompt/answer not rendered inline by default in main collapsed view
- opening dialog shows nested child content
- non-`CodexSpawnAgent` tools keep existing child rendering behavior

#### Manual validation
Use real Codex parent session already known to contain child transcript replay:
- parent: `019d4c91-685a-7843-8056-c8cd69087727`

Verify in dev web:
- `CodexSpawnAgent` card visible
- click opens child transcript
- root timeline no longer visually floods with child transcript by default

## Risks

### Risk 1 — duplicate rendering
If the preview card is added without suppressing default inline children, child transcript appears twice.

Mitigation:
- centralize `CodexSpawnAgent` special-case in one helper branch in `ToolMessage.tsx`

### Risk 2 — poor summary text
Spawn input/result may not always contain nickname/model/message.

Mitigation:
- graceful fallbacks
- summary can degrade to child count only

### Risk 3 — inconsistent behavior between top-level and nested lists
Both `HappyToolMessage` and `HappyNestedBlockList` render tool blocks.

Mitigation:
- extract a shared `renderToolChildren` helper or shared component path

## Final decision

Implement a **CodexSpawnAgent clickable preview card + dialog** in the web message layer, reusing existing `block.children` data and nested block renderers, without introducing child sessions or new routes.
