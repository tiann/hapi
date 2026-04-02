# Codex In-Session Subagent Nesting Design

## Summary

Add **Codex-first in-session subagent nesting** to HAPI.

Scope:
- no child-session model
- no parent/child session schema
- no SessionList tree
- no standalone subagent page

Goal:
- keep everything inside the parent session
- render Codex subagent workflow as a nested conversation under the parent tool block
- align Codex behavior with the existing Claude-style `ToolCallBlock.children` model where practical

This design is an **incremental follow-up** to the existing Codex block-support work:
- `docs/superpowers/specs/2026-04-02-codex-claude-block-support-design.md`
- `docs/superpowers/plans/2026-04-02-codex-block-support-implementation.md`

That earlier work fixes semantic tool names and block rendering. This new design fixes the missing **subagent conversation nesting**.

## Problem

Current HAPI can show Codex subagent-related tools as flat cards:
- `CodexSpawnAgent`
- `CodexWaitAgent`
- `CodexSendInput`
- `CodexCloseAgent`

But it does **not** yet attach the subagent conversation itself under the parent tool block.

Current Claude path already has a message-level nesting model:
- `tracer.ts`
- `reduceTimeline.ts`
- `ToolCallBlock.children`

Claude sidechain messages can be grouped under a parent `Task` tool call.

Codex currently lacks an equivalent mechanism.

Result:
- subagent workflow appears as flat tool cards + flat summary text
- the user cannot visually follow the child agent conversation as a nested flow
- the UI feels incomplete even though the underlying transcript contains enough clues to reconstruct nesting

## Evidence from real Codex transcripts

Recent local Codex transcripts show the parent/child relationship is partially observable already.

### Parent transcript signals

A parent session transcript commonly contains:
- `spawn_agent` function call
- `spawn_agent` function_call_output with:
  - `agent_id`
  - `nickname`
- `wait_agent` call using that `agent_id`
- `wait_agent` function_call_output with a `status[agent_id]` payload
- a later `<subagent_notification>...</subagent_notification>` user-message injected back into the parent transcript

### Inline child span signals

Some parent transcripts also inline the child run directly after `spawn_agent`, including:
- `turn_context`
- child `user_message`
- child `agent_message`
- child `task_complete`

This means Codex subagent content is not always hidden in a separate file. In at least some real cases, it already exists in the same transcript and can be grouped.

## Goals

### Functional goals
- Detect Codex subagent spans inside a parent transcript
- Attach child messages to the parent `CodexSpawnAgent` tool block as `children`
- Keep nested rendering inside the existing parent session chat page
- Preserve current flat block rendering for tool cards themselves
- Preserve current Claude nesting behavior

### UX goals
- A `CodexSpawnAgent` block should expand into a readable nested child conversation when child content is present
- The nested child flow should show:
  - child prompt
  - child replies
  - child tool activity if available in the same transcript
- `wait_agent` / `send_input` / `close_agent` should remain visible as normal tool blocks, but child conversational content should no longer appear as unrelated flat messages

### Success criteria
After this work, when a parent Codex transcript contains inline child activity:
- the child prompt and child replies render under the matching `CodexSpawnAgent` block
- those child messages do not also remain duplicated in the parent root timeline
- normal parent conversation remains in the root timeline

## Non-goals

Out of scope:
- child session pages
- session-level parent/child schema
- SessionList nesting
- loading a separate child transcript file by `agent_id`
- reconstructing every possible Codex subagent lifecycle edge case
- redesigning TeamPanel
- changing Claude provider logic beyond compatibility-safe reuse of existing nesting machinery

## Current architecture constraints

### 1. Session model is flat
Files:
- `shared/src/schemas.ts`
- `shared/src/sessionSummary.ts`

There is no:
- `parentSessionId`
- `rootSessionId`
- `sessionKind`

So nesting must remain **message-level**, not session-level.

### 2. Web nesting already exists for Claude sidechain
Files:
- `web/src/chat/tracer.ts`
- `web/src/chat/reducer.ts`
- `web/src/chat/reducerTimeline.ts`

Current model:
- `traceMessages()` adds `sidechainId`
- `reduceChatBlocks()` groups traced messages by `sidechainId`
- `reduceTimeline()` attaches grouped child blocks to the parent tool block via `block.children`

This is the right target abstraction to reuse.

