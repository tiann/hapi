import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { EditorLayout } from './EditorLayout'

const mocks = vi.hoisted(() => ({
    createSession: vi.fn(),
    lastNewSessionArgs: null as null | { onCreated: (sessionId: string) => void },
    onLeftResizePointerDown: vi.fn(),
    onRightResizePointerDown: vi.fn(),
    onTerminalResizePointerDown: vi.fn()
}))

vi.mock('./EditorHeader', () => ({
    EditorHeader: (props: { onSelectMachine: (id: string) => void; onSelectProject: (path: string) => void }) => (
        <div data-testid="editor-header">
            Header
            <button type="button" onClick={() => props.onSelectMachine('machine-2')}>Select machine</button>
            <button type="button" onClick={() => props.onSelectProject('/repo2')}>Select project</button>
        </div>
    )
}))

vi.mock('./EditorFileTree', () => ({
    EditorFileTree: (props: {
        onOpenFile: (path: string) => void
        onContextMenu: (path: string, x: number, y: number, items: Array<{ path: string; type: 'file' | 'directory' }>) => void
        activeFilePath?: string | null
        newFileTargetPath?: string | null
        onCreateFile?: (parentPath: string, fileName: string) => Promise<unknown>
    }) => (
        <div data-testid="editor-file-tree">
            FileTree
            <button type="button" onClick={() => props.onOpenFile('/repo/src/App.tsx')}>Mock open file</button>
            <button type="button" onClick={() => props.onOpenFile('/repo/src/Other.ts')}>Mock open other file</button>
            <button type="button" onClick={() => props.onContextMenu('/repo/src/App.tsx', 12, 34, [{ path: '/repo/src/App.tsx', type: 'file' }])}>Mock context menu</button>
            <button type="button" onClick={() => props.onContextMenu('/repo/src/App.tsx', 12, 34, [
                { path: '/repo/src/App.tsx', type: 'file' },
                { path: '/repo/src/Other.ts', type: 'file' }
            ])}>Mock multi context menu</button>
            <div>Active file: {props.activeFilePath ?? ''}</div>
            <div>New file target: {props.newFileTargetPath ?? ''}</div>
            <button type="button" onClick={() => { void props.onCreateFile?.('/repo/src', 'New.ts') }}>Mock create file</button>
        </div>
    )
}))

vi.mock('./EditorTabs', () => ({
    EditorTabs: (props: { tabs: Array<{ label: string }>; onNewFile: () => void }) => (
        <div data-testid="editor-tabs">
            Tabs: {props.tabs.map((tab) => tab.label).join(',')}
            <button type="button" onClick={() => props.onNewFile()}>Mock new file tab</button>
        </div>
    )
}))

vi.mock('./EditorTerminal', () => ({
    EditorTerminal: (props: {
        tabs: Array<{ id: string; label: string; sessionId?: string; machineId?: string; cwd?: string }>
        activeTabId: string | null
        onOpenTerminal: () => void
        isCollapsed: boolean
        onToggleCollapsed: () => void
    }) => (
        <div data-testid="editor-terminal">
            Terminal collapsed: {props.isCollapsed ? 'yes' : 'no'}
            <div>Terminal tabs: {props.tabs.map((tab) => `${tab.label}:${tab.sessionId ?? tab.machineId ?? ''}:${tab.cwd ?? ''}`).join(',')}</div>
            <div>Active terminal: {props.activeTabId ?? ''}</div>
            <button type="button" onClick={() => props.onOpenTerminal()}>Mock open terminal</button>
            <button type="button" onClick={() => props.onToggleCollapsed()}>Mock toggle terminal</button>
        </div>
    )
}))

vi.mock('./EditorSessionList', () => ({
    EditorSessionList: (props: { onSelectSession: (sessionId: string) => void; onNewSession: () => void }) => (
        <div data-testid="editor-session-list">
            Sessions
            <button type="button" onClick={() => props.onSelectSession('session-1')}>Select session</button>
            <button type="button" onClick={props.onNewSession}>New session</button>
        </div>
    )
}))

vi.mock('./EditorChatPanel', () => ({
    EditorChatPanel: (props: { pendingDraftText?: string }) => (
        <div data-testid="editor-chat-panel">Chat draft: {props.pendingDraftText ?? ''}</div>
    )
}))

