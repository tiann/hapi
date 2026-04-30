# Editor Tree Default Open and Pane Resize Design

## Goal

Improve Editor Mode ergonomics:

1. The selected project directory opens by default in the file tree.
2. Editor panes can be resized by dragging split handles.

## Scope

In scope:
- Auto-expand the root project directory when `projectPath` is selected.
- Reset expanded directories when project changes.
- Add draggable split handles for:
  - left file tree width
  - right sessions/chat width
  - terminal panel height
- Persist pane sizes in `localStorage`.
- Clamp pane sizes to practical min/max bounds.

Out of scope:
- Double-click reset. This is intentionally not implemented because it is easy to trigger accidentally.
- Per-project pane size storage.
- Mobile-specific resize UX.
- Collapsible panes.

## Defaults and Bounds

- Left file tree:
  - default: `260px`
  - min: `200px`
  - max: `500px`
- Right sessions/chat:
  - default: `380px`
  - min: `300px`
  - max: `640px`
- Terminal:
  - default: `160px`
  - min: `100px`
  - max: `360px`

## Architecture

### File tree

`EditorFileTree` owns expanded directory state. When `projectPath` is present, initialize and reset expanded paths to include the root project path:

```ts
new Set([projectPath])
```

This keeps existing lazy-loading behavior but loads the selected project root immediately.

### Resize hook

Add `web/src/hooks/useEditorPaneResize.ts`.

The hook owns:
- `leftWidth`
- `rightWidth`
- `terminalHeight`
- drag state
- pointer handlers
- localStorage persistence
- document cursor/user-select while dragging

The hook exposes separate pointer handlers:

```ts
useEditorPaneResize(): {
    leftWidth: number
    rightWidth: number
    terminalHeight: number
    isDragging: boolean
    onLeftResizePointerDown: (event: React.PointerEvent) => void
    onRightResizePointerDown: (event: React.PointerEvent) => void
    onTerminalResizePointerDown: (event: React.PointerEvent) => void
}
```

Drag math:
- Left handle: `startWidth + deltaX`
- Right handle: `startWidth - deltaX` because dragging left increases the right pane.
- Terminal handle: `startHeight - deltaY` because dragging up increases terminal height.

### Layout wiring

`EditorLayout` replaces static widths/heights with values from `useEditorPaneResize` and renders thin handles:

- between file tree and center editor
- between center editor and right pane
- between editor tabs and terminal

Handles use accessible labels:
- `Resize file tree`
- `Resize sessions panel`
- `Resize terminal panel`

No double-click handler is added.

## Testing

- `EditorFileTree.test.tsx`: project root is expanded by default and root entries render without manually toggling root.
- `useEditorPaneResize.test.tsx`: verifies defaults, drag behavior, clamping, persistence.
- `EditorLayout.test.tsx`: verifies resize handles render and dragging updates pane dimensions.

## Manual Smoke

- Open `/editor`.
- Select machine/project.
- File tree root entries visible immediately.
- Drag file tree splitter: left pane resizes.
- Drag sessions splitter: right pane resizes.
- Drag terminal splitter: terminal height resizes.
- Refresh page: sizes persist.
- Double-click splitters: no reset behavior.
