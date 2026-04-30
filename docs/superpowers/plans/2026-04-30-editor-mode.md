# Editor Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an IDE-like Editor Mode (`/editor`) to HAPI with 3-column layout (file tree + editor with tabs + sessions/chat), terminal panel below editor, CodeMirror 6 code viewer, project/machine selectors, and context menu "Add to Chat".

**Architecture:** New route `/editor` with its own layout. Reuses existing components (SessionChat, DirectoryTree, FileIcon, TerminalView, useTerminalSocket, useSidebarResize, API client, SSE) with minimal modifications. New hub endpoints for file ops via session-less RPC. Library: `@codemirror/view`, `@codemirror/state`, `@codemirror/lang-*`.

**Tech Stack:** React 19, TanStack Router, TanStack Query, CodeMirror 6, xterm.js, Tailwind CSS 4, Hono, Socket.IO

---

## File Structure

```
web/src/
├── routes/
│   └── editor.tsx                          # Editor route page (NEW)
├── components/
│   └── editor/
│       ├── EditorLayout.tsx                # Main 3-col + terminal layout (NEW)
│       ├── EditorHeader.tsx                # Machine + project selectors (NEW)
│       ├── EditorFileTree.tsx              # File tree with git status (NEW)
│       ├── EditorTabs.tsx                  # Tab system + CodeMirror (NEW)
│       ├── EditorSessionList.tsx          # Session list filtered by project (NEW)
│       ├── EditorTerminal.tsx             # Terminal panel below editor (NEW)
│       └── EditorContextMenu.tsx          # Right-click menu (NEW)
├── hooks/
│   ├── useEditorState.ts                  # Central editor state (NEW)
│   └── queries/
│       └── useProjectDirectory.ts         # Directory listing for editor (NEW)
├── api/
│   └── client.ts                           # Add editor API methods (MODIFY)
├── router.tsx                              # Add /editor route (MODIFY)
└── index.css                               # Add editor CSS variables if needed (MODIFY)

hub/src/
├── web/
│   ├── routes/
│   │   └── editor.ts                       # Editor API endpoints (NEW)
│   └── index.ts                            # Register editor routes (MODIFY)
└── sync/
    ├── rpcGateway.ts                       # Add machine-level RPC (MODIFY)
    └── syncEngine.ts                       # Add editor file ops (MODIFY)

cli/src/
└── modules/
    └── editorRpc.ts                        # CLI-side file ops handlers (NEW)
```

---

### Task 1: Install CodeMirror 6 dependencies

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Add CodeMirror packages**

```bash
cd /home/huynq/notebooks/hapi/web && bun add @codemirror/view @codemirror/state @codemirror/language @codemirror/commands @codemirror/search @codemirror/lang-javascript @codemirror/lang-typescript @codemirror/lang-json @codemirror/lang-css @codemirror/lang-html @codemirror/lang-markdown @codemirror/lang-python @codemirror/lang-rust @codemirror/lang-go @codemirror/theme-one-dark
```

Run: `cd /home/huynq/notebooks/hapi/web && bun add @codemirror/view @codemirror/state @codemirror/language @codemirror/commands @codemirror/search @codemirror/lang-javascript @codemirror/lang-typescript @codemirror/lang-json @codemirror/lang-css @codemirror/lang-html @codemirror/lang-markdown @codemirror/lang-python @codemirror/lang-rust @codemirror/lang-go @codemirror/theme-one-dark`

Expected: Packages installed, `package.json` and `bun.lockb` updated.

- [ ] **Step 2: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add web/package.json web/bun.lockb && git commit -m "deps: add CodeMirror 6 packages for editor mode"
```

---

### Task 2: Add editor API methods to ApiClient

**Files:**
- Modify: `web/src/api/client.ts`
- Modify: `web/src/types/api.ts`

- [ ] **Step 1: Add response types to web/src/types/api.ts**

Append at end of file:

```typescript
// ─── Editor Mode Types ────────────────────────────────────────────────────────

export type EditorDirectoryResponse = {
    success: boolean
    entries?: Array<{
        name: string
        type: 'file' | 'directory' | 'other'
        size?: number
        modified?: number
        gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
    }>
    error?: string
}

export type EditorFileResponse = {
    success: boolean
    content?: string    // base64 encoded
    size?: number
    error?: string
}

export type EditorProjectsResponse = {
    success: boolean
    projects?: Array<{
        path: string
        name: string
        hasGit: boolean
    }>
    error?: string
}
```

- [ ] **Step 2: Add methods to web/src/api/client.ts**

After `getMachineCodexModels`, add:

```typescript
    async listEditorDirectory(
        machineId: string,
        path: string
    ): Promise<EditorDirectoryResponse> {
        return await this.request<EditorDirectoryResponse>(
            `/api/editor/directory`,
            {
                method: 'POST',
                body: JSON.stringify({ machineId, path })
            }
        )
    }

    async readEditorFile(
        machineId: string,
        path: string
    ): Promise<EditorFileResponse> {
        return await this.request<EditorFileResponse>(
            `/api/editor/file`,
            {
                method: 'POST',
                body: JSON.stringify({ machineId, path })
            }
        )
    }

    async listEditorProjects(
        machineId: string
    ): Promise<EditorProjectsResponse> {
        return await this.request<EditorProjectsResponse>(
            `/api/editor/projects`,
            {
                method: 'POST',
                body: JSON.stringify({ machineId })
            }
        )
    }

    async getEditorGitStatus(
        machineId: string,
        projectPath: string
    ): Promise<EditorGitStatusResponse> {
        return await this.request<EditorGitStatusResponse>(
            `/api/editor/git-status`,
            {
                method: 'POST',
                body: JSON.stringify({ machineId, path: projectPath })
            }
        )
    }
