# Editor Edit, New File, and Scroll Isolation Design

## Goal

Make Editor Mode behave more like a small IDE:

1. Main editor scrolls inside its own pane, not the whole page.
2. Opened text files are editable and can be saved.
3. New files can be created from the file tree with VSCode-style inline input.

## Scope

In scope:
- Fix center editor overflow so file content scrolls in CodeMirror.
- Allow editing text file tabs.
- Track dirty file state per tab.
- Save active/dirty files through editor RPC.
- Create new files from the file tree via inline input.
- Refresh affected directory and open the created file.

Out of scope:
- Delete, rename, move files.
- Multi-file save all.
- Merge/conflict detection.
- Binary file editing.
- Directory creation as a separate action. Nested file paths may create parent folders if backend supports it.

## UX

### Editor scroll

The full `/editor` route remains fixed height. Scrollbars belong to panels:

- file tree: own vertical scroll
- CodeMirror editor: own vertical/horizontal scroll
- terminal: own panel area
- session chat: own scroll via existing chat components

No file content should make the page/body scroll.

### Editing and saving

- CodeMirror becomes editable for loaded text files.
- Each file tab tracks:
  - loaded content
  - current editor content
  - dirty state
  - save error, if any
- Dirty tabs show `●` before the label.
- Active dirty file can be saved with:
  - `Ctrl+S` / `Cmd+S`
  - visible `Save` button in tab toolbar
- Save success updates loaded content and clears dirty marker.
- Save failure leaves dirty marker and displays an error.

### New File inline flow

- Right-click folder/root or file → `New File`.
- If invoked on a file, new file parent is that file's directory.
- The file tree shows an inline input row under the target parent.
- Input is focused.
- User may type:
  - `foo.ts`
  - `components/Button.tsx`
- `Enter`: create file.
- `Escape`: cancel.
- Blur: cancel.
- Empty input: cancel.
- Absolute paths and `..` segments are rejected client-side.
- Backend errors are shown inline.
- On success:
  - affected directory query refreshes
  - relevant parent remains expanded
  - new file opens in an editor tab

## Backend/API

Add editor write/create support using session-less RPC, parallel to existing editor read/list RPC.

### Web API client/types

Add response type:

```ts
export type EditorWriteFileResponse = {
    success: boolean
    error?: string
}
```

Add client methods:

```ts
writeEditorFile(machineId: string, path: string, content: string): Promise<EditorWriteFileResponse>
createEditorFile(machineId: string, path: string, content?: string): Promise<EditorWriteFileResponse>
```

`content` is plain UTF-8 text on the web side. Hub/CLI can pass text directly over RPC.

### Hub

Add routes:

- `POST /api/editor/file/write`
- `POST /api/editor/file/create`

Add SyncEngine methods:

- `writeEditorFile(machineId, path, content)`
- `createEditorFile(machineId, path, content?)`

Add RpcGateway methods for machine-level RPC:

- `editor-write-file`
- `editor-create-file`

### CLI

Add handlers in `cli/src/modules/editorRpc.ts`:

- write file:
  - write UTF-8 content
  - fail if target is a directory
- create file:
  - reject existing path
  - create parent directories as needed
  - write initial content or empty string

Security follows existing editor file ops constraints. Reject invalid/unsafe paths using the same path checks used by editor read/list handlers.

## Frontend architecture

### Editor state

Extend editor tab state with optional file metadata:

```ts
type EditorTab = {
    id: string
    type: 'file' | 'terminal'
    path?: string
    label: string
    shell?: string
    dirty?: boolean
}
```

Add tab state actions:

- `setTabDirty(tabId, dirty)`
- optional `markFileSaved(filePath)` if simpler than tab ID

### EditorTabs

`EditorTabs` owns CodeMirror instances and tracks current content for active file. It calls parent callbacks when dirty state changes and when saving.

Props add:

```ts
onDirtyChange?: (tabId: string, dirty: boolean) => void
onSaveFile?: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
```

`EditorTabs` shows Save button when active file is dirty.

### EditorFileTree

Add props:

```ts
onCreateFile: (parentPath: string, fileName: string) => Promise<{ success: boolean; fullPath?: string; error?: string }>
```

`EditorFileTree` manages inline input state:

```ts
{ parentPath: string; error: string | null } | null
```

Context menu action calls into `EditorFileTree` to start inline input. To keep boundaries simple, the existing `EditorContextMenu` can expose `New File` action, and `EditorLayout` can pass a `newFileParentPath` state down to the tree.

## Testing

- Hub/CLI tests for write/create RPC.
- Web API type/client tests if existing patterns allow.
- `EditorTabs.test.tsx`:
  - CodeMirror editable.
  - edit marks tab dirty.
  - `Ctrl/Cmd+S` calls save.
  - save success clears dirty; failure shows error.
  - CodeMirror scroll container is constrained.
- `EditorFileTree.test.tsx`:
  - New File inline input appears under target folder.
  - Enter calls create callback.
  - Escape/blur cancel.
  - invalid path rejects client-side.
- `EditorLayout.test.tsx`:
  - context menu New File starts inline input parent.
  - create success opens new file tab.
- Full typecheck/test.

## Manual Smoke

- Open `/editor`.
- Open long file; body/page should not scroll, editor pane should scroll.
- Edit file, see dirty marker.
- Save with `Cmd/Ctrl+S`, dirty marker clears.
- Right-click root/folder/file → New File.
- Inline input appears; create `tmp/test.ts`.
- New file opens in tab and appears in tree after refresh.
