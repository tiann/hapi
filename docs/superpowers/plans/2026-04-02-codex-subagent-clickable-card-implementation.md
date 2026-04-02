# Codex Subagent Clickable Card Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Replace the current always-inline Codex nested child rendering with a dedicated clickable preview card/dialog for `CodexSpawnAgent` blocks that already have `children`.

**Architecture:** Keep the current CLI/reducer sidechain pipeline intact. Implement a view-layer special-case in the assistant chat renderer: `CodexSpawnAgent + children => preview card + dialog`, using the existing nested renderer inside the dialog.

**Tech Stack:** TypeScript, React, assistant chat components, shadcn dialog, Vitest.

---

## File map

### Create
- `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.tsx`
- `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx`

### Modify
- `web/src/components/AssistantChat/messages/ToolMessage.tsx`
- `web/src/chat/reducer.test.ts`
- optionally `web/src/components/ToolCard/knownTools.tsx` only if summary text helper reuse is needed

Do not modify reducer/schema unless blocked.

---

### Task 1: Add RED tests for clickable Codex subagent preview behavior

**Files:**
- Create: `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx`
- Modify if needed: `web/src/chat/reducer.test.ts`

- [ ] Add a component test for a `CodexSpawnAgent` block with children.
  - render `HappyToolMessage` or the new preview component with a realistic `ToolCallBlock`
  - assert collapsed view shows:
    - subagent label/card text
    - prompt preview or agent id when present
  - assert child prompt / child answer are **not** visible before open
  - click preview/button
  - assert dialog now shows child prompt / child answer

- [ ] Add/keep reducer integration assertion that `CodexSpawnAgent.children` is populated and root timeline does not contain duplicate flat child text.

- [ ] Run focused web tests; confirm RED.

Suggested command:
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/xiaoxiong/workplace/hapi-dev/web
bun run test -- src/chat/reducer.test.ts src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx
```

---

### Task 2: Implement Codex subagent preview card component

**Files:**
- Create: `web/src/components/AssistantChat/messages/CodexSubagentPreviewCard.tsx`

- [ ] Build compact card UI.
  - heading: `Subagent conversation`
  - secondary info from spawn tool input/result:
    - nickname
    - agent id
    - delegated prompt preview
    - child block count
  - affordance: button/row with open icon

- [ ] Add dialog body.
  - dialog title can use nickname or fallback `Subagent conversation`
  - dialog content renders nested child transcript with the existing nested block renderer path

- [ ] Keep implementation local/simple.
  - no new route
  - no new global state

---

### Task 3: Wire ToolMessage special-case

**Files:**
- Modify: `web/src/components/AssistantChat/messages/ToolMessage.tsx`

- [ ] Extract a shared helper for rendering tool children if that reduces duplication.

- [ ] Add special-case:
  - when `block.tool.name === 'CodexSpawnAgent' && block.children.length > 0`
  - render `CodexSubagentPreviewCard`
  - suppress the default inline nested block list for that block

- [ ] Preserve current behavior for:
  - `Task`
  - all non-`CodexSpawnAgent` tools
  - nested render inside dialog

---

### Task 4: GREEN tests + manual verification

**Files:**
- no new files beyond above unless a tiny test helper is required

- [ ] Run focused tests:
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/xiaoxiong/workplace/hapi-dev/web
bun run test -- src/chat/reducer.test.ts src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx
```

- [ ] Run broader web safety checks:
```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/xiaoxiong/workplace/hapi-dev/web
bun run test -- src/chat/normalize.test.ts src/chat/codexSidechain.test.ts src/chat/reducer.test.ts src/components/ToolCard/views/_results.test.tsx src/components/AssistantChat/messages/CodexSubagentPreviewCard.test.tsx
bun run typecheck
```

- [ ] Manual dev-web verification on real Codex parent session.
  - confirm `CodexSpawnAgent` shows clickable subagent card
  - confirm child transcript opens in dialog
  - confirm child transcript no longer floods main timeline by default

---

### Task 5: Commit

- [ ] Commit only the UI work for clickable Codex subagent preview/dialog.

Suggested commit message:
```bash
git commit -m "feat(web): add codex subagent preview dialog"
```
