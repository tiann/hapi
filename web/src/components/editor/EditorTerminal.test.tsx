import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTab } from '@/hooks/useEditorState'
import { EditorTerminal } from './EditorTerminal'

const mocks = vi.hoisted(() => ({
    useSession: vi.fn(),
    useTerminalSocket: vi.fn(),
    isRemoteTerminalSupported: vi.fn(),
    onMountTerminal: vi.fn(),
    onResizeTerminal: vi.fn(),
    disconnectsByTerminalId: new Map<string, ReturnType<typeof vi.fn>>()
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ token: 'token-1', baseUrl: 'http://hub.local' })
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: (...args: unknown[]) => mocks.useSession(...args)
}))

vi.mock('@/hooks/useTerminalSocket', () => ({
    useTerminalSocket: (...args: unknown[]) => mocks.useTerminalSocket(...args)
}))

vi.mock('@/utils/terminalSupport', () => ({
    isRemoteTerminalSupported: (...args: unknown[]) => mocks.isRemoteTerminalSupported(...args)
}))

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: (props: { onMount?: (terminal: unknown) => void; onResize?: (cols: number, rows: number) => void }) => {
        mocks.onMountTerminal(props.onMount)
        mocks.onResizeTerminal(props.onResize)
        return <div data-testid="terminal-view" />
    }
}))

const tabs: EditorTab[] = [
    { id: 'file-1', type: 'file', path: '/repo/src/App.tsx', label: 'App.tsx' },
    { id: 'term-1', type: 'terminal', label: 'Terminal: bash', shell: 'bash', sessionId: 'session-1' },
    { id: 'term-2', type: 'terminal', label: 'Terminal: zsh', shell: 'zsh', sessionId: 'session-1' }
]

describe('EditorTerminal', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.useSession.mockReturnValue({
            session: { id: 'session-1', active: true, metadata: { os: 'linux', path: '/repo', host: 'dev' } },
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })
        mocks.disconnectsByTerminalId.clear()
        mocks.useTerminalSocket.mockImplementation((options: { terminalId: string }) => {
            const disconnect = vi.fn()
            mocks.disconnectsByTerminalId.set(options.terminalId, disconnect)
            return {
            state: { status: 'connected' },
            connect: vi.fn(),
            write: vi.fn(),
            resize: vi.fn(),
            disconnect,
            onOutput: vi.fn(),
            onExit: vi.fn()
            }
        })
        mocks.isRemoteTerminalSupported.mockReturnValue(true)
    })

    afterEach(() => {
        cleanup()
    })

    it('shows an empty state when no terminal tabs exist', () => {
        render(
            <EditorTerminal
                tabs={[tabs[0]]}
                activeTabId="file-1"
                isCollapsed={false}
                api={null}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(screen.getByText('No terminal open')).toBeInTheDocument()
    })

    it('renders only terminal tabs and tab actions', () => {
        const onSelectTab = vi.fn()
        const onCloseTab = vi.fn()
        const onOpenTerminal = vi.fn()
        const onToggleCollapsed = vi.fn()

        render(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-2"
                isCollapsed={false}
                api={null}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onOpenTerminal={onOpenTerminal}
                onToggleCollapsed={onToggleCollapsed}
            />
        )

        expect(screen.queryByText('App.tsx')).not.toBeInTheDocument()
        expect(screen.getByText('Terminal: bash')).toBeInTheDocument()
        expect(screen.getAllByText('Terminal: zsh')).toHaveLength(1)
        expect(screen.getAllByTestId('terminal-view')).toHaveLength(2)
        expect(mocks.useTerminalSocket).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token-1',
            baseUrl: 'http://hub.local',
            sessionId: 'session-1',
            terminalId: 'term-2'
        }))

        fireEvent.click(screen.getByRole('button', { name: 'Select terminal Terminal: bash' }))
        expect(onSelectTab).toHaveBeenCalledWith('term-1')

        fireEvent.click(screen.getByRole('button', { name: 'Close terminal Terminal: zsh' }))
        expect(onCloseTab).toHaveBeenCalledWith('term-2')

        fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
        expect(onOpenTerminal).toHaveBeenCalledWith()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse terminal' }))
        expect(onToggleCollapsed).toHaveBeenCalledWith()
    })

    it('keeps inactive terminal sockets mounted when switching tabs and collapsed', () => {
        const { rerender } = render(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-1"
                isCollapsed={false}
                api={null}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(screen.getAllByTestId('terminal-view')).toHaveLength(2)

        rerender(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-2"
                isCollapsed={false}
                api={null}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(mocks.disconnectsByTerminalId.get('term-1')).not.toHaveBeenCalled()

        rerender(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-2"
                isCollapsed={true}
                api={null}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(mocks.disconnectsByTerminalId.get('term-1')).not.toHaveBeenCalled()
        expect(mocks.disconnectsByTerminalId.get('term-2')).not.toHaveBeenCalled()
    })

    it('connects machine-scoped terminals without session lookup', () => {
        render(
            <EditorTerminal
                tabs={[{ id: 'term-machine', type: 'terminal', label: 'Terminal: bash', shell: 'bash', machineId: 'machine-1', cwd: '/repo' }]}
                activeTabId="term-machine"
                isCollapsed={false}
                api={null}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(mocks.useSession).toHaveBeenCalledWith(null, null)
        expect(mocks.useTerminalSocket).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            cwd: '/repo',
            sessionId: '',
            terminalId: 'term-machine'
        }))
        expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
    })

    it('hides terminal body content when collapsed and exposes expand action', () => {
        render(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-2"
                isCollapsed={true}
                api={null}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(screen.queryAllByTestId('terminal-view')).toHaveLength(2)
        expect(screen.getByRole('button', { name: 'Expand terminal' })).toBeInTheDocument()
    })
})
