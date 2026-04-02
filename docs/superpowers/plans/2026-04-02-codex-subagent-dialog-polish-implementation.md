# Codex Subagent Dialog Polish Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Polish the Codex lifecycle/subagent dialog by removing duplicated prompt display, improving transcript rendering, and adding explicit close affordance.

**Architecture:** Keep lifecycle aggregation unchanged. Adjust only the lifecycle card/dialog rendering layer and its focused tests.

## Files

### Modify
- `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.tsx`
- `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx`
- optionally `web/src/components/AssistantChat/messages/ToolMessage.tsx` only if required by the close flow

## Tasks

### Task 1: RED tests
- add test for delegated prompt dedupe
- add test for explicit close button
- add test that markdown child agent text renders through markdown path

### Task 2: Implement polish
- dedupe first repeated user prompt block in dialog transcript
- render child `agent-text` via `MarkdownRenderer`
- add explicit `Close` button in dialog footer
- keep lifecycle summary as the single wait/completed surface

### Task 3: Verify
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/xiaoxiong/workplace/hapi-dev/web
bun run test -- src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx src/chat/reducer.test.ts
bun run test -- src/chat/normalize.test.ts src/chat/codexSidechain.test.ts src/chat/reducer.test.ts src/components/ToolCard/views/_results.test.tsx src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx
bun run typecheck
```