### 3. Codex transcript conversion currently lacks sidechain semantics
Files:
- `cli/src/codex/utils/codexEventConverter.ts`
- `web/src/chat/normalizeAgent.ts`

Today Codex gives semantic tool names, but not explicit nesting metadata.

## Recommended approach

### Option A — web-only heuristic grouping
Infer nesting only in web reducer by looking at flat `CodexSpawnAgent` / `CodexWaitAgent` / notification patterns.

Pros:
- smaller change set

Cons:
- poor access to raw transcript structure
- fragile grouping rules
- hard to attach inline child messages cleanly

### Option B — Codex transcript sidechain normalization at the CLI boundary (recommended)
Teach the Codex transcript conversion path to emit enough metadata for the existing web nesting pipeline to work.

Pros:
- matches HAPI architecture better
- keeps transcript interpretation close to the source
- lets web reuse existing nesting pipeline

Cons:
- requires coordinated CLI + web changes

### Option C — load child transcript files by `agent_id`
Use `spawn_agent.output.agent_id` to resolve a separate child file and replay it under the parent block.

Pros:
- potentially most complete

Cons:
- much broader than needed
- touches scanner/resume/file-resolution logic again
- unnecessary for the first useful version

## Scope decision

Use **Option B**.

## Proposed design

## 1. Introduce Codex sidechain metadata in normalized chat messages

### Files
- `web/src/chat/types.ts`
- `web/src/chat/normalizeAgent.ts`
- possibly small helper extraction file under `web/src/chat/`

### Change
Extend normalized message metadata so Codex child messages can point to a parent tool block.

Recommended shape:
- keep existing `isSidechain: boolean`
- add optional `sidechainKey?: string`

Meaning:
- `isSidechain` = this message belongs to nested child flow
- `sidechainKey` = parent tool-call id that should own the nested messages

This preserves current Claude semantics while letting Codex produce nesting without pretending it is the same UUID-based sidechain model.

## 2. Add a Codex transcript nesting extractor before web reduction

### Files
- `web/src/chat/reducer.ts`
- new helper: `web/src/chat/codexSidechain.ts`

### Responsibility
Walk normalized messages and detect Codex subagent spans.

Inputs available already:
- `CodexSpawnAgent` tool-call
- its tool-result containing `agent_id`
- inline child messages in the same transcript
- `CodexWaitAgent` call targeting that `agent_id`
- `<subagent_notification>` round-trip messages

### Core rule
Treat `CodexSpawnAgent` as the parent block anchor.

When child inline transcript content appears after a `CodexSpawnAgent` result and before control clearly returns to the parent flow, mark those child messages with:
- `isSidechain = true`
- `sidechainKey = <spawn-agent-call-id>`

Then the reducer can group them exactly like Claude sidechain messages.

## 3. Codex child-span detection model

Use a conservative sequential detector.

### Parent anchor
A `CodexSpawnAgent` tool-call becomes nestable only after its matching tool-result resolves an `agent_id`.

### Child span start
A child span begins when one of these appears after the resolved spawn result:
- inline child `turn_context`
- inline child `user_message`
- inline child `agent_message`
- inline child child-tool activity clearly belonging to the spawned run

### Child span end
A child span ends when one of these occurs:
- parent `CodexWaitAgent` result completes and parent summary resumes
- parent root assistant answer starts
- a new unrelated parent tool chain clearly begins
- transcript ends

### Conservative bias
If ownership is ambiguous, keep the message in the parent root timeline.
Never hide uncertain content inside a child group.

## 4. Parent/child binding rule

### Binding key
Use the parent `CodexSpawnAgent` tool-call id as the `sidechainKey`.

Why:
- `ToolCallBlock.children` is already keyed by tool-call block id
- avoids introducing session-level ids into the web reducer
- mirrors Claude’s existing parent-tool attachment model

### Agent id tracking
Keep a temporary runtime map while scanning normalized messages:
- `agentId -> spawnToolCallId`

This supports:
- `wait_agent.targets`
- future `send_input.target`
- correlation of notification text if needed

## 5. Message classes that may become nested

Candidate nested content for the first version:
- child user prompt
- child agent text
- child reasoning
- child tool-call / tool-result when inline in the same transcript
- child ready/task-complete events if they are normalized into visible blocks

Do **not** nest these by default in v1:
- parent `CodexWaitAgent` block itself
- parent `CodexSendInput` block itself
- parent `CodexCloseAgent` block itself

