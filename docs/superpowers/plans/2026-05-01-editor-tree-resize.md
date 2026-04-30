# Editor Tree Default Open and Pane Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor project directory open by default and allow resizing editor panes by dragging split handles.

**Architecture:** `EditorFileTree` auto-expands the selected project root. A new `useEditorPaneResize` hook manages left width, right width, terminal height, drag handlers, clamping, and localStorage persistence. `EditorLayout` consumes the hook and renders accessible resize handles.

**Tech Stack:** React 19, TypeScript strict, Vitest, Testing Library, Tailwind CSS.

---

## File Structure

```
web/src/
├── components/editor/
│   ├── EditorFileTree.tsx          # auto-expand selected project root (MODIFY)
│   ├── EditorFileTree.test.tsx     # root expanded default test (MODIFY)
│   ├── EditorLayout.tsx            # use pane resize hook + render handles (MODIFY)
│   └── EditorLayout.test.tsx       # resize handle test (MODIFY)
└── hooks/
    ├── useEditorPaneResize.ts      # pane resize hook (NEW)
    └── useEditorPaneResize.test.ts # hook tests (NEW)
```

---

### Task 1: Auto-expand selected project root in file tree

**Files:**
- Modify: `web/src/components/editor/EditorFileTree.tsx`
- Modify: `web/src/components/editor/EditorFileTree.test.tsx`

- [ ] **Step 1: Write failing test**

Update `web/src/components/editor/EditorFileTree.test.tsx` test `renders project root and lazy-loads children when expanded` to expect root entries immediately:

```ts
it('renders project root expanded by default', () => {
    const api = {} as ApiClient
    render(
        <EditorFileTree
            api={api}
            machineId="machine-1"
            projectPath="/repo"
            onOpenFile={vi.fn()}
            onContextMenu={vi.fn()}
        />
    )

    expect(screen.getAllByText('repo').length).toBeGreaterThan(0)
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('src')).toBeInTheDocument()
    expect(useProjectDirectoryMock).toHaveBeenCalledWith(api, 'machine-1', '/repo')
})
```

Keep nested directory test by removing the now-unneeded root toggle before opening `src`.

- [ ] **Step 2: Run RED test**

```bash
bun run --cwd web vitest run src/components/editor/EditorFileTree.test.tsx
```

Expected: FAIL because `README.md` is not visible until root is toggled.

- [ ] **Step 3: Implement auto-expand**

In `EditorFileTree.tsx`, import `useEffect` and initialize/reset expanded state:

```ts
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
```

Inside `EditorFileTree`:

```ts
const [expanded, setExpanded] = useState<Set<string>>(() => (
    props.projectPath ? new Set([props.projectPath]) : new Set()
))

useEffect(() => {
    setExpanded(props.projectPath ? new Set([props.projectPath]) : new Set())
}, [props.projectPath])
```

- [ ] **Step 4: Run tests**

```bash
bun run --cwd web vitest run src/components/editor/EditorFileTree.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/editor/EditorFileTree.tsx web/src/components/editor/EditorFileTree.test.tsx
git commit -m "feat(editor): expand project root by default"
```

---

### Task 2: Add editor pane resize hook

**Files:**
- Create: `web/src/hooks/useEditorPaneResize.ts`
- Create: `web/src/hooks/useEditorPaneResize.test.ts`

- [ ] **Step 1: Write failing hook tests**

Create `web/src/hooks/useEditorPaneResize.test.ts` with tests for defaults, left/right/terminal drag, clamping, and persistence.

- [ ] **Step 2: Run RED test**

```bash
bun run --cwd web vitest run src/hooks/useEditorPaneResize.test.ts
```

Expected: FAIL because hook module does not exist.

- [ ] **Step 3: Implement hook**

Create `web/src/hooks/useEditorPaneResize.ts` with:

- storage key `hapi-editor-pane-sizes`
- defaults/bounds from spec
- pointerdown handlers for left/right/terminal
- document `pointermove`, `pointerup`, `pointercancel` listeners while dragging
- `document.body.style.userSelect = 'none'`
- cursor `col-resize` or `row-resize`
- localStorage persistence when size changes
- no double-click reset handler

- [ ] **Step 4: Run hook tests**

```bash
bun run --cwd web vitest run src/hooks/useEditorPaneResize.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useEditorPaneResize.ts web/src/hooks/useEditorPaneResize.test.ts
git commit -m "feat(editor): add pane resize hook"
```

---

### Task 3: Wire pane resize into EditorLayout

**Files:**
- Modify: `web/src/components/editor/EditorLayout.tsx`
- Modify: `web/src/components/editor/EditorLayout.test.tsx`

- [ ] **Step 1: Write failing layout test**

Update `EditorLayout.test.tsx` to assert handles exist:

```ts
expect(screen.getByRole('separator', { name: 'Resize file tree' })).toBeInTheDocument()
expect(screen.getByRole('separator', { name: 'Resize sessions panel' })).toBeInTheDocument()
expect(screen.getByRole('separator', { name: 'Resize terminal panel' })).toBeInTheDocument()
```

Add a drag test for one handle that verifies the left aside width changes.

- [ ] **Step 2: Run RED test**

```bash
bun run --cwd web vitest run src/components/editor/EditorLayout.test.tsx
```

Expected: FAIL because resize handles do not exist.

- [ ] **Step 3: Wire hook and handles**

In `EditorLayout.tsx`:

```ts
import { useEditorPaneResize } from '@/hooks/useEditorPaneResize'
```

Inside component:

```ts
const panes = useEditorPaneResize()
```

Replace static sizes:

```tsx
<aside style={{ width: panes.leftWidth }}>
...
<div role="separator" aria-label="Resize file tree" onPointerDown={panes.onLeftResizePointerDown} />
...
<div role="separator" aria-label="Resize sessions panel" onPointerDown={panes.onRightResizePointerDown} />
<aside style={{ width: panes.rightWidth }}>
...
<div role="separator" aria-label="Resize terminal panel" onPointerDown={panes.onTerminalResizePointerDown} />
<div style={{ height: panes.terminalHeight }}>
```

Use thin visual handles with `cursor-col-resize` / `cursor-row-resize`.

No `onDoubleClick` handler.

- [ ] **Step 4: Run layout tests and typecheck**

```bash
bun run --cwd web vitest run src/components/editor/EditorLayout.test.tsx
bun run --cwd web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/editor/EditorLayout.tsx web/src/components/editor/EditorLayout.test.tsx
git commit -m "feat(editor): make panes resizable"
```

---

### Task 4: Final verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run full web verification**

```bash
bun run --cwd web test
bun run --cwd web typecheck
```

Expected: PASS.

- [ ] **Step 2: Manual smoke**

Verify:
- `/editor` root project directory is open by default.
- Drag file tree splitter resizes left pane.
- Drag sessions splitter resizes right pane.
- Drag terminal splitter resizes terminal height.
- Refresh preserves pane sizes.
- Double-click splitters does nothing special.

---

## Self-Review

- Covers all approved requirements.
- Explicitly excludes double-click reset.
- No placeholders.
- Types and file paths match current codebase.
