# Editor Mode Design

> Status: Approved | Date: 2026-04-30

## 1. Overview

Add an **Editor Mode** to HAPI — an IDE-like interface for working with code projects, inspired by Antigravity and VS Code. Three-panel layout: file tree (left), editor + tabs (center), session list + chat (right). Project + machine selectors in the header.

Editor Mode coexists with the existing Agent Mode (`/sessions/...`). Users switch between modes depending on their workflow.

### Key Design Principles

- **Reuse aggressively**: Repurpose existing components (DirectoryTree, SessionChat, SessionList, WorkspaceBrowser, API layer, SSE sync) wherever possible.
- **Progressive delivery**: Phase 1 ships read-only code viewer + AI-powered editing via chat. Phase 2 adds full manual editing (CodeMirror editable).
- **Desktop-first**: Editor Mode requires ≥1024px viewport. Mobile/tablet users stay in Agent Mode.
- **Same design language**: Use Dashboard CSS variables (`--app-bg`, `--app-fg`, `--app-border`, `--app-subtle-bg`, `--app-hint`, `--app-link`, `--app-button`, `--app-button-text`).

## 2. User Flow

### Entry Points

1. **From Dashboard** — Project group header gets an "Open in Editor" button. Clicking it navigates to `/editor?machine=<id>&project=<path>`.
2. **From Session Detail** — Session header gets an "Open in Editor" button. Auto-detects machine from session metadata + project path.

### Within Editor Mode

1. Select machine + project via header dropdowns (or arrive via entry point with pre-filled params).
2. Browse file tree in the left panel (expand/collapse directories, git status indicators).
3. Click a file → opens in editor tab (center panel, read-only with syntax highlighting in Phase 1).
4. Right-click file(s) in tree → "Add to Chat" → file path(s) inserted into active session's composer input. If no session is active, auto-creates a new session.
5. Chat with AI in the right panel. AI can read project files and propose edits.
6. Open terminal tabs alongside file tabs for running commands.
7. Create new sessions with the "+ New" button in the session list.
8. Switch between sessions by clicking in the list; chat panel updates to show that session.

## 3. Layout (updated v4)

```
┌──────────────────────────────────────────────────────────────┐
│ Header: [Editor] ▸ [Machine ▼] / [Project ▼]    [Agent Mode] │
├────────────┬──────────────────────────┬──────────────────────┤
│ File Tree  │ Tab Bar                  │ Session List         │
│            │ ┌──────────────────────┐ │ ┌──────────────────┐ │
│ src/       │ │ App.tsx  ✕│route…  ✕│ │ │ 💬 Refactor  🟢  │ │
│ ├─ comp/   │ ├──────────────────────┤ │ │ 💬 Fix types  ⚪  │ │
│ ├─ hooks/  │ │  code content        │ │ │ + New             │ │
│ └─ lib/    │ │  (syntax highlighted) │ │ └──────────────────┘ │
│ README.md M│ └──────────────────────┘ │                      │
│            │ Status: lang, Ln 1,Col 1 │ Chat Panel           │
│            ├──────────────────────────┤ ┌──────────────────┐ │
│            │ Terminal Tab Bar         │ │ AI: I'll refactor│ │
│            │ 💻 bash │ 💻 zsh │ +    │ │ …                │ │
│            ├──────────────────────────┤ └──────────────────┘ │
│            │ Terminal content         │ [📎][mode][model]    │ │
│            │ $ bun run dev            │ [________] [Send]    │ │
│            │ ▊                        │                      │
└────────────┴──────────────────────────┴──────────────────────┘
```

The center column is split vertically:
- **Upper**: Editor tabs + content (flex: 1, min-height: 200px)
- **Resize handle**: Draggable divider between editor and terminal
- **Lower**: Terminal panel (default ~160px, min-height: 60px) with its own tab bar

The file tree (left) and sessions+chat (right) both span the **full height** — terminal does NOT extend into those panels.

### Column / Section Sizing

| Section | Default | Min | Behavior |
|---------|---------|-----|----------|
| File Tree (left) | 260px | 180px | Resizable via drag handle |
| Editor (center-upper) | flex:1 | 200px | Absorbs remaining space |
| Terminal (center-lower) | 160px | 60px | Resizable via drag handle |
| Right Panel | 380px | 280px | Resizable via drag handle |

