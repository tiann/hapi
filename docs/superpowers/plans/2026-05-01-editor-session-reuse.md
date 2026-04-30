# Editor Session Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse Agent Mode session list/chat behavior in Editor Mode while filtering sessions to the selected project and rendering a flat list.

**Architecture:** Extract project filtering into a shared editor session helper. Extend `SessionList` with an `editor` variant that keeps Agent Mode's session row/actions/search behavior but skips machine/project grouping. Replace the custom `EditorSessionList` row UI with a thin wrapper that fetches sessions, filters by selected machine/project, and renders `SessionList variant="editor"`.

**Tech Stack:** React 19, TanStack Query, TanStack Router, Vitest, TypeScript strict.

---

## File Structure

```
web/src/
├── components/
│   ├── SessionList.tsx                         # add variant="editor" flat rendering (MODIFY)
│   ├── SessionList.test.ts                     # add flat editor variant tests (MODIFY)
│   └── editor/
│       ├── EditorSessionList.tsx               # thin wrapper around SessionList (MODIFY)
│       └── EditorSessionList.test.tsx          # update wrapper/filter tests (MODIFY)
└── lib/
    ├── editor-session-filter.ts                # project session filtering helper (NEW)
    └── editor-session-filter.test.ts           # helper tests (NEW)
```

---

### Task 1: Extract editor project session filter

**Files:**
- Create: `web/src/lib/editor-session-filter.ts`
- Test: `web/src/lib/editor-session-filter.test.ts`
- Modify: `web/src/components/editor/EditorSessionList.tsx`

- [ ] **Step 1: Write failing helper tests**

Create `web/src/lib/editor-session-filter.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { filterSessionsForEditorProject, sessionBelongsToEditorProject } from './editor-session-filter'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('editor session filter', () => {
    it('matches direct project paths, child paths, worktree base paths, and machine ID', () => {
        const direct = makeSession({ id: 'direct', metadata: { path: '/repo', machineId: 'machine-1' } })
        const child = makeSession({ id: 'child', metadata: { path: '/repo/packages/web', machineId: 'machine-1' } })
        const worktree = makeSession({
            id: 'worktree',
            metadata: { path: '/tmp/worktree', machineId: 'machine-1', worktree: { basePath: '/repo' } as never }
        })
        const sibling = makeSession({ id: 'sibling', metadata: { path: '/repo2', machineId: 'machine-1' } })
        const otherMachine = makeSession({ id: 'other', metadata: { path: '/repo', machineId: 'machine-2' } })
        const missingMachine = makeSession({ id: 'missing', metadata: { path: '/repo' } })

        expect(sessionBelongsToEditorProject(direct, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToEditorProject(child, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToEditorProject(worktree, 'machine-1', '/repo')).toBe(true)
        expect(sessionBelongsToEditorProject(sibling, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToEditorProject(otherMachine, 'machine-1', '/repo')).toBe(false)
        expect(sessionBelongsToEditorProject(missingMachine, 'machine-1', '/repo')).toBe(false)
    })

    it('filters and sorts editor sessions with active sessions first, then recent updates', () => {
        const sessions = [
            makeSession({ id: 'old-active', active: true, updatedAt: 10, metadata: { path: '/repo', machineId: 'machine-1' } }),
            makeSession({ id: 'new-inactive', active: false, updatedAt: 30, metadata: { path: '/repo', machineId: 'machine-1' } }),
            makeSession({ id: 'new-active', active: true, updatedAt: 20, metadata: { path: '/repo', machineId: 'machine-1' } }),
            makeSession({ id: 'other', active: true, updatedAt: 100, metadata: { path: '/other', machineId: 'machine-1' } })
        ]

        expect(filterSessionsForEditorProject(sessions, 'machine-1', '/repo').map(session => session.id))
            .toEqual(['new-active', 'old-active', 'new-inactive'])
    })
})
```

- [ ] **Step 2: Run RED test**

Run:

```bash
bun run --cwd web vitest run src/lib/editor-session-filter.test.ts
```