```

Also import types at top:
```typescript
import type {
    // ... existing imports
    EditorDirectoryResponse,
    EditorFileResponse,
    EditorProjectsResponse,
    EditorGitStatusResponse,
} from '@/types/api'
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/web && bun run typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add web/src/api/client.ts web/src/types/api.ts && git commit -m "feat(editor): add editor API methods to ApiClient"
```

---

### Task 3: Create hub editor API endpoints

**Files:**
- Create: `hub/src/web/routes/editor.ts`
- Modify: `hub/src/web/index.ts`

- [ ] **Step 1: Create hub/src/web/routes/editor.ts**

```typescript
import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const directoryBodySchema = z.object({
    machineId: z.string().min(1),
    path: z.string().default('/')
})

const fileBodySchema = z.object({
    machineId: z.string().min(1),
    path: z.string().min(1)
})

const projectsBodySchema = z.object({
    machineId: z.string().min(1)
})

const gitStatusBodySchema = z.object({
    machineId: z.string().min(1),
    path: z.string().min(1)
})

export function createEditorRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/editor/directory', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = directoryBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listEditorDirectory(parsed.data.machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list directory'
            }, 500)
        }
    })

    app.post('/editor/file', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = fileBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.readEditorFile(parsed.data.machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read file'
            }, 500)
        }
    })

    app.post('/editor/projects', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = projectsBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listEditorProjects(parsed.data.machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list projects'
            }, 500)
        }
    })

    app.post('/editor/git-status', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = gitStatusBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.getEditorGitStatus(parsed.data.machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get git status'
            }, 500)
        }
    })

    return app
}
```

- [ ] **Step 2: Register routes in hub/src/web/index.ts**

Find the line where routes are mounted (search for `createMachinesRoutes` or similar pattern) and add:

```typescript
import { createEditorRoutes } from './routes/editor'

// ... inside the routes setup function:
app.route('/api', createEditorRoutes(getSyncEngine))
```

Run to find exact registration pattern:
```bash
grep -n "createMachinesRoutes\|app.route" /home/huynq/notebooks/hapi/hub/src/web/index.ts
```

Expected: Find the pattern, add `app.route('/api', createEditorRoutes(getSyncEngine))` after the existing `createMachinesRoutes` line.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/hub && bun run typecheck
```

Expected: May fail with missing methods on SyncEngine (to be added in next task). That's OK for now — fix forward-refs with `as any` temporarily or leave it.

- [ ] **Step 4: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add hub/src/web/routes/editor.ts hub/src/web/index.ts && git commit -m "feat(editor): add hub editor API endpoints"
```

---

### Task 4: Add editor RPC methods to hub SyncEngine + RpcGateway

**Files:**
- Modify: `hub/src/sync/rpcGateway.ts`
- Modify: `hub/src/sync/syncEngine.ts`

- [ ] **Step 1: Add methods to hub/src/sync/rpcGateway.ts**

After the `listDirectory` method, add:

```typescript
    // ─── Editor Mode RPC ─────────────────────────────────────────────────

    async editorListDirectory(machineId: string, path: string): Promise<RpcListDirectoryResponse> {
        const result = await this.machineRpc(machineId, 'editor-list-directory', { path }) as RpcListDirectoryResponse | unknown
        if (!result || typeof result !== 'object') {
            return { success: false, error: 'Unexpected editor-list-directory result' }
        }
        return result as RpcListDirectoryResponse
    }

    async editorReadFile(machineId: string, path: string): Promise<RpcReadFileResponse> {
        const result = await this.machineRpc(machineId, 'editor-read-file', { path }) as RpcReadFileResponse | unknown
        if (!result || typeof result !== 'object') {
            return { success: false, error: 'Unexpected editor-read-file result' }
        }
        return result as RpcReadFileResponse
    }

    async editorListProjects(machineId: string): Promise<{ success: boolean; projects?: Array<{ path: string; name: string; hasGit: boolean }>; error?: string }> {
        const result = await this.machineRpc(machineId, 'editor-list-projects', {}) as Record<string, unknown> | unknown
        if (!result || typeof result !== 'object') {
            return { success: false, error: 'Unexpected editor-list-projects result' }
        }
        const obj = result as Record<string, unknown>
        return {
            success: obj.success === true,
            projects: Array.isArray(obj.projects) ? obj.projects as Array<{ path: string; name: string; hasGit: boolean }> : undefined,
            error: typeof obj.error === 'string' ? obj.error : undefined
        }
    }

    async editorGitStatus(machineId: string, path: string): Promise<RpcCommandResponse> {
        const result = await this.machineRpc(machineId, 'editor-git-status', { path }) as RpcCommandResponse | unknown
        if (!result || typeof result !== 'object') {
            return { success: false, error: 'Unexpected editor-git-status result' }
        }
        return result as RpcCommandResponse
    }
```

- [ ] **Step 2: Add public methods to hub/src/sync/syncEngine.ts**

After the `listDirectory` method, add:

```typescript
    async listEditorDirectory(machineId: string, path: string) {
        return await this.rpcGateway.editorListDirectory(machineId, path)
    }

    async readEditorFile(machineId: string, path: string) {
        return await this.rpcGateway.editorReadFile(machineId, path)
    }

    async listEditorProjects(machineId: string) {
        return await this.rpcGateway.editorListProjects(machineId)
    }

    async getEditorGitStatus(machineId: string, path: string) {
        return await this.rpcGateway.editorGitStatus(machineId, path)
    }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/hub && bun run typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add hub/src/sync/rpcGateway.ts hub/src/sync/syncEngine.ts && git commit -m "feat(editor): add editor RPC methods to hub"
```

---

### Task 5: Create CLI editor RPC handlers

**Files:**
- Create: `cli/src/modules/editorRpc.ts`
- Modify: `cli/src/index.ts` (or wherever RPC handlers are registered)

- [ ] **Step 1: Create cli/src/modules/editorRpc.ts**

```typescript
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, relative, basename } from 'node:path'
import { execSync } from 'node:child_process'
import type { Socket } from 'socket.io-client'

type RpcDirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
    gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
}

type FileReadResult = {
    success: boolean
    content?: string  // base64
    size?: number
    error?: string
}