vi.mock('./EditorContextMenu', () => ({
    EditorContextMenu: (props: {
        filePath: string | null
        items: Array<{ path: string; type: 'file' | 'directory' }>
        onOpen: (items: Array<{ path: string; type: 'file' | 'directory' }>) => void
        onNewFile: (path: string) => void
        onAddToChat: (items: Array<{ path: string; type: 'file' | 'directory' }>) => void
        onCopyPath: (items: Array<{ path: string; type: 'file' | 'directory' }>) => void | Promise<void>
        onCopyRelativePath: (items: Array<{ path: string; type: 'file' | 'directory' }>) => void | Promise<void>
        onRefresh: (items: Array<{ path: string; type: 'file' | 'directory' }>) => void
        onDelete: (items: Array<{ path: string; type: 'file' | 'directory' }>) => void | Promise<void>
    }) => props.filePath ? (
        <div data-testid="editor-context-menu">
            <button type="button" onClick={() => props.onOpen(props.items)}>Context open</button>
            <button type="button" onClick={() => props.onNewFile(props.filePath!)}>Context new file</button>
            <button type="button" onClick={() => props.onAddToChat(props.items)}>Context add</button>
            <button type="button" onClick={() => { void props.onCopyPath(props.items) }}>Context copy</button>
            <button type="button" onClick={() => { void props.onCopyRelativePath(props.items) }}>Context copy relative</button>
            <button type="button" onClick={() => props.onRefresh(props.items)}>Context refresh</button>
            <button type="button" onClick={() => { void props.onDelete(props.items) }}>Context delete</button>
        </div>
    ) : null
}))

vi.mock('@/hooks/mutations/useEditorNewSession', () => ({
    useEditorNewSession: (args: { onCreated: (sessionId: string) => void }) => {
        mocks.lastNewSessionArgs = args
        return { createSession: mocks.createSession, isCreating: false, error: null }
    }
}))

vi.mock('@/hooks/useEditorPaneResize', () => ({
    useEditorPaneResize: () => ({
        leftWidth: 321,
        rightWidth: 432,
        terminalHeight: 210,
        onLeftResizePointerDown: mocks.onLeftResizePointerDown,
        onRightResizePointerDown: mocks.onRightResizePointerDown,
        onTerminalResizePointerDown: mocks.onTerminalResizePointerDown
    })
}))

function renderEditorLayout(api: ApiClient) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <EditorLayout api={api} initialMachineId="machine-1" initialProjectPath="/repo" />
        </QueryClientProvider>
    )
}