Expected: FAIL because `editor-session-filter` module does not exist.

- [ ] **Step 3: Implement helper**

Create `web/src/lib/editor-session-filter.ts`:

```typescript
import type { SessionSummary } from '@/types/api'

function normalizePath(path: string): string {
    return path.replace(/\/+$/, '') || '/'
}

function isSameOrChildPath(candidate: string | null | undefined, projectPath: string): boolean {
    if (!candidate) return false
    const normalizedCandidate = normalizePath(candidate)
    const normalizedProject = normalizePath(projectPath)
    return normalizedCandidate === normalizedProject || normalizedCandidate.startsWith(`${normalizedProject}/`)
}

function getWorktreeBasePath(session: SessionSummary): string | null {
    const worktree = session.metadata?.worktree
    if (!worktree || typeof worktree !== 'object') return null
    const basePath = (worktree as { basePath?: unknown }).basePath
    return typeof basePath === 'string' ? basePath : null
}

export function sessionBelongsToEditorProject(
    session: SessionSummary,
    machineId: string,
    projectPath: string
): boolean {
    if (!session.metadata?.machineId || session.metadata.machineId !== machineId) {
        return false
    }
    return isSameOrChildPath(session.metadata.path, projectPath)
        || isSameOrChildPath(getWorktreeBasePath(session), projectPath)
}

export function filterSessionsForEditorProject(
    sessions: readonly SessionSummary[],
    machineId: string,
    projectPath: string
): SessionSummary[] {
    return [...sessions]
        .filter((session) => sessionBelongsToEditorProject(session, machineId, projectPath))
        .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt)
}
```

- [ ] **Step 4: Update EditorSessionList to import helper**

Remove local `normalizePath`, `isSameOrChildPath`, `getWorktreeBasePath`, and `sessionBelongsToProject` from `web/src/components/editor/EditorSessionList.tsx`.

Add imports:

```typescript
import { filterSessionsForEditorProject, sessionBelongsToEditorProject } from '@/lib/editor-session-filter'
```

Export compatibility alias for existing tests only if needed:

```typescript
export const sessionBelongsToProject = sessionBelongsToEditorProject
```

Replace filtering logic with:

```typescript
const projectSessions = useMemo(() => {
    return filterSessionsForEditorProject(sessions, props.machineId, props.projectPath)
}, [props.machineId, props.projectPath, sessions])
```

- [ ] **Step 5: Run helper and existing wrapper tests**

Run:

```bash
bun run --cwd web vitest run src/lib/editor-session-filter.test.ts src/components/editor/EditorSessionList.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/editor-session-filter.ts web/src/lib/editor-session-filter.test.ts web/src/components/editor/EditorSessionList.tsx
git commit -m "refactor(editor): extract project session filter"
```

---

### Task 2: Add flat editor variant to SessionList

**Files:**
- Modify: `web/src/components/SessionList.tsx`
- Modify: `web/src/components/SessionList.test.ts`

- [ ] **Step 1: Write failing SessionList variant tests**

Append to `web/src/components/SessionList.test.ts`:

```typescript
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SessionList } from './SessionList'

function renderSessionList(ui: React.ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('SessionList editor variant', () => {
    it('renders a flat session list without machine or project group rows', () => {
        const sessions = [
            makeSession({ id: 's-1', active: true, metadata: { path: '/repo', machineId: 'machine-1', name: 'Review UI', flavor: 'codex' } }),
            makeSession({ id: 's-2', active: false, metadata: { path: '/repo/subdir', machineId: 'machine-1', name: 'Fix API', flavor: 'claude' } })
        ]

        renderSessionList(
            <SessionList
                variant="editor"
                sessions={sessions}
                onSelect={() => {}}
                onNewSession={() => {}}
                onRefresh={() => {}}
                isLoading={false}
                api={null}
                selectedSessionId="s-1"
                renderHeader={false}
            />
        )

        expect(screen.getByRole('button', { name: /Review UI/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Fix API/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /machine-1/ })).not.toBeInTheDocument()
        expect(screen.queryByText('repo/subdir')).not.toBeInTheDocument()
    })
})
```

