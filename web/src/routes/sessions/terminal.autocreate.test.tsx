import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import TerminalPage from './terminal'

const createTerminalMock = vi.fn()
const refreshTerminalsMock = vi.fn()
const closeTerminalMock = vi.fn()
const detachTerminalMock = vi.fn()
const connectMock = vi.fn()
const resizeMock = vi.fn()
const disconnectMock = vi.fn()
const writeMock = vi.fn()
let onExitHandler: ((code: number | null, signal: string | null) => void) | null = null
let remoteTerminals: Array<{ terminalId: string; createdAt: number; attached: boolean }> = []

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' })
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: null, token: 'test-token', baseUrl: 'http://localhost:3000' })
}))

vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => vi.fn() }))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: { id: 'session-1', active: true, metadata: { path: '/tmp/project' } }
    })
}))

vi.mock('@/utils/terminalSupport', () => ({ isRemoteTerminalSupported: () => true }))

vi.mock('@/hooks/useTerminalSocket', () => ({
    useTerminalSocket: () => ({
        state: { status: 'connected' as const },
        terminals: remoteTerminals,
        maxTerminals: 4,
        hasLoadedTerminals: true,
        connect: connectMock,
        refreshTerminals: refreshTerminalsMock,
        createTerminal: createTerminalMock,
        detachTerminal: detachTerminalMock,
        closeTerminal: closeTerminalMock,
        write: writeMock,
        resize: resizeMock,
        disconnect: disconnectMock,
        onOutput: vi.fn(),
        onExit: (handler: (code: number | null, signal: string | null) => void) => {
            onExitHandler = handler
        }
    })
}))

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: () => <div data-testid="terminal-view" />
}))

function page() {
    return (
        <I18nProvider>
            <TerminalPage />
        </I18nProvider>
    )
}

describe('TerminalPage initial auto-create semantics', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        remoteTerminals = []
        onExitHandler = null
        window.localStorage.clear()
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            configurable: true,
            value: vi.fn().mockReturnValue({
                matches: false,
                media: '',
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(() => false)
            })
        })
    })

    it('auto-creates exactly once with a deterministic ID for an initially empty session', async () => {
        const view = render(page())

        await waitFor(() => expect(createTerminalMock).toHaveBeenCalledTimes(1))
        expect(createTerminalMock).toHaveBeenCalledWith('term-session-1-auto', 80, 24)

        view.rerender(page())
        await act(async () => {})
        expect(createTerminalMock).toHaveBeenCalledTimes(1)
    })

    it('does not create a replacement when the sole pre-existing terminal later disappears', async () => {
        remoteTerminals = [{ terminalId: 'terminal-1', createdAt: 1, attached: false }]
        const view = render(page())

        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Terminal 1' })).toHaveAttribute('aria-selected', 'true')
        })
        expect(createTerminalMock).not.toHaveBeenCalled()

        remoteTerminals = []
        view.rerender(page())

        await waitFor(() => expect(screen.getByText('No terminal selected.')).toBeInTheDocument())
        expect(createTerminalMock).not.toHaveBeenCalled()
        expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument()
    })

    it('does not create a replacement after the active pre-existing terminal exits', async () => {
        remoteTerminals = [{ terminalId: 'terminal-1', createdAt: 1, attached: false }]
        const view = render(page())

        await waitFor(() => expect(onExitHandler).not.toBeNull())
        await act(async () => {
            onExitHandler?.(0, null)
        })

        remoteTerminals = []
        view.rerender(page())

        await waitFor(() => expect(screen.getByText('No terminal selected.')).toBeInTheDocument())
        expect(createTerminalMock).not.toHaveBeenCalled()
        expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument()
    })
})