## 4. Components

### 4.1 Route: `/editor`

**File**: `web/src/routes/editor.tsx`

```
Route: /editor
Params (search):
  machine?: string    — Machine ID
  project?: string    — Project root path
  file?: string       — (future) Initial file to open
```

**Page Component**: `EditorPage` — orchestrates the layout, manages state (selected project, active session, open tabs, etc.).

### 4.2 Header

**File**: `web/src/components/editor/EditorHeader.tsx`

- Title: "HAPI Editor"
- Machine selector: `<select>` populated via `useMachines()`
- Project selector: Combines machine tree browser (similar to WorkspaceBrowser's breadcrumb-based path navigation) OR a text input. When both machine and project are selected, the file tree and session list load.
- "Agent Mode →" button: navigates back to `/sessions` (or session detail if came from one).
- On machine change: reload file tree + sessions for that machine.
- On project change: update URL param, reload file tree + sessions.

### 4.3 File Tree Panel

**Files**:
- `web/src/components/editor/EditorFileTree.tsx`

Reuses `SessionFiles/DirectoryTree.tsx` with enhancements:

- **Root**: The project directory (from URL param) becomes the tree root.
- **Lazy loading**: Directories expand on click, fetches children via RPC `list-directory`.
- **Git status**: Each file shows a colored dot indicator:
  - 🟡 Yellow: Modified (M)
  - 🟢 Green: Added (A)
  - 🔴 Red: Deleted (D)
  - No dot: Unchanged
- **File icons**: Reuse `FileIcon.tsx` which already has color-per-extension (ts=#3178c6, css=#2563eb, json=#f59e0b, etc.).
- **Context menu** (right-click):
  - "Open in Editor" — opens file in center editor
  - "Add to Chat" — inserts file path(s) into active session's composer input
  - "Copy Path" — copies absolute path
  - "View Diff" — opens diff view (navigates to file viewer or inline panel)
- **Multi-select**: Ctrl/Cmd+click to select multiple files/folders for "Add to Chat".

**Data source**: RPC-based directory listing from the active machine. Hub proxies the request to CLI on the target machine. Similar to existing `useSessionDirectory` but for arbitrary project paths on a machine.

### 4.4 Editor Tabs

**Files**:
- `web/src/components/editor/EditorTabs.tsx`
- `web/src/components/editor/EditorTabBar.tsx`
- `web/src/components/editor/EditorContent.tsx`

**Tab types**:
- **File tab**: Shows file icon + name + close button. Click to activate.
- **Terminal tab**: Shows "Terminal: <shell>" + close button.
- **Diff tab** (future): Shows diff of a modified file.

**Tab bar**: Horizontal scrollable bar at the top of the editor panel. Active tab has a bottom border accent (indigo). Close button (✕) on each tab. "+" button to open a new terminal or browse for a file.

**Editor content area**:
- Phase 1: CodeMirror 6 in **read-only mode** with syntax highlighting. Language detected from file extension.
- Status bar at bottom: language mode, encoding (UTF-8), line:col, file size.
- Phase 2: Switch to **editable** CodeMirror 6. Add save (Ctrl+S), find (Ctrl+F).

**Terminal content**:
- Reuses `Terminal.tsx` + `useTerminalSocket.ts`. Each terminal tab gets its own PTY session via RPC.
- Terminals run on the selected machine, independent of any AI session.

### 4.5 Right Panel: Session List + Chat

#### Session List

**File**: `web/src/components/editor/EditorSessionList.tsx`

Adapted from `SessionList.tsx`, filtered to sessions belonging to the selected project (matching `metadata.path` or `metadata.worktree.basePath`).

- Each session item shows:
  - Status dot (green=active, gray=inactive, yellow=thinking, amber=waiting approval)
  - Session title (truncated)
  - Agent label (Claude/Codex/Gemini)
  - Model name (compact)
  - Effort level (if applicable)
  - Relative time ("5m ago")
  - Permission mode badge
- Click to select → activates session for chat
- "+ New" button → creates a new session with project path pre-filled
- Scrollable container (max-height ~180px, then chat panel takes remaining space)

#### Chat Panel

Reuses `SessionChat.tsx` with `compactMode={true}` and `hideHeader={true}`. Session-specific header (title, status) is shown above the chat messages area within the right panel.

All features preserved:
- Message streaming (SSE)
- File attachments
- Permission mode selector
- Model selector
- Effort selector
- Slash commands & skills autocomplete
- Context size indicator
- Pending/queued message indicators

Voice and terminal features are hidden (`disableVoice={true}`, hide terminal button) since terminal is handled via editor tabs.

### 4.6 Context Menu & "Add to Chat"

**Flow**:
1. User selects one or more files/folders in the file tree (Ctrl/Cmd+click).
2. Right-click → "Add to Chat".
3. System checks if a session is currently active (selected) in the right panel.
4. If yes: appends `@file:<path>` for each selected file to the composer input of that session.
5. If no active session: auto-creates a new session with:
   - Machine = currently selected machine
   - Directory = project root
   - Agent flavor = default (user's last used flavor)
   - Permission mode = default
6. The new session becomes the active session. File paths pre-populate the composer.

### 4.7 New Session in Editor Mode

**File**: Reuses `NewSession.tsx` or inline form.

When creating a new session from the "+ New" button:
- Machine pre-filled from editor context
- Directory pre-filled from project path
- Can change agent flavor, model, permission mode before creating
- After creation, session appears in the list and becomes active

## 5. Data Flow

### Directory Tree (file browsing)

```
Web (EditorFileTree)
  → GET /api/editor/directory?machine=<id>&path=<project>/src
    → Hub
      → RPC to CLI on machine: list-directory
        → CLI reads filesystem
      ← Returns entries (name, type, size, gitStatus)
    ← Hub
  ← Web renders tree nodes
```

This requires a new hub endpoint or extends existing RPC. The existing `MachineDirectoryEntry` type already supports directory listing (used in WorkspaceBrowser). Git status can be obtained via `git status --porcelain` on the project root, cached for the session.

### File Reading (Phase 1)

```
Web (EditorContent)
  → GET /api/editor/file?machine=<id>&path=<abs-path>
    → Hub
      → RPC "read-file" to CLI
        → CLI reads file content
      ← Returns base64 content
    ← Hub
  ← Web decodes, syntax highlights with Shiki/CodeMirror
```

Can potentially reuse `GET /api/sessions/:id/file?path=...` if a session exists on that machine. For editor mode, a lightweight session-less RPC is preferred (or a dedicated background session).

### Session Chat

Unchanged from existing flow:
```
Web (SessionChat)
  → POST /api/sessions/:id/messages
    → Hub → Socket.IO → CLI agent
  ← SSE streaming back
```

### Terminal

Uses existing terminal infrastructure via Socket.IO, but keyed to machine + editor session instead of AI session.

## 6. API Additions

### Hub Endpoints (new)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/editor/directory?machine=&path=` | List directory on machine |
| `GET` | `/api/editor/file?machine=&path=` | Read file content on machine |
| `GET` | `/api/editor/projects?machine=` | List project directories (git repos) on machine |

### CLI RPC Handlers (new)

| Handler | Purpose |
|---------|---------|
| `rpc-editor-list-dir` | List directory contents with git status |
| `rpc-editor-read-file` | Read file content (base64) |
| `rpc-editor-list-projects` | Find git repos or specified directories |

### Socket.IO Events (new)

| Event | Direction | Purpose |
|-------|-----------|---------|
| `editor:terminal:create` | Web→Hub→CLI | Create PTY for editor terminal |
| `editor:terminal:write` | Web→Hub→CLI | Write to editor terminal |
| `editor:terminal:close` | Web→Hub→CLI | Close editor terminal |

## 7. Reuse Map

| Existing Component/Module | Used In | Notes |
|---|---|---|
| `DirectoryTree.tsx` | EditorFileTree | As-is; add git status indicators |
| `FileIcon.tsx` | EditorFileTree, EditorTabs | Already has color-per-extension |
| `SessionChat.tsx` | Right panel chat | Used with `compactMode`, `hideHeader`, `disableVoice` |
| `SessionList.tsx` logic | EditorSessionList | Extract/filter logic; add project filter |
| `SessionHeader.tsx` | Chat panel header | Use inline or slimmed version |
| `WorkspaceBrowser.tsx` logic | Project selector | Reuse machine browsing + directory loading |
| `useSidebarResize.ts` | Layout resize handles | As-is |
| `useSSE.ts` | Real-time sync | As-is |
| `useMessages.ts` | Chat messages | As-is |
| `useSendMessage.ts` | Send chat | As-is |
| `useSessions.ts` | Session list | Add project filter |
| `useSessionActions.ts` | Session CRUD | As-is |
| `api/client.ts` | API calls | Add editor endpoints |
| `message-window-store.ts` | Message cache | As-is |
| `Terminal.tsx` | Editor terminal tabs | As-is |
| `useTerminalSocket.ts` | Terminal PTY | Extend for editor context |
| `CodeBlock.tsx`, `MarkdownRenderer.tsx` | Chat messages | As-is |
| CSS variables (`index.css`) | Entire UI | Share theme with Dashboard |

## 8. What We Build New

| Component | Effort | Notes |
|---|---|---|
| `EditorPage` (route + layout) | 1 day | Flexbox layout, resize handles, state management |
| `EditorHeader` | 0.5 day | Machine + project selectors |
| `EditorFileTree` | 1 day | DirectoryTree wrapper + context menu + git status |
| `EditorTabs` + `EditorTabBar` | 1 day | Tab system, open/close/switch |
| `EditorContent` (CodeMirror viewer) | 1 day | CodeMirror 6 read-only + syntax highlight |
| `EditorSessionList` | 0.5 day | Session list filtered by project |
| Context menu + "Add to Chat" | 0.5 day | Right-click handler + composer integration |
| Hub API endpoints (editor/*) | 1 day | Directory listing, file reading, project listing |
| CLI RPC handlers | 0.5 day | File system operations |
| Editor terminal integration | 0.5 day | PTY creation per editor tab |

**Total Phase 1**: ~7-9 days

## 9. Phase 2 (Future)

- **Full editing**: CodeMirror 6 editable mode, save via RPC, Ctrl+S.
- **File write API**: `POST /api/editor/file/write?machine=&path=` → RPC to CLI agent.
- **Diff view**: Inline diff display for modified files.
- **Auto-save**: Debounced auto-save on edit.
- **Conflict resolution**: If AI edits a file while user is editing, show conflict dialog.
- **Multi-cursor / collaborative hints**: Show which files AI is currently modifying.
- **Monaco Editor** (optional): Replace CodeMirror if richer editing features are needed.

## 10. Non-Goals

- **Real-time collaboration** (multiple users editing same file)
- **Project-level settings/config** (beyond what session metadata provides)
- **Mobile/tablet responsive layout** for editor mode
- **Plugin/extension system** for the editor
- **Integrated debugger**

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| SessionChat is too heavy for right panel | Med | `compactMode` + `hideHeader` flags already exist on SessionChat. Verified in Dashboard's PinnedPanel usage. |
| File read/write without active session | Med | Create a lightweight "editor session" (background agent) on the machine for file ops. Or use direct RPC without session context. |
| Git status performance on large repos | Low | Cache git status per project; refresh on demand (refresh button). Use `git status --porcelain` which is fast. |
| CodeMirror 6 bundle size | Low | CodeMirror 6 is modular (~200KB gzipped for basic setup). Far smaller than Monaco (~5MB). |
| Two separate pages (Agent vs Editor) feel disconnected | Low | "Open in Editor" / "Agent Mode →" buttons provide bidirectional navigation. Shared data (sessions, messages) keeps context. |

## 12. Confirmed Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **File ops via session-less RPC** | Editor mode shouldn't require a running agent. Directory listing and file reading use direct RPC from hub to CLI on the selected machine. |
| 2 | **Project selector shows git repos only** | Reuses existing WorkspaceBrowser logic which already lists git repos. Any directory can be reached by typing a path manually (future). |
| 3 | **AI-modified file notification** | When a file open in the editor is modified by an AI session (via chat in the right panel), show a subtle banner: "This file was modified by [session name] — [Reload]" with a reload button. |
| 4 | **Terminal is a panel under the editor only** | Terminal sits below the center editor column, with its own tab bar. It does NOT extend into the file tree or sessions+chat panels. The panels on left and right span full height.