If imports conflict with existing top-level imports, merge them instead of duplicating.

- [ ] **Step 2: Run RED test**

Run:

```bash
bun run --cwd web vitest run src/components/SessionList.test.ts
```

Expected: FAIL because `variant` prop is not supported or the list still renders grouped rows.

- [ ] **Step 3: Extend SessionList props**

In `web/src/components/SessionList.tsx`, add `variant?: 'default' | 'editor'` to `SessionList` props:

```typescript
export function SessionList(props: {
    variant?: 'default' | 'editor'
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onBrowse?: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    machineLabelsById?: Record<string, string>
    selectedSessionId?: string | null
}) {
```

Destructure:

```typescript
const { renderHeader = true, api, selectedSessionId, machineLabelsById = {}, variant = 'default' } = props
```

- [ ] **Step 4: Add flat editor rendering branch**

After empty/no-results handling and before grouped `machineGroups.map`, add:

```typescript
if (variant === 'editor') {
    return (
        <div className="mx-auto flex h-full w-full max-w-content flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-2">
                    <div className="text-xs font-semibold text-[var(--app-fg)]">Sessions</div>
                    <button
                        type="button"
                        onClick={props.onNewSession}
                        className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                    >
                        + New
                    </button>
                </div>
            ) : null}

            {props.sessions.length > 0 ? (
                <SessionListSearch value={searchQuery} onChange={setSearchQuery} />
            ) : null}

            {props.sessions.length === 0 ? (
                <SessionsEmptyState onNewSession={props.onNewSession} onBrowse={props.onBrowse} />
            ) : null}

            {props.sessions.length > 0 && isSearching && visibleSessions.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                    {t('sessions.search.noResults')}
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                <div className="flex flex-col gap-1">
                    {visibleSessions.map((session) => (
                        <SessionItem
                            key={session.id}
                            session={session}
                            onSelect={props.onSelect}
                            showPath={false}
                            api={api}
                            selected={session.id === selectedSessionId}
                        />
                    ))}
                </div>
            </div>
        </div>
    )
}
```

Keep the existing grouped render path unchanged for default Agent Mode.

- [ ] **Step 5: Run SessionList tests**

Run:

```bash
bun run --cwd web vitest run src/components/SessionList.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SessionList.tsx web/src/components/SessionList.test.ts
git commit -m "feat(editor): add flat SessionList variant"
```

---

### Task 3: Replace EditorSessionList custom rows with SessionList editor variant

**Files:**
- Modify: `web/src/components/editor/EditorSessionList.tsx`
- Modify: `web/src/components/editor/EditorSessionList.test.tsx`

- [ ] **Step 1: Write failing wrapper test for SessionList reuse**

Update `web/src/components/editor/EditorSessionList.test.tsx` to mock `SessionList`:

```typescript
const sessionListMock = vi.fn()

vi.mock('@/components/SessionList', () => ({
    SessionList: (props: unknown) => {
        sessionListMock(props)
        return <div data-testid="agent-session-list" />
    }
}))
```

Replace row rendering assertions with:

```typescript
expect(screen.getByTestId('agent-session-list')).toBeInTheDocument()
expect(sessionListMock).toHaveBeenCalledWith(expect.objectContaining({
    variant: 'editor',
    selectedSessionId: 's-2',
    renderHeader: true,
    api: expect.anything(),
    sessions: expect.arrayContaining([
        expect.objectContaining({ id: 's-1' }),
        expect.objectContaining({ id: 's-2' })
    ])
}))
expect(sessionListMock.mock.calls[0][0].sessions.map((session: SessionSummary) => session.id)).toEqual(['s-1', 's-2'])
```

Add one callback assertion:

```typescript
const props = sessionListMock.mock.calls[0][0] as { onSelect: (id: string) => void; onNewSession: () => void }
props.onSelect('s-1')
expect(onSelectSession).toHaveBeenCalledWith('s-1')
props.onNewSession()
expect(onNewSession).toHaveBeenCalled()
```