Those remain root-level workflow controls.

## 6. Handling `<subagent_notification>`

### First version rule
Keep `<subagent_notification>` return messages in the root timeline.
Do not attempt to move them into the child span in v1.

Reason:
- they are explicit parent-visible summaries
- they often act as the bridge back into the parent reply
- moving them could make the parent flow harder to follow

Possible future refinement:
- dual rendering or compact summary under the child block while preserving parent root text

But not in this scope.

## 7. Reuse existing reducer pipeline

### Reducer change
Today:
- `traceMessages()` creates groups only from Claude-style sidechain tracing

After change:
- produce traced/grouped messages from two sources:
  1. existing Claude tracer output
  2. Codex sidechain extraction output

Recommended shape:
- keep `traceMessages()` for Claude path
- add a Codex-specific pass that annotates `sidechainKey`
- update `reduceChatBlocks()` to group by either:
  - `msg.sidechainId` for Claude
  - `msg.sidechainKey` for Codex

This avoids forcing Codex into Claude’s UUID prompt-matching logic.

## 8. Data flow after the change

### Codex replay/resume path
1. transcript scanner emits normalized Codex tool/messages
2. block-support aliases already normalize raw names to `Codex*`
3. Codex sidechain extractor scans normalized messages
4. inline child messages get `isSidechain + sidechainKey`
5. reducer groups those child messages under the matching `CodexSpawnAgent` block
6. UI renders nested child conversation via existing `ToolCallBlock.children`

### Claude path
Unchanged:
- existing `tracer.ts` continues to drive Claude nested sidechains

## 9. Failure handling

### Missing `agent_id`
If `CodexSpawnAgent` result has no `agent_id`:
- keep flat rendering only
- do not attempt nesting

### No inline child content
If the parent transcript only has:
- `spawn_agent`
- `wait_agent`
- notification summary
and no inline child conversation:
- keep flat workflow cards
- do not synthesize fake children

### Ambiguous ownership
If a message cannot be confidently associated with one active spawned agent:
- keep it at root
- prefer false negative over false positive nesting

## Testing strategy

Write necessary tests only.

### 1. Codex sidechain extraction tests
New file:
- `web/src/chat/codexSidechain.test.ts`

Cover:
- `CodexSpawnAgent` + result with `agent_id` + inline child user/agent messages => child messages get `sidechainKey`
- ambiguous root message remains root
- no `agent_id` => no nesting
- multiple sequential spawns => messages bind to the correct parent

### 2. Reducer integration tests
File:
- `web/src/chat/reducer.test.ts` or nearby existing reducer tests if present

Cover:
- child messages end up in `ToolCallBlock.children` under the matching `CodexSpawnAgent`
- child messages do not remain duplicated in root blocks
- parent `wait_agent` stays root-level

### 3. Manual transcript verification
Use a real Codex transcript known to contain:
- `spawn_agent`
- `wait_agent`
- inline child messages

Verify in dev web:
- `CodexSpawnAgent` expands to nested conversation
- root timeline no longer shows those child messages twice
- parent summary remains readable

## Risks and mitigations

### Risk: over-grouping parent messages as child messages
Mitigation:
- conservative detector
- require resolved spawn result first
- keep ambiguous messages at root

### Risk: transcript formats vary across Codex versions
Mitigation:
- v1 supports only the real patterns observed locally
- unsupported patterns degrade to flat rendering, not broken rendering

### Risk: too much coupling to current transcript order
Mitigation:
- isolate detector in one helper file
- test exact observed orderings
- keep reducer contract simple: annotate messages, then group normally

## Recommended execution order

1. Finish the outstanding block-support plan gap:
   - dedicated result views for Codex subagent tools
   - real replay verification
2. Add `sidechainKey` support to normalized/traced messages
3. Implement `codexSidechain.ts` detector
4. Wire reducer grouping for Codex nested children
5. Add focused tests
6. Run manual replay verification on a real subagent transcript

## Final recommendation

Implement Codex subagent nesting as a **message-level grouping feature**, not as a session model.

That gives the behavior you want now:
- parent session only
- nested child conversation inside the chat page
- no schema churn
- strong reuse of the Claude-era reducer/UI pipeline

It also composes cleanly with the earlier Codex block-support work instead of replacing it.