type ListDirectoryResult = {
    success: boolean
    entries?: RpcDirectoryEntry[]
    error?: string
}

// Cache git status per directory to avoid repeated git calls
const gitStatusCache = new Map<string, { timestamp: number; statuses: Map<string, string> }>()
const GIT_STATUS_TTL = 5000 // 5 seconds

function getGitStatuses(repoRoot: string): Map<string, string> {
    const cached = gitStatusCache.get(repoRoot)
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_TTL) {
        return cached.statuses
    }

    const statusMap = new Map<string, string>()
    try {
        const output = execSync('git status --porcelain', {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        for (const line of output.trim().split('\n')) {
            if (!line) continue
            const statusCode = line.substring(0, 2).trim()
            const filePath = line.substring(3).trim()
            // Map git status codes to our simplified statuses
            const statusMap2: Record<string, string> = {
                'M': 'modified',
                'A': 'added',
                'D': 'deleted',
                'R': 'renamed',
                '??': 'untracked',
                'AM': 'added',
                'MM': 'modified',
            }
            const s = statusMap2[statusCode] || 'modified'
            statusMap.set(filePath, s)
        }
    } catch {
        // Not a git repo or git not available — leave empty
    }

    gitStatusCache.set(repoRoot, { timestamp: Date.now(), statuses: statusMap })
    return statusMap
}

function isTextFile(path: string): boolean {
    // Quick check: try reading first 512 bytes, look for null bytes
    try {
        const fd = readFileSync(path)
        if (fd.length === 0) return true
        const sample = fd.subarray(0, Math.min(512, fd.length))
        return !sample.includes(0)
    } catch {
        return false
    }
}

function isPathSafe(userPath: string, baseDir: string): boolean {
    const resolved = resolve(baseDir, userPath)
    const normalizedBase = resolve(baseDir)
    return resolved.startsWith(normalizedBase)
}

export function registerEditorRpcHandlers(socket: Socket, homeDir: string) {
    socket.on('rpc-request', async (data: unknown) => {
        const request = data as {
            id: string
            method: string
            params: Record<string, unknown>
        } | null
        if (!request || !request.id) return

        const { id, method, params } = request

        let result: unknown

        try {
            switch (method) {
                case 'editor-list-directory': {
                    const dirPath = resolve(String(params.path || homeDir))
                    if (!isPathSafe(dirPath, homeDir)) {
                        result = { success: false, error: 'Path outside home directory' }
                        break
                    }
                    const entries: RpcDirectoryEntry[] = []
                    try {
                        const items = readdirSync(dirPath)
                        // Get git status if we're in a git repo
                        let gitStatuses: Map<string, string> | null = null
                        try {
                            gitStatuses = getGitStatuses(dirPath)
                        } catch { /* not a git repo */ }
                        
                        for (const name of items) {
                            if (name.startsWith('.') && name !== '.git') continue // skip hidden except .git
                            const fullPath = resolve(dirPath, name)
                            try {
                                const stat = statSync(fullPath)
                                const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
                                const relativePath = relative(dirPath, fullPath)
                                const gitStatus = gitStatuses?.get(relativePath) || (gitStatuses?.get(name)) || undefined
                                entries.push({
                                    name,
                                    type,
                                    size: stat.size,
                                    modified: stat.mtimeMs,
                                    gitStatus: gitStatus as RpcDirectoryEntry['gitStatus']
                                })
                            } catch {
                                // Permission denied or other error, skip
                            }
                        }
                        // Sort: directories first, then files, alphabetically
                        entries.sort((a, b) => {
                            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
                            return a.name.localeCompare(b.name)
                        })
                    } catch (err) {
                        result = { success: false, error: String(err) }
                        break
                    }
                    result = { success: true, entries }
                    break
                }

                case 'editor-read-file': {
                    const filePath = resolve(String(params.path || ''))
                    if (!filePath || !isPathSafe(filePath, homeDir)) {
                        result = { success: false, error: 'Path outside home directory' }
                        break
                    }
                    if (!isTextFile(filePath)) {
                        result = { success: false, error: 'Cannot read binary file' }
                        break
                    }
                    try {
                        const content = readFileSync(filePath)
                        const base64 = content.toString('base64')
                        result = { success: true, content: base64, size: content.length }
                    } catch (err) {
                        result = { success: false, error: String(err) }
                    }
                    break
                }

                case 'editor-list-projects': {
                    // Find git repos in home directory (shallow scan, max 3 levels)
                    const projects: Array<{ path: string; name: string; hasGit: boolean }> = []
                    const skipDirs = new Set(['node_modules', '.git', 'Library', 'Applications', 'Desktop', 'Downloads', 'Documents', 'Music', 'Pictures', 'Videos', '.cache', '.npm', '.cargo', '.local', '.m2', '.gradle'])
                    
                    function scanDir(dir: string, depth: number) {
                        if (depth > 3) return
                        try {
                            const items = readdirSync(dir)
                            for (const name of items) {
                                if (skipDirs.has(name)) continue
                                if (name.startsWith('.')) continue
                                const fullPath = resolve(dir, name)
                                try {
                                    const stat = statSync(fullPath)
                                    if (!stat.isDirectory()) continue
                                    // Check if it's a git repo
                                    try {
                                        statSync(resolve(fullPath, '.git'))
                                        projects.push({ path: fullPath, name, hasGit: true })
                                    } catch {
                                        // Not a git repo, but still list it as dir
                                        if (depth < 2) {
                                            projects.push({ path: fullPath, name, hasGit: false })
                                        }
                                        // Recurse to find nested git repos
                                        scanDir(fullPath, depth + 1)
                                    }
                                } catch { /* skip permission errors */ }
                            }
                        } catch { /* skip */ }
                    }
                    scanDir(homeDir, 0)
                    // Sort: git repos first, then alphabetically
                    projects.sort((a, b) => {
                        if (a.hasGit !== b.hasGit) return a.hasGit ? -1 : 1
                        return a.name.localeCompare(b.name)
                    })
                    result = { success: true, projects }
                    break
                }

                case 'editor-git-status': {
                    const repoPath = resolve(String(params.path || homeDir))
                    try {
                        const output = execSync('git status --porcelain', {
                            cwd: repoPath,
                            encoding: 'utf-8',
                            timeout: 5000,
                            stdio: ['ignore', 'pipe', 'pipe']
                        })
                        result = { success: true, stdout: output }
                    } catch (err) {
                        result = { success: false, error: String(err) }
                    }
                    break
                }

                default:
                    // Not our handler
                    return
            }
        } catch (err) {
            result = { success: false, error: String(err) }
        }

        // Send result back
        socket.emit('rpc-result', { id, result })
    })
}
```

- [ ] **Step 2: Register handlers in CLI**

Find where RPC handlers are registered in `cli/src/`:

```bash
grep -rn "rpc-register\|registerRpc\|rpc.*handler" /home/huynq/notebooks/hapi/cli/src/ | head -10
```

Expected: Find the pattern. Import and call `registerEditorRpcHandlers(socket, homeDir)` where other RPC handlers are registered.

If the CLI has a centralized RPC registration:

```typescript
import { registerEditorRpcHandlers } from './modules/editorRpc'

// After socket connection and other RPC handlers:
registerEditorRpcHandlers(socket, homeDir)
```

If RPC is handled differently (e.g., individual `rpc-register` events), adapt accordingly by checking `cli/src/socket/` or `cli/src/api/` for the RPC event handler pattern.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/cli && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add cli/src/modules/editorRpc.ts && git commit -m "feat(editor): add CLI editor RPC handlers"
```

---

### Task 6: Create useEditorState hook

**Files:**
- Create: `web/src/hooks/useEditorState.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useCallback, useState } from 'react'
import { useSearch } from '@tanstack/react-router'

export type EditorTab = {
    id: string
    type: 'file' | 'terminal'
    path?: string        // file path for file tabs
    label: string
    shell?: string       // shell type for terminal tabs
}

export type EditorState = {
    // Machine + project from URL or user selection
    machineId: string | null
    projectPath: string | null
    
    // Tabs
    tabs: EditorTab[]
    activeTabId: string | null
    
    // Active session for chat
    activeSessionId: string | null
    
    // Context menu
    contextMenuFile: string | null
    contextMenuPosition: { x: number; y: number } | null
}

function generateTabId(): string {
    return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function useEditorState(initialMachine?: string, initialProject?: string) {
    const [machineId, setMachineId] = useState<string | null>(initialMachine ?? null)
    const [projectPath, setProjectPath] = useState<string | null>(initialProject ?? null)
    const [tabs, setTabs] = useState<EditorTab[]>([])
    const [activeTabId, setActiveTabId] = useState<string | null>(null)
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
    const [contextMenuFile, setContextMenuFile] = useState<string | null>(null)
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)

    const openFile = useCallback((filePath: string) => {
        const fileName = filePath.split('/').pop() || filePath
        const existingTab = tabs.find(t => t.type === 'file' && t.path === filePath)
        if (existingTab) {
            setActiveTabId(existingTab.id)
            return
        }
        const newTab: EditorTab = {
            id: generateTabId(),
            type: 'file',
            path: filePath,
            label: fileName
        }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(newTab.id)
    }, [tabs])

    const openTerminal = useCallback((shell?: string) => {
        const shellName = shell || 'bash'
        const terminalCount = tabs.filter(t => t.type === 'terminal').length
        const newTab: EditorTab = {
            id: generateTabId(),
            type: 'terminal',
            label: `Terminal: ${shellName}${terminalCount > 0 ? ` (${terminalCount + 1})` : ''}`,
            shell: shellName
        }
        setTabs(prev => [...prev, newTab])
        setActiveTabId(newTab.id)
    }, [tabs])

    const closeTab = useCallback((tabId: string) => {
        setTabs(prev => {
            const newTabs = prev.filter(t => t.id !== tabId)
            if (activeTabId === tabId && newTabs.length > 0) {
                // Activate the tab to the right, or the last tab
                const closedIndex = prev.findIndex(t => t.id === tabId)
                const nextIndex = Math.min(closedIndex, newTabs.length - 1)
                setActiveTabId(newTabs[nextIndex].id)
            } else if (newTabs.length === 0) {
                setActiveTabId(null)
            }
            return newTabs
        })
    }, [activeTabId])

    const showContextMenu = useCallback((filePath: string, x: number, y: number) => {
        setContextMenuFile(filePath)
        setContextMenuPosition({ x, y })
    }, [])

    const hideContextMenu = useCallback(() => {
        setContextMenuFile(null)
        setContextMenuPosition(null)
    }, [])

    const selectMachine = useCallback((id: string) => {
        setMachineId(id)
        setProjectPath(null)
        setTabs([])
        setActiveTabId(null)
    }, [])

    const selectProject = useCallback((path: string) => {
        setProjectPath(path)
    }, [])

    return {
        machineId,
        projectPath,
        tabs,
        activeTabId,
        activeSessionId,
        contextMenuFile,
        contextMenuPosition,
        selectMachine,
        selectProject,
        setActiveSessionId,
        openFile,
        openTerminal,
        closeTab,
        setActiveTabId,
        showContextMenu,
        hideContextMenu
    }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/web && bun run typecheck
```

Expected: No errors (or errors only about unused imports in the file, which is fine).

- [ ] **Step 3: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add web/src/hooks/useEditorState.ts && git commit -m "feat(editor): add useEditorState hook"
```

---

### Task 7: Create useProjectDirectory query hook

**Files:**
- Create: `web/src/hooks/queries/useProjectDirectory.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { EditorDirectoryResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useProjectDirectory(
    api: ApiClient | null,
    machineId: string | null,
    path: string | null
): {
    entries: NonNullable<EditorDirectoryResponse['entries']>
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const enabled = Boolean(api && machineId && path)

    const query = useQuery({
        queryKey: ['editor', 'directory', machineId, path],
        queryFn: async () => {
            if (!api || !machineId || !path) {
                throw new Error('Missing machineId or path')
            }
            const response = await api.listEditorDirectory(machineId, path)
            if (!response.success) {
                return { entries: [], error: response.error ?? 'Failed to list directory' }
            }
            return { entries: response.entries ?? [], error: null }
        },
        enabled,
    })

    const queryError = query.error instanceof Error
        ? query.error.message
        : query.error
            ? 'Failed to list directory'
            : null

    return {
        entries: query.data?.entries ?? [],
        error: queryError ?? query.data?.error ?? null,
        isLoading: query.isLoading,
        refetch: query.refetch
    }
}
```

- [ ] **Step 2: Also create useEditorFile hook**

Create `web/src/hooks/queries/useEditorFile.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'

export function useEditorFile(
    api: ApiClient | null,
    machineId: string | null,
    filePath: string | null
): {
    content: string | null
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const enabled = Boolean(api && machineId && filePath)

    const query = useQuery({
        queryKey: ['editor', 'file', machineId, filePath],
        queryFn: async () => {
            if (!api || !machineId || !filePath) {
                throw new Error('Missing parameters')
            }
            const response = await api.readEditorFile(machineId, filePath)
            if (!response.success || !response.content) {
                return { content: null, error: response.error ?? 'Failed to read file' }
            }
            // Decode base64
            try {
                const decoded = atob(response.content)
                return { content: decoded, error: null }
            } catch {
                return { content: null, error: 'Failed to decode file content' }
            }
        },
        enabled,
    })

    return {
        content: query.data?.content ?? null,
        error: query.error instanceof Error ? query.error.message : query.data?.error ?? null,
        isLoading: query.isLoading,
        refetch: query.refetch
    }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/web && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add web/src/hooks/queries/useProjectDirectory.ts web/src/hooks/queries/useEditorFile.ts && git commit -m "feat(editor): add directory and file query hooks"
```

---

### Task 8: Create EditorHeader component

**Files:**
- Create: `web/src/components/editor/EditorHeader.tsx`

- [ ] **Step 1: Create EditorHeader**

```typescript
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useMachines } from '@/hooks/queries/useMachines'
import { useTranslation } from '@/lib/use-translation'

function getMachineLabel(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id.slice(0, 8)
}

export function EditorHeader(props: {
    api: ApiClient
    machineId: string | null
    projectPath: string | null
    onSelectMachine: (machineId: string) => void
    onSelectProject: (projectPath: string) => void
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { machines, isLoading: machinesLoading } = useMachines(props.api, true)
    const [projects, setProjects] = useState<Array<{ path: string; name: string; hasGit: boolean }>>([])
    const [projectsLoading, setProjectsLoading] = useState(false)

    // Load projects when machine changes
    useEffect(() => {
        if (!props.machineId) {
            setProjects([])
            return
        }
        setProjectsLoading(true)
        props.api.listEditorProjects(props.machineId)
            .then(res => {
                if (res.success && res.projects) {
                    setProjects(res.projects)
                }
            })
            .catch(() => setProjects([]))
            .finally(() => setProjectsLoading(false))
    }, [props.api, props.machineId])

    const handleMachineChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        props.onSelectMachine(e.target.value)
    }, [props.onSelectMachine])

    const handleProjectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        props.onSelectProject(e.target.value)
    }, [props.onSelectProject])

    return (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] shrink-0">
            <span className="font-semibold text-sm text-[var(--app-fg)] whitespace-nowrap">
                ⚡ HAPI Editor
            </span>

            <span className="text-[var(--app-hint)] text-xs">▸</span>

            <select
                value={props.machineId ?? ''}
                onChange={handleMachineChange}
                disabled={machinesLoading}
                className="bg-[var(--app-bg)] text-[var(--app-fg)] border border-[var(--app-border)] rounded-md px-2 py-1 text-xs min-w-0 max-w-[200px] truncate"
            >
                <option value="" disabled>{machinesLoading ? 'Loading...' : 'Select machine'}</option>
                {machines.map(m => (
                    <option key={m.id} value={m.id}>
                        🖥 {getMachineLabel(m)}
                    </option>
                ))}
            </select>

            {props.machineId && (
                <>
                    <span className="text-[var(--app-hint)] text-xs">/</span>
                    <select
                        value={props.projectPath ?? ''}
                        onChange={handleProjectChange}
                        disabled={projectsLoading}
                        className="bg-[var(--app-bg)] text-[var(--app-fg)] border border-[var(--app-border)] rounded-md px-2 py-1 text-xs min-w-0 max-w-[280px] truncate"
                    >
                        <option value="" disabled>{projectsLoading ? 'Loading...' : 'Select project'}</option>
                        {projects.map(p => (
                            <option key={p.path} value={p.path}>
                                {p.hasGit ? '📁' : '📂'} {p.name}
                            </option>
                        ))}
                    </select>
                </>
            )}

            <span className="flex-1" />

            <button
                type="button"
                onClick={() => navigate({ to: '/sessions' })}
                className="px-3 py-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] text-xs hover:bg-[var(--app-subtle-bg)] transition-colors"
            >
                ← Agent Mode
            </button>
        </div>
    )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/web && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add web/src/components/editor/EditorHeader.tsx && git commit -m "feat(editor): add EditorHeader component"