- [ ] **Step 2: Run RED wrapper test**

Run:

```bash
bun run --cwd web vitest run src/components/editor/EditorSessionList.test.tsx
```

Expected: FAIL because `EditorSessionList` still renders custom rows instead of `SessionList`.

- [ ] **Step 3: Simplify EditorSessionList implementation**

Replace custom `SessionRow`, status helpers, and manual row rendering with:

```typescript
import { useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import { SessionList } from '@/components/SessionList'
import { useSessions } from '@/hooks/queries/useSessions'
import { filterSessionsForEditorProject, sessionBelongsToEditorProject } from '@/lib/editor-session-filter'

export const sessionBelongsToProject = sessionBelongsToEditorProject

export function EditorSessionList(props: {
    api: ApiClient | null
    machineId: string | null
    projectPath: string | null
    activeSessionId: string | null
    onSelectSession: (sessionId: string) => void
    onNewSession: () => void
}) {
    if (!props.machineId || !props.projectPath) {
        return (
            <div className="flex h-full items-center justify-center p-3 text-center text-xs text-[var(--app-hint)]">
                Select a project to view sessions
            </div>
        )
    }

    return <SelectedEditorSessionList {...props} machineId={props.machineId} projectPath={props.projectPath} />
}

function SelectedEditorSessionList(props: {
    api: ApiClient | null
    machineId: string
    projectPath: string
    activeSessionId: string | null
    onSelectSession: (sessionId: string) => void
    onNewSession: () => void
}) {
    const { sessions, isLoading, error } = useSessions(props.api)
    const projectSessions = useMemo(() => {
        return filterSessionsForEditorProject(sessions, props.machineId, props.projectPath)
    }, [props.machineId, props.projectPath, sessions])

    if (isLoading) {
        return <div className="p-3 text-xs text-[var(--app-hint)]">Loading sessions...</div>
    }

    if (error) {
        return <div className="p-3 text-xs text-red-500">{error}</div>
    }

    return (
        <div className="h-full min-h-0 border-b border-[var(--app-border)]">
            <SessionList
                variant="editor"
                sessions={projectSessions}
                onSelect={props.onSelectSession}
                onNewSession={props.onNewSession}
                onRefresh={() => {}}
                isLoading={false}
                renderHeader={true}
                api={props.api}
                selectedSessionId={props.activeSessionId}
            />
        </div>
    )
}
```

- [ ] **Step 4: Run wrapper tests**

Run:

```bash
bun run --cwd web vitest run src/components/editor/EditorSessionList.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run full web typecheck/test**

Run:

```bash
bun run --cwd web typecheck
bun run --cwd web test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/editor/EditorSessionList.tsx web/src/components/editor/EditorSessionList.test.tsx
git commit -m "refactor(editor): reuse SessionList for sessions panel"
```

---

### Task 4: Verify editor session reuse manually

**Files:**
- No code changes expected.

- [ ] **Step 1: Run final automated verification**

```bash
bun typecheck
bun run test
```

Expected: PASS.

- [ ] **Step 2: Manual smoke checklist**

Run `bun run dev`, open `/editor`, then verify:

- Select machine + project.
- Session list shows a flat list for the selected project only.
- Sessions from sibling paths like `/repo2` are hidden when project is `/repo`.
- Worktree sessions with `metadata.worktree.basePath === projectPath` appear.
- Clicking a session opens chat in right panel.
- Existing session row actions still work: rename/archive/delete menu if available.
- Search in editor session list filters within current project only.
- Main Agent Mode `/sessions` list still groups by machine/project as before.

- [ ] **Step 3: Commit only if manual notes are recorded**

If docs are updated with manual results:

```bash
git add docs/superpowers/plans/2026-05-01-editor-session-reuse.md
git commit -m "docs(editor): record session reuse verification"
```

---

## Self-Review

- Spec coverage: covers flat project-filtered session list, reuse of Agent Mode `SessionList`, preservation of Agent Mode default grouping, and tests.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `variant="editor"`, `SessionSummary`, `SessionList` props, and helper names are consistent across tasks.
