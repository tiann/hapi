# Codex Subagent Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Codex child/subagent output from the main assistant stream and render it in expandable timeline cards.

**Architecture:** CLI converts Codex app-server collaboration items into explicit subagent action events and routes child-thread output into subagent output events. Web normalizes those events and renders a compact expandable card without changing composer behavior or session navigation.

**Tech Stack:** TypeScript, Bun, Vitest, React.

---

### Task 1: CLI event conversion

**Files:**
- Modify: `cli/src/codex/utils/appServerEventConverter.ts`
- Test: `cli/src/codex/utils/appServerEventConverter.test.ts`

- [ ] Add tests for `collabToolCall`/`spawnAgent` item conversion.
- [ ] Implement flexible subagent action decoding.
- [ ] Verify targeted test passes.

### Task 2: CLI child-thread routing

**Files:**
- Modify: `cli/src/codex/codexRemoteLauncher.ts`
- Test: `cli/src/codex/codexRemoteLauncher.test.ts`

- [ ] Add tests proving child-thread messages do not emit normal assistant messages.
- [ ] Route child thread output into `codex_subagent_output` agent event messages.
- [ ] Forward `codex_subagent_action` as event messages.
- [ ] Verify targeted test passes.

### Task 3: Web normalization and rendering

**Files:**
- Modify: `web/src/chat/types.ts`
- Modify: `web/src/chat/normalizeAgent.ts`
- Modify: relevant timeline/session chat rendering files found during implementation.
- Test: existing nearby web tests or new focused tests.

- [ ] Add normalization/render tests for action/output events.
- [ ] Implement expandable subagent card.
- [ ] Verify targeted tests pass.

### Task 4: Final verification

- [ ] Run `bun typecheck`.
- [ ] Run targeted tests for changed CLI/web areas.