```

---

### Task 9: Create EditorFileTree component

**Files:**
- Create: `web/src/components/editor/EditorFileTree.tsx`

- [ ] **Step 1: Create EditorFileTree**

```typescript
import { useCallback, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { EditorDirectoryResponse } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { useProjectDirectory } from '@/hooks/queries/useProjectDirectory'

type TreeEntry = NonNullable<EditorDirectoryResponse['entries']>[number]

function ChevronIcon(props: { collapsed: boolean }) {
    return (
        <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform duration-150 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function FolderIcon(props: { open?: boolean }) {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
            className="text-[var(--app-link)]"
        >
            {props.open ? (
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2H3V7Z" />
            ) : (
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            )}
        </svg>
    )
}

function GitStatusDot(props: { status?: string }) {
    if (!props.status || props.status === 'unmodified') return null
    const color: Record<string, string> = {
        modified: '#f59e0b',
        added: '#22c55e',
        deleted: '#ef4444',
        renamed: '#818cf8',
        untracked: '#f59e0b',
    }
    return (
        <span
            className="inline-block w-1.5 h-1.5 rounded-full ml-1 shrink-0"
            style={{ backgroundColor: color[props.status] ?? '#f59e0b' }}
            title={props.status}
        />
    )
}

function DirectoryNode(props: {
    api: ApiClient | null
    machineId: string
    path: string
    name: string
    depth: number
    onOpenFile: (filePath: string) => void
    onContextMenu: (filePath: string, x: number, y: number) => void
    expanded: Set<string>
    onToggle: (path: string) => void
}) {
    const isExpanded = props.expanded.has(props.path)
    const { entries, isLoading } = useProjectDirectory(props.api, props.machineId, isExpanded ? props.path : null)
    const childDepth = props.depth + 1
    const indent = 8 + props.depth * 16

    const dirs = useMemo(() => entries.filter(e => e.type === 'directory'), [entries])
    const files = useMemo(() => entries.filter(e => e.type === 'file'), [entries])

    const handleContextMenu = useCallback((e: React.MouseEvent, filePath: string) => {
        e.preventDefault()
        e.stopPropagation()
        props.onContextMenu(filePath, e.clientX, e.clientY)
    }, [props.onContextMenu])

    return (
        <div>
            <button
                type="button"
                onClick={() => props.onToggle(props.path)}
                onContextMenu={(e) => handleContextMenu(e, props.path)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--app-subtle-bg)] transition-colors text-xs"
                style={{ paddingLeft: indent }}
            >
                <ChevronIcon collapsed={!isExpanded} />
                <FolderIcon open={isExpanded} />
                <span className="truncate flex-1 text-[var(--app-fg)]">{props.name}</span>
            </button>
            {isExpanded && (
                <div>
                    {isLoading && entries.length === 0 ? (
                        <div className="text-[10px] text-[var(--app-hint)] pl-4 py-1" style={{ paddingLeft: indent + 16 }}>
                            Loading...
                        </div>
                    ) : (
                        <>
                            {dirs.map(e => (
                                <DirectoryNode
                                    key={e.name}
                                    api={props.api}
                                    machineId={props.machineId}
                                    path={`${props.path}/${e.name}`}
                                    name={e.name}
                                    depth={childDepth}
                                    onOpenFile={props.onOpenFile}
                                    onContextMenu={props.onContextMenu}
                                    expanded={props.expanded}
                                    onToggle={props.onToggle}
                                />
                            ))}
                            {files.map(e => (
                                <button
                                    key={e.name}
                                    type="button"
                                    onClick={() => props.onOpenFile(`${props.path}/${e.name}`)}
                                    onContextMenu={(ev) => handleContextMenu(ev, `${props.path}/${e.name}`)}
                                    className="flex w-full items-center gap-1.5 pl-1 pr-2 py-1 text-left hover:bg-[var(--app-subtle-bg)] transition-colors text-xs text-[var(--app-fg)]"
                                    style={{ paddingLeft: indent + 14 }}
                                >
                                    <FileIcon fileName={e.name} size={14} />
                                    <span className="truncate flex-1">{e.name}</span>
                                    <GitStatusDot status={e.gitStatus} />
                                </button>
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

export function EditorFileTree(props: {
    api: ApiClient | null
    machineId: string | null
    projectPath: string | null
    onOpenFile: (filePath: string) => void
    onContextMenu: (filePath: string, x: number, y: number) => void
}) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set())

    const handleToggle = useCallback((path: string) => {
        setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(path)) {
                next.delete(path)
            } else {
                next.add(path)
            }
            return next
        })
    }, [])

    if (!props.machineId || !props.projectPath) {
        return (
            <div className="flex items-center justify-center h-full text-xs text-[var(--app-hint)] p-4 text-center">
                Select a machine and project to browse files
            </div>
        )
    }

    const projectName = props.projectPath.split('/').pop() || props.projectPath

    return (
        <div className="flex flex-col h-full">
            <div className="px-3 py-2 text-xs font-semibold text-[var(--app-fg)] border-b border-[var(--app-border)] shrink-0 flex items-center gap-1.5">
                <FolderIcon open />
                <span className="truncate">{projectName}</span>
            </div>
            <div className="flex-1 overflow-y-auto py-1">
                <DirectoryNode
                    api={props.api}
                    machineId={props.machineId}
                    path={props.projectPath}
                    name={projectName}
                    depth={0}
                    onOpenFile={props.onOpenFile}
                    onContextMenu={props.onContextMenu}
                    expanded={expanded}
                    onToggle={handleToggle}
                />
            </div>
        </div>
    )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/huynq/notebooks/hapi/web && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
cd /home/huynq/notebooks/hapi && git add web/src/components/editor/EditorFileTree.tsx && git commit -m "feat(editor): add EditorFileTree component"
```

---

### Task 10: Create EditorTabs + EditorContent (CodeMirror viewer)

**Status:** Implemented in commit `ab3f796`.

**Files:**
- Created: `web/src/components/editor/EditorTabs.tsx`
- Created: `web/src/components/editor/EditorTabs.test.tsx`

**Notes:** Uses `basicSetup` and `EditorView` from the `codemirror` package plus language packages already installed in Task 1. Phase 1 is read-only viewer.

Verification already run:

```bash
bun run --cwd web vitest run src/components/editor/EditorTabs.test.tsx
bun run --cwd web typecheck
bun run --cwd web test
```

---

## Addendum: Remaining Editor Mode Tasks

> **Purpose:** Complete the functional `/editor` experience after Tasks 1–11. These tasks replace the earlier high-level addendum. Continue TDD: write the failing test first, run it, implement, re-run focused tests, then typecheck and commit each task.

### Task 11: Create EditorSessionList component

**Status:** Implemented in commit `53c4334`.

**Files:**
- Created: `web/src/components/editor/EditorSessionList.tsx`
- Created: `web/src/components/editor/EditorSessionList.test.tsx`

**Behavior implemented:** Compact session list filtered by machine + project path; includes worktree base path matching; `+ New` callback; loading/error/empty states.

Verification already run:

```bash
bun run --cwd web vitest run src/components/editor/EditorSessionList.test.tsx
bun run --cwd web typecheck
bun run --cwd web test
```

---

### Task 12: Create EditorContextMenu component

**Files:**
- Create: `web/src/components/editor/EditorContextMenu.tsx`
- Test: `web/src/components/editor/EditorContextMenu.test.tsx`

**Public API:**

```typescript
export function EditorContextMenu(props: {
    filePath: string | null
    position: { x: number; y: number } | null
    onOpen: (filePath: string) => void
    onAddToChat: (filePath: string) => void
    onCopyPath: (filePath: string) => void | Promise<void>
    onClose: () => void
})
```

**Behavior:**
- Render nothing if `filePath` or `position` is `null`.
- Render fixed-position menu at `left: position.x`, `top: position.y`.
- Actions:
  - `Open in Editor` → `onOpen(filePath)` then `onClose()`.
  - `Add to Chat` → `onAddToChat(filePath)` then `onClose()`.
  - `Copy Path` → await `onCopyPath(filePath)` then `onClose()`.
- Close on Escape.
- Close on outside pointer/mouse down.

**Test cases:**
- Hidden when no file/position.
- Renders all 3 actions at provided coordinates.
- Each action calls its callback with file path and closes.
- Escape and outside click close without invoking actions.

**Verification:**

```bash
bun run --cwd web vitest run src/components/editor/EditorContextMenu.test.tsx
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/components/editor/EditorContextMenu.tsx web/src/components/editor/EditorContextMenu.test.tsx
git commit -m "feat(editor): add EditorContextMenu component"
```

---

### Task 13: Add editor chat draft/prefill plumbing

**Files:**
- Create: `web/src/lib/editor-chat-draft.ts`
- Test: `web/src/lib/editor-chat-draft.test.ts`

**Goal:** Support context-menu “Add to Chat” without coupling `EditorContextMenu` directly to `SessionChat` internals.

**Public API:**

```typescript
export function buildAddFileToChatText(filePath: string): string
export function appendEditorChatDraft(currentDraft: string, filePath: string): string
```

**Behavior:**
- `buildAddFileToChatText('/repo/src/App.tsx')` returns `@/repo/src/App.tsx`.
- `appendEditorChatDraft('', path)` returns the token only.
- `appendEditorChatDraft('Please review', path)` returns `Please review\n@/repo/src/App.tsx`.
- Duplicate file tokens are not appended twice.

**Why this task exists:** The current composer draft system is session-scoped. This lightweight helper gives `EditorLayout` deterministic text to pass into the active chat flow or future composer integration. If direct composer injection proves too invasive, use this helper to create a normal outgoing message when user confirms “Add to Chat”.

**Verification:**

```bash
bun run --cwd web vitest run src/lib/editor-chat-draft.test.ts
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/lib/editor-chat-draft.ts web/src/lib/editor-chat-draft.test.ts
git commit -m "feat(editor): add chat draft helpers"
```

---

### Task 14: Create EditorChatPanel component

**Files:**
- Create: `web/src/components/editor/EditorChatPanel.tsx`
- Test: `web/src/components/editor/EditorChatPanel.test.tsx`

**Public API:**

```typescript
export function EditorChatPanel(props: {
    api: ApiClient | null
    sessionId: string | null
    pendingDraftText?: string
    onDraftConsumed?: () => void
})
```

**Behavior:**
- If `sessionId` is null: show “Select or create a session to chat”.
- Fetch session with `useSession(api, sessionId)`.
- Fetch messages with `useMessages(api, sessionId)`.
- Fetch slash commands and skills with existing hooks using session flavor.
- Send via `useSendMessage(api, sessionId, ...)`.
- Render `SessionChat` with:
  - `compactMode={true}`
  - `hideHeader={true}`
  - `disableVoice={true}`
- Show loading state while session loads.
- If `pendingDraftText` is provided, display a small “Added to chat: …” draft notice with a Send button that calls `sendMessage(pendingDraftText)` then `onDraftConsumed()`.

**Test cases:**
- No session → empty prompt.
- Loading session → loading text.
- Loaded session passes compact/hideHeader props to mocked `SessionChat`.
- Pending draft Send calls mocked `sendMessage` and consumes draft.

**Verification:**

```bash
bun run --cwd web vitest run src/components/editor/EditorChatPanel.test.tsx
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/components/editor/EditorChatPanel.tsx web/src/components/editor/EditorChatPanel.test.tsx
git commit -m "feat(editor): add EditorChatPanel"
```

---

### Task 15: Add editor new-session spawn flow

**Files:**
- Create: `web/src/hooks/mutations/useEditorNewSession.ts`
- Test: `web/src/hooks/mutations/useEditorNewSession.test.tsx`

**Public API:**

```typescript
export function useEditorNewSession(args: {
    api: ApiClient | null
    machineId: string | null
    projectPath: string | null
    onCreated: (sessionId: string) => void
}): {
    createSession: () => void
    isCreating: boolean
    error: string | null
}
```

**Behavior:**
- Block with error if `api`, `machineId`, or `projectPath` missing.
- Call `api.spawnSession(machineId, projectPath, 'codex')` for Phase 1 default agent.
- On `{ type: 'success', sessionId }`, call `onCreated(sessionId)`.
- On error response, expose message.

**Test cases:**
- Missing inputs set an error and do not call API.
- Success calls `spawnSession(machineId, projectPath, 'codex')` and `onCreated`.
- API error response displays message.

**Verification:**

```bash
bun run --cwd web vitest run src/hooks/mutations/useEditorNewSession.test.tsx
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/hooks/mutations/useEditorNewSession.ts web/src/hooks/mutations/useEditorNewSession.test.tsx
git commit -m "feat(editor): add new session spawn hook"
```

---

### Task 16: Create EditorTerminal panel (Phase 1 placeholder)

**Files:**
- Create: `web/src/components/editor/EditorTerminal.tsx`
- Test: `web/src/components/editor/EditorTerminal.test.tsx`

**Scope decision:** The spec asks for machine-level terminal independent of AI sessions. Current terminal backend is session-scoped (`useTerminalSocket` requires `sessionId`). Do **not** fake machine PTY support in this task. Ship a visible terminal panel placeholder and tab controls; add real machine-level PTY as a follow-up backend task.

**Public API:**

```typescript
export function EditorTerminal(props: {
    tabs: EditorTab[]
    activeTabId: string | null
    onSelectTab: (tabId: string) => void
    onCloseTab: (tabId: string) => void
    onOpenTerminal: () => void
})
```

**Behavior:**
- Filter `tabs` to `type === 'terminal'`.
- Render tab bar and active terminal placeholder.
- `+` calls `onOpenTerminal`.
- Empty state: “No terminal open”.

**Verification:**

```bash
bun run --cwd web vitest run src/components/editor/EditorTerminal.test.tsx
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/components/editor/EditorTerminal.tsx web/src/components/editor/EditorTerminal.test.tsx
git commit -m "feat(editor): add EditorTerminal panel"
```

---

### Task 17: Create EditorLayout component

**Files:**
- Create: `web/src/components/editor/EditorLayout.tsx`
- Test: `web/src/components/editor/EditorLayout.test.tsx`

**Public API:**

```typescript
export function EditorLayout(props: {
    api: ApiClient | null
    initialMachineId?: string
    initialProjectPath?: string
})
```

**Behavior:**
- Own editor state via `useEditorState(initialMachineId, initialProjectPath)`.
- Render 3 columns:
  - Left: `EditorFileTree`.
  - Center: `EditorTabs` above `EditorTerminal`.
  - Right: `EditorSessionList` above `EditorChatPanel`.
- Render `EditorHeader` at top.
- Wire file open: tree → `openFile(path)`.
- Wire context menu: tree → state → `EditorContextMenu`.
- Wire context menu “Open” → open file.
- Wire “Copy Path” → `navigator.clipboard.writeText(filePath)`.
- Wire “Add to Chat”:
  - If active session exists: set pending draft text via `appendEditorChatDraft`.
  - If no active session: create new session using Task 15 hook, then set pending draft after creation.
- Use static Phase 1 widths: left 260px, right 380px, terminal 160px.

**Test cases:**
- Renders header/tree/tabs/session list/chat panel areas.
- Opening file from mocked tree creates an editor tab.
- Context menu Copy Path calls clipboard.
- Add to Chat without active session calls create session path; with active session sets draft.

**Verification:**

```bash
bun run --cwd web vitest run src/components/editor/EditorLayout.test.tsx
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/components/editor/EditorLayout.tsx web/src/components/editor/EditorLayout.test.tsx
git commit -m "feat(editor): add EditorLayout"
```

---

### Task 18: Add `/editor` route

**Files:**
- Create: `web/src/routes/editor.tsx`
- Modify: `web/src/router.tsx`
- Test: `web/src/routes/editor.test.tsx`

**Behavior:**
- Create `EditorPage` route component.
- Read search params `machine?: string`, `project?: string`.
- Get `api` from `useAppContext()`.
- Render `EditorLayout api={api} initialMachineId={machine} initialProjectPath={project}`.
- Register route in `web/src/router.tsx` as `/editor`.

**Test cases:**
- Route component passes search params to mocked `EditorLayout`.
- Router contains `/editor` route path.

**Verification:**

```bash
bun run --cwd web vitest run src/routes/editor.test.tsx
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/routes/editor.tsx web/src/routes/editor.test.tsx web/src/router.tsx
git commit -m "feat(editor): add editor route"
```

---

### Task 19: Add “Open in Editor” entry points

**Files:**
- Modify: `web/src/components/SessionHeader.tsx`
- Modify: dashboard/session list component identified during implementation (`web/src/components/Dashboard/index.tsx` or `web/src/components/SessionList.tsx`)
- Test: add focused tests next to modified components.

**Behavior:**
- Session header: if `session.metadata.machineId` and `session.metadata.path` exist, show `Open in Editor` button/link navigating to `/editor?machine=<machineId>&project=<encoded path>`.
- Dashboard project group: if group has machineId + project path, show compact `Open in Editor` action.
- Keep existing Agent Mode navigation unchanged.

**Verification:**

```bash
bun run --cwd web test
bun run --cwd web typecheck
```

**Commit:**

```bash
git add web/src/components/SessionHeader.tsx web/src/components/Dashboard/index.tsx web/src/components/SessionList.tsx
git commit -m "feat(editor): add editor entry points"
```

Only add files actually modified.

---

### Task 20: Final verification and manual smoke checklist

**Files:**
- Modify: `docs/superpowers/plans/2026-04-30-editor-mode.md` if checklist results need recording.

**Automated verification:**

```bash
bun typecheck
bun run test
bun run --cwd web build
```

**Manual smoke checklist:**
- Start hub + web: `bun run dev` from repo root.
- Start runner with workspace root: `hapi runner start --workspace-root /path/to/projects`.
- Navigate to `/editor`.
- Select machine.
- Select project.
- Expand file tree.
- Open a text file; CodeMirror renders content read-only.
- Open context menu on a file.
- Copy Path writes to clipboard.
- Select/create a session in the right panel.
- Add file to chat draft/send flow works.
- Agent Mode button returns to `/sessions`.
- Entry point from session header opens `/editor?machine=...&project=...`.

**Commit (only if docs/checklist updated):**

```bash
git add docs/superpowers/plans/2026-04-30-editor-mode.md
git commit -m "docs(editor): record editor mode verification checklist"
```
