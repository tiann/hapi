# Codex Agent Lifecycle Block Design

## Summary

Upgrade the current Codex subagent UI from a **tool-centric** view to an **agent-centric lifecycle block**.

Current state:
- `CodexSpawnAgent` renders as one tool block
- `CodexWaitAgent` renders as another tool block
- `CodexSendInput` / `CodexCloseAgent` can also appear as separate blocks
- child transcript opens through a clickable preview card

Target state:
- one Codex subagent = one primary block in the parent chat timeline
- the block keeps updating as the agent progresses
- control steps like wait/send/close no longer clutter the root timeline as separate blocks when they belong to the same agent
- click opens the child transcript and final details

Scope:
- Codex only
- in-session only
- no child session/page
- no new route

## Problem

The current UI is still too close to raw tools.

That creates two UX problems:
1. users see multiple blocks for one logical subagent run
2. result displays often feel technical / JSON-shaped instead of task-shaped

Even after clickable preview work, the parent timeline can still look like:
- Spawn agent
- Wait for agent
- Send input
- Close agent

This is accurate for debugging, but not ideal for end users.

## Goal

Represent a Codex subagent run like a long-running execution block:
- created
- running
- waiting
- completed / errored
- expandable for details

## Non-goals

Out of scope:
- child session model
- session tree
- Claude parity
- replacing all raw tool detail UIs
- changing scanner/converter protocol again

## Recommended approach

### Option A — lifecycle aggregation at reducer level (recommended)
Keep raw messages as-is, but aggregate related Codex control tool blocks into the parent spawn block during block reduction.

Effects:
- spawn block becomes lifecycle owner
- matched wait/send/close blocks disappear from root timeline
- lifecycle state is attached to the spawn block
- existing child transcript nesting remains attached to the same block

Pros:
- true “one agent one block” effect in timeline
- minimal CLI changes
- preserves raw transcript semantics underneath

Cons:
- reducer gets provider-specific aggregation logic

### Option B — presentation-only hiding
Leave all blocks in reducer output, but hide wait/send/close blocks in rendering.

Pros:
- smaller change

Cons:
- awkward hidden-state bookkeeping
- duplicated data still exists in root timeline
- harder to reason about ordering and updates

## Scope decision

Use **Option A**.

## Proposed design

### 1. Introduce Codex lifecycle metadata on `ToolCallBlock`

Add optional metadata for Codex subagent lifecycle state.

Suggested shape:
- `kind: 'codex-agent-lifecycle'`
- `agentId?: string`
- `nickname?: string`
- `status: 'running' | 'waiting' | 'completed' | 'error' | 'closed'`
- `latestText?: string`
- `actions: Array<{ type: 'wait' | 'send' | 'close'; createdAt: number; summary: string }>`
- `hiddenToolIds: string[]`

This metadata attaches to the owning `CodexSpawnAgent` block.

### 2. Aggregate related control blocks into the spawn block

Reducer pass after normal block creation:
- find `CodexSpawnAgent` blocks with `agent_id` in tool result
- map `agent_id -> spawn block`
- match later tool blocks:
  - `CodexWaitAgent` by `input.targets[]`
  - `CodexSendInput` by `input.target`
  - `CodexCloseAgent` by `input.target`
- update lifecycle metadata on the matching spawn block
- remove matched control blocks from root timeline

### 3. Lifecycle status rules

Default after spawn:
- `running`

Wait result rules:
- status map says running/in_progress -> `waiting`
- status map says completed -> `completed`
- status map says failed/error -> `error`
- completed text becomes `latestText`

Send input rules:
- append action summary
- lifecycle stays `running`/`waiting`

Close rules:
- append action summary
- if no stronger completed/error state, can become `closed`

### 4. Replace spawn tool card with lifecycle card in chat view

For a `CodexSpawnAgent` block with lifecycle metadata:
- render the lifecycle card as the main visible block
- do not separately render a generic `ToolCard` for that same spawn block in the main timeline
- clicking opens dialog with child transcript and optional lifecycle details

### 5. Dialog content

Dialog should show:
- prompt summary
- status summary / latest update
- child transcript
- optional action timeline

Raw JSON stays out of the default surface.

## Success criteria

For one Codex subagent run in the parent timeline:
- only one primary lifecycle block is visible
- wait/send/close no longer appear as separate root-level blocks when matched to that same agent
- the lifecycle block shows human-readable status
- clicking opens nested child transcript and result details

## Risks

### Risk 1 — incorrect tool matching
A wait/send/close block may target an unrelated id.

Mitigation:
- only aggregate when the target matches a known spawn `agent_id`
- unmatched control blocks stay visible as normal blocks

### Risk 2 — hiding useful debugging information
Merging control blocks could make debugging harder.

Mitigation:
- keep action summaries in lifecycle metadata/dialog
- preserve raw tool views for unmatched cases

### Risk 3 — partial lifecycle in older sessions
Some sessions may have spawn + child transcript but no wait/close block.

Mitigation:
- lifecycle block still works with spawn-only state
- defaults to `running` unless stronger evidence appears

## Final decision

Implement a reducer-level Codex lifecycle aggregation pass so one subagent run becomes one primary lifecycle block, with wait/send/close folded into that block and the child transcript kept behind the clickable dialog.
