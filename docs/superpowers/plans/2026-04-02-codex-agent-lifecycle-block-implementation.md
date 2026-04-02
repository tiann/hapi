# Codex Agent Lifecycle Block Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Make one Codex subagent appear as one lifecycle block in the parent chat timeline by folding matched wait/send/close control blocks into the owning `CodexSpawnAgent` block.

**Architecture:** Keep current scanner/converter/sidechain pipeline. Add a reducer-level lifecycle aggregation pass after normal block reduction, attach lifecycle metadata to spawn blocks, filter matched control blocks from the root timeline, and render spawn blocks with a lifecycle card instead of a generic tool card.

**Tech Stack:** TypeScript, React, Bun, Vitest.

---

## File map

### Create
- optional: `web/src/chat/codexLifecycle.ts`
- optional: `web/src/chat/codexLifecycle.test.ts`

### Modify
- `web/src/chat/types.ts`
- `web/src/chat/reducer.ts`
- `web/src/components/AssistantChat/messages/ToolMessage.tsx`
- `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.tsx`
- `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx`
- `web/src/chat/reducer.test.ts`

Prefer a helper file for lifecycle aggregation if reducer gets noisy.

---

### Task 1: Add RED reducer tests for lifecycle aggregation

- [ ] Extend `web/src/chat/reducer.test.ts` with a realistic sequence:
  - spawn call/result
  - child user/agent transcript
  - wait call/result targeting same `agent_id`
  - optional send/close targeting same `agent_id`
- [ ] Assert:
  - root timeline contains one `CodexSpawnAgent` block
  - matched `CodexWaitAgent` is removed from root timeline
  - spawn block gets lifecycle metadata with completed/waiting state
  - child transcript remains under `spawnBlock.children`

### Task 2: Implement lifecycle aggregation

- [ ] Add typed lifecycle metadata in `web/src/chat/types.ts`
- [ ] Implement helper in `web/src/chat/reducer.ts` or `web/src/chat/codexLifecycle.ts`:
  - build `agentId -> spawn block`
  - fold matched wait/send/close blocks into spawn lifecycle metadata
  - filter matched control blocks from returned root blocks
- [ ] Keep unmatched control blocks visible

### Task 3: Upgrade lifecycle card rendering

- [ ] Update `CodexSubagentPreviewCard.tsx`:
  - show status pill / label
  - show latest lifecycle text if available
  - show condensed action count or latest action
- [ ] Update `ToolMessage.tsx`:
  - for lifecycle-enabled `CodexSpawnAgent`, render lifecycle card as the primary block
  - do not also render the generic tool card in the main timeline
  - keep dialog transcript behavior

### Task 4: GREEN tests and verification

- [ ] Focused tests:
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/xiaoxiong/workplace/hapi-dev/web
bun run test -- src/chat/reducer.test.ts src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx
```

- [ ] Broader safety tests:
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/xiaoxiong/workplace/hapi-dev/web
bun run test -- src/chat/normalize.test.ts src/chat/codexSidechain.test.ts src/chat/reducer.test.ts src/components/ToolCard/views/_results.test.tsx src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx
bun run typecheck
```

### Task 5: Commit

- [ ] Commit lifecycle-block UI/reducer changes.

Suggested message:
```bash
git commit -m "feat(web): merge codex agent lifecycle blocks"
```
