import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    EditorFileTree: (props: { onOpenFile: (path: string) => void; onContextMenu: (path: string, x: number, y: number) => void }) => (
        <div data-testid="editor-file-tree">
            FileTree
            <button type="button" onClick={() => props.onOpenFile('/repo/src/App.tsx')}>Mock open file</button>
            <button type="button" onClick={() => props.onContextMenu('/repo/src/App.tsx', 12, 34)}>Mock context menu</button>
        </div>
    )
}))

vi.mock('./EditorTabs', () => ({
    EditorTabs: (props: { tabs: Array<{ label: string }>; onOpenTerminal: () => void }) => (
        <div data-testid="editor-tabs">
            Tabs: {props.tabs.map((tab) => tab.label).join(',')}
            <button type="button" onClick={props.onOpenTerminal}>Mock open terminal</button>
        </div>
    )
}))

vi.mock('./EditorTerminal', () => ({
    EditorTerminal: () => <div data-testid="editor-terminal">Terminal</div>
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
        onOpen: (path: string) => void
        onAddToChat: (path: string) => void
        onCopyPath: (path: string) => void | Promise<void>
    }) => props.filePath ? (
        <div data-testid="editor-context-menu">
            <button type="button" onClick={() => props.onOpen(props.filePath!)}>Context open</button>
            <button type="button" onClick={() => props.onAddToChat(props.filePath!)}>Context add</button>
            <button type="button" onClick={() => { void props.onCopyPath(props.filePath!) }}>Context copy</button>
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

describe('EditorLayout', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.lastNewSessionArgs = null
    })

    afterEach(() => {
        cleanup()
    })

    it('renders editor regions', () => {
        render(<EditorLayout api={{} as ApiClient} initialMachineId="machine-1" initialProjectPath="/repo" />)

        expect(screen.getByTestId('editor-header')).toBeInTheDocument()
        expect(screen.getByTestId('editor-file-tree')).toBeInTheDocument()
        expect(screen.getByTestId('editor-tabs')).toBeInTheDocument()
        expect(screen.getByTestId('editor-terminal')).toBeInTheDocument()
        expect(screen.getByTestId('editor-session-list')).toBeInTheDocument()
        expect(screen.getByTestId('editor-chat-panel')).toBeInTheDocument()
    })

    it('wires pane resize sizes and handlers', () => {
        render(<EditorLayout api={{} as ApiClient} initialMachineId="machine-1" initialProjectPath="/repo" />)

        expect(screen.getByTestId('editor-file-tree').closest('aside')).toHaveStyle({ width: '321px' })
        expect(screen.getByTestId('editor-session-list').closest('aside')).toHaveStyle({ width: '432px' })
        expect(screen.getByTestId('editor-terminal').parentElement).toHaveStyle({ height: '210px' })

        fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize file tree' }))
        fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize sessions panel' }))
        fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize terminal panel' }))

        expect(mocks.onLeftResizePointerDown).toHaveBeenCalledTimes(1)
        expect(mocks.onRightResizePointerDown).toHaveBeenCalledTimes(1)
        expect(mocks.onTerminalResizePointerDown).toHaveBeenCalledTimes(1)
    })

    it('constrains editor columns so the page body does not own editor scrolling', () => {
        render(<EditorLayout api={{} as ApiClient} initialMachineId="machine-1" initialProjectPath="/repo" />)

        expect(screen.getByTestId('editor-layout-root')).toHaveClass('overflow-hidden')
        expect(screen.getByTestId('editor-layout-body')).toHaveClass('overflow-hidden')
        expect(screen.getByTestId('editor-main-pane')).toHaveClass('min-h-0', 'overflow-hidden')
        expect(screen.getByTestId('editor-tabs-region')).toHaveClass('overflow-hidden')
    })

    it('opens files from the tree into editor tabs', () => {
        render(<EditorLayout api={{} as ApiClient} initialMachineId="machine-1" initialProjectPath="/repo" />)

        fireEvent.click(screen.getByText('Mock open file'))

        expect(screen.getByTestId('editor-tabs')).toHaveTextContent('App.tsx')
    })

    it('copies context menu file paths to the clipboard', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        render(<EditorLayout api={{} as ApiClient} initialMachineId="machine-1" initialProjectPath="/repo" />)

        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context copy'))

        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('/repo/src/App.tsx')
        })
    })

    it('adds a file to the active chat draft', () => {
        render(<EditorLayout api={{} as ApiClient} initialMachineId="machine-1" initialProjectPath="/repo" />)

        fireEvent.click(screen.getByText('Select session'))
        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context add'))

        expect(screen.getByTestId('editor-chat-panel')).toHaveTextContent('Chat draft: @/repo/src/App.tsx')
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it('creates a session before adding a file when no session is active', () => {
        render(<EditorLayout api={{} as ApiClient} initialMachineId="machine-1" initialProjectPath="/repo" />)

        fireEvent.click(screen.getByText('Mock context menu'))
        fireEvent.click(screen.getByText('Context add'))

        expect(mocks.createSession).toHaveBeenCalled()
    })
})
