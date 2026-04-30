# Editor Edit, New File, and Scroll Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add isolated editor scrolling, editable/savable file tabs, and VSCode-style inline New File creation to Editor Mode.

**Architecture:** Extend existing session-less editor RPC from read/list to write/create. Keep file tree creation UI local to `EditorFileTree` with `EditorLayout` orchestrating context menu state and API calls. Make `EditorTabs` editable and track dirty state through `useEditorState`.

**Tech Stack:** React 19, TanStack Query, CodeMirror 6, Hono, Socket.IO RPC, Bun/Vitest, TypeScript strict.

---

## Task 1: Fix editor scroll isolation

**Files:**
- Modify: `web/src/components/editor/EditorTabs.tsx`
- Modify: `web/src/components/editor/EditorTabs.test.tsx`
- Modify: `web/src/components/editor/EditorLayout.tsx`
- Modify: `web/src/components/editor/EditorLayout.test.tsx`

Steps:
1. Add failing tests that assert editor content wrapper has `overflow-hidden` and CodeMirror host has `h-full min-h-0 overflow-hidden` or equivalent test ids/classes.
2. Run `bun run --cwd web vitest run src/components/editor/EditorTabs.test.tsx src/components/editor/EditorLayout.test.tsx` and verify RED.
3. Update layout and CodeMirror wrapper so center area cannot expand page/body; CodeMirror scroller owns scroll.
4. Run same tests and `bun run --cwd web typecheck`.
5. Commit `fix(editor): isolate editor scrolling`.

---

## Task 2: Add write/create editor RPC backend

**Files:**
- Modify: `web/src/types/api.ts`
- Modify: `web/src/api/client.ts`
- Modify: `hub/src/sync/rpcGateway.ts`
- Modify: `hub/src/sync/syncEngine.ts`
- Modify: `hub/src/web/routes/editor.ts`
- Modify: `cli/src/modules/editorRpc.ts`
- Tests next to existing editor RPC tests.

Steps:
1. Add failing hub/CLI/client tests for `writeEditorFile` and `createEditorFile`.
2. Run focused tests and verify RED.
3. Implement API types/client methods.
4. Implement hub route + SyncEngine + RpcGateway methods.
5. Implement CLI handlers using safe path checks and UTF-8 `fs.writeFile`.
6. Run focused tests plus `bun run --cwd hub typecheck`, `bun run --cwd cli typecheck`, `bun run --cwd web typecheck`.
7. Commit `feat(editor): add write and create file RPC`.

---

## Task 3: Track dirty file tabs in editor state

**Files:**
- Modify: `web/src/hooks/useEditorState.ts`
- Modify: `web/src/hooks/useEditorState.test.ts`

Steps:
1. Add failing tests for `setTabDirty(tabId, dirty)` and dirty marker state persisting per file tab.
2. Run focused test and verify RED.
3. Add `dirty?: boolean` to `EditorTab` and implement `setTabDirty`.
4. Run focused test + web typecheck.
5. Commit `feat(editor): track dirty file tabs`.

---

## Task 4: Make EditorTabs editable and savable

**Files:**
- Modify: `web/src/components/editor/EditorTabs.tsx`
- Modify: `web/src/components/editor/EditorTabs.test.tsx`

Steps:
1. Add failing tests:
   - CodeMirror is editable.
   - Dispatching content changes calls `onDirtyChange(tabId, true)`.
   - Dirty active tab shows `●` and Save button.
   - Ctrl/Cmd+S calls `onSaveFile(path, content)`.
   - Save success clears dirty; save failure shows error.
2. Run focused tests and verify RED.
3. Wire CodeMirror update listener, editable mode, Save button, save shortcut.
4. Run focused tests + web typecheck.
5. Commit `feat(editor): edit and save file tabs`.

---

## Task 5: Add VSCode-style inline New File in file tree

**Files:**
- Modify: `web/src/components/editor/EditorContextMenu.tsx`
- Modify: `web/src/components/editor/EditorContextMenu.test.tsx`
- Modify: `web/src/components/editor/EditorFileTree.tsx`
- Modify: `web/src/components/editor/EditorFileTree.test.tsx`
- Modify: `web/src/components/editor/EditorLayout.tsx`
- Modify: `web/src/components/editor/EditorLayout.test.tsx`

Steps:
1. Add failing context menu test for `New File` action.
2. Add failing file tree tests for inline input under folder/root/file parent, Enter create, Escape/blur cancel, invalid absolute/`..` path error.
3. Add failing layout test that create success opens new file tab.
4. Implement context menu action and file tree inline input state.
5. Implement layout create callback using `api.createEditorFile`, invalidate/refetch directory via query keys or existing query invalidation pattern, open created file.
6. Run focused tests + web typecheck.
7. Commit `feat(editor): add inline new file flow`.

---

## Task 6: Final verification

Steps:
1. Run `bun typecheck`.
2. Run `bun run test`.
3. Run `bun run --cwd web build`.
4. Manual smoke:
   - editor pane scrolls internally
   - edit + save clears dirty marker
   - create nested file from file/folder context menu
   - page body does not scroll due to long file
5. Commit docs only if manual results are recorded.

---

## Self-Review

- Covers scroll isolation, edit/save, and inline New File.
- Explicitly excludes delete/rename/move/conflict detection.
- No double-click reset behavior included.
- Plan tasks are sequential because backend write RPC is required before frontend save/create integration.