describe('EditorLayout', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.lastNewSessionArgs = null
    })

    afterEach(() => {
        cleanup()
    })

    it('renders editor regions', () => {
        renderEditorLayout({} as ApiClient)

        expect(screen.getByTestId('editor-header')).toBeInTheDocument()
        expect(screen.getByTestId('editor-file-tree')).toBeInTheDocument()
        expect(screen.getByTestId('editor-tabs')).toBeInTheDocument()
        expect(screen.getByTestId('editor-terminal')).toBeInTheDocument()
        expect(screen.getByTestId('editor-session-list')).toBeInTheDocument()
        expect(screen.getByTestId('editor-chat-panel')).toBeInTheDocument()
    })

    it('wires pane resize sizes and handlers', () => {
        renderEditorLayout({} as ApiClient)

        expect(screen.getByTestId('editor-file-tree').closest('aside')).toHaveStyle({ width: '321px' })
        expect(screen.getByTestId('editor-session-list').closest('aside')).toHaveStyle({ width: '432px' })
        expect(screen.getByTestId('editor-terminal').parentElement).toHaveStyle({ height: '32px' })

        fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize file tree' }))
        fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize sessions panel' }))

        // Expand terminal to test resize handler
        fireEvent.click(screen.getByText('Mock toggle terminal'))
        fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize terminal panel' }))

        expect(mocks.onLeftResizePointerDown).toHaveBeenCalledTimes(1)
        expect(mocks.onRightResizePointerDown).toHaveBeenCalledTimes(1)
        expect(mocks.onTerminalResizePointerDown).toHaveBeenCalledTimes(1)
    })

    it('constrains editor columns so the page body does not own editor scrolling', () => {
        renderEditorLayout({} as ApiClient)

        expect(screen.getByTestId('editor-layout-root')).toHaveClass('overflow-hidden')
        expect(screen.getByTestId('editor-layout-body')).toHaveClass('overflow-hidden')
        expect(screen.getByTestId('editor-main-pane')).toHaveClass('min-h-0', 'overflow-hidden')
        expect(screen.getByTestId('editor-tabs-region')).toHaveClass('overflow-hidden')
    })

    it('opens files from the tree into editor tabs', () => {
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock open file'))

        expect(screen.getByTestId('editor-tabs')).toHaveTextContent('App.tsx')
        expect(screen.getByTestId('editor-file-tree')).toHaveTextContent('Active file: /repo/src/App.tsx')
    })

    it('starts new-file flow from the editor tab plus using active file or project root', () => {
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock new file tab'))
        expect(screen.getByTestId('editor-file-tree')).toHaveTextContent('New file target: /repo')

        fireEvent.click(screen.getByText('Mock open file'))
        fireEvent.click(screen.getByText('Mock new file tab'))
        expect(screen.getByTestId('editor-file-tree')).toHaveTextContent('New file target: /repo/src/App.tsx')
    })

    it('opens terminal only in the terminal panel and toggles terminal collapse', () => {
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock open terminal'))
        expect(screen.getByTestId('editor-tabs')).not.toHaveTextContent('Terminal: bash')
        expect(screen.getByTestId('editor-terminal')).toHaveTextContent('Terminal tabs: Terminal: bash:machine-1:/repo')

        expect(screen.getByTestId('editor-terminal')).toHaveTextContent('Terminal collapsed: no')
        expect(screen.getByTestId('editor-terminal').parentElement).toHaveStyle({ height: '210px' })

        fireEvent.click(screen.getByText('Mock toggle terminal'))

        expect(screen.getByTestId('editor-terminal')).toHaveTextContent('Terminal collapsed: yes')
        expect(screen.getByTestId('editor-terminal').parentElement).toHaveStyle({ height: '32px' })
    })

    it('does not create a chat session before opening a machine terminal', () => {
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock open terminal'))
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(screen.getByTestId('editor-tabs')).not.toHaveTextContent('Terminal: bash')
        expect(screen.getByTestId('editor-terminal')).toHaveTextContent('Terminal tabs: Terminal: bash:machine-1:/repo')
    })

    it('starts inline new-file flow and opens the created file', async () => {
        const api = {
            createEditorFile: vi.fn(async () => ({ success: true, path: '/repo/src/New.ts', size: 0 }))
        } as unknown as ApiClient
        renderEditorLayout(api)

        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context new file'))
        expect(screen.getByTestId('editor-file-tree')).toHaveTextContent('New file target: /repo/src/App.tsx')

        fireEvent.click(screen.getByText('Mock create file'))

        await waitFor(() => {
            expect(api.createEditorFile).toHaveBeenCalledWith('machine-1', '/repo/src/New.ts', '')
        })
        expect(screen.getByTestId('editor-tabs')).toHaveTextContent('New.ts')
    })

    it('copies context menu file paths to the clipboard', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context copy'))

        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('/repo/src/App.tsx')
        })
    })

    it('copies context menu relative file paths to the clipboard', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context copy relative'))

        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('src/App.tsx')
        })
    })

    it('copies multiple selected context menu paths one per line', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock multi context menu'))
        fireEvent.click(screen.getByText('Context copy relative'))

        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('src/App.tsx\nsrc/Other.ts')
        })
    })

    it('refreshes context menu directories', async () => {
        const invalidateQueries = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context refresh'))

        await waitFor(() => {
            expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['editor', 'directory', 'machine-1', '/repo/src'] })
            expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['editor', 'directory', 'machine-1', '/repo/src/App.tsx'] })
        })
        invalidateQueries.mockRestore()
    })

    it('deletes context menu items through a confirm modal and closes matching tabs', async () => {
        const confirm = vi.spyOn(window, 'confirm')
        const api = {
            deleteEditorFile: vi.fn(async () => ({ success: true, path: '/repo/src/App.tsx' }))
        } as unknown as ApiClient
        renderEditorLayout(api)

        fireEvent.click(screen.getByText('Mock open file'))
        fireEvent.click(screen.getByText('Mock open other file'))
        expect(screen.getByTestId('editor-tabs')).toHaveTextContent('App.tsx')
        expect(screen.getByTestId('editor-tabs')).toHaveTextContent('Other.ts')

        fireEvent.click(screen.getByText('Mock multi context menu'))
        fireEvent.click(screen.getByText('Context delete'))

        expect(confirm).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', { name: 'Delete 2 items?' })).toBeInTheDocument()
        expect(api.deleteEditorFile).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

        await waitFor(() => {
            expect(api.deleteEditorFile).toHaveBeenCalledWith('machine-1', '/repo/src/App.tsx')
            expect(api.deleteEditorFile).toHaveBeenCalledWith('machine-1', '/repo/src/Other.ts')
        })
        expect(screen.getByTestId('editor-tabs')).not.toHaveTextContent('App.tsx')
        expect(screen.getByTestId('editor-tabs')).not.toHaveTextContent('Other.ts')
        confirm.mockRestore()
    })

    it('adds a file to the active chat draft', () => {
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Select session'))
        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context add'))

        expect(screen.getByTestId('editor-chat-panel')).toHaveTextContent('Chat draft: @/repo/src/App.tsx')
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it('creates a session before adding a file when no session is active', () => {
        renderEditorLayout({} as ApiClient)

        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context add'))

        expect(mocks.createSession).toHaveBeenCalled()
    })
})
