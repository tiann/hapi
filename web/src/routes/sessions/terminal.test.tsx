import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import TerminalPage from './terminal'

const writeMock = vi.fn()
const goBackMock = vi.fn()
const connectMock = vi.fn()
const resizeMock = vi.fn()
const disconnectMock = vi.fn()
const onOutputMock = vi.fn()
let onExitHandler: ((code: number | null, signal: string | null) => void) | null = null

const onExitRegister = (handler: (code: number | null, signal: string | null) => void) => {
    onExitHandler = handler
}

const terminalSocketState = {
    state: { status: 'connected' as const },
    connect: connectMock,
    write: writeMock,
    resize: resizeMock,
    disconnect: disconnectMock,
    onOutput: onOutputMock,
    onExit: onExitRegister
}

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' })
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: null,
        token: 'test-token',
        baseUrl: 'http://localhost:3000'
    })
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => goBackMock
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: {
            id: 'session-1',
            active: true,
            metadata: { path: '/tmp/project' }
        }
    })
}))

const capturedTerminalIds: string[] = []

vi.mock('@/hooks/useTerminalSocket', () => ({
    useTerminalSocket: (opts: { terminalId: string }) => {
        capturedTerminalIds.push(opts.terminalId)
        return terminalSocketState
    }
}))

vi.mock('@/hooks/useLongPress', () => ({
    useLongPress: ({ onClick }: { onClick: () => void }) => ({
        onClick
    })
}))

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: () => <div data-testid="terminal-view" />
}))

function renderWithProviders() {
    return render(
        <I18nProvider>
            <TerminalPage />
        </I18nProvider>
    )
}

describe('TerminalPage paste behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        onExitHandler = null
    })

    it('does not open manual paste dialog when clipboard text is empty', async () => {
        const readText = vi.fn(async () => '')
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText }
        })

        renderWithProviders()
        fireEvent.click(screen.getAllByRole('button', { name: 'Paste' })[0])

        await waitFor(() => {
            expect(readText).toHaveBeenCalledTimes(1)
        })
        expect(writeMock).not.toHaveBeenCalled()
        expect(screen.queryByText('Paste input')).not.toBeInTheDocument()
    })

    it('opens manual paste dialog when clipboard read fails', async () => {
        const readText = vi.fn(async () => {
            throw new Error('blocked')
        })
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText }
        })

        renderWithProviders()
        fireEvent.click(screen.getAllByRole('button', { name: 'Paste' })[0])

        expect(await screen.findByText('Paste input')).toBeInTheDocument()
    })
})

describe('TerminalPage terminal id', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        capturedTerminalIds.length = 0
    })

    it('generates a unique terminal id per mount so concurrent viewers do not collide', () => {
        // Two viewers (tabs/devices) of the SAME session must not share one
        // terminal id: the hub registry would treat the second viewer's reused
        // id as a stale reconnect and evict the first viewer's PTY ownership.
        renderWithProviders()
        renderWithProviders()

        const distinct = new Set(capturedTerminalIds)
        expect(distinct.size).toBe(2)
        // Each id still carries the session for debuggability/scoping.
        expect([...distinct].every((id) => id.startsWith('term-session-1-'))).toBe(true)
    })
})

describe('TerminalPage exit behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        onExitHandler = null
    })

    it('navigates back to chat shortly after the terminal exits', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(onExitHandler).not.toBeNull()
        })

        await act(async () => {
            onExitHandler?.(0, null)
        })

        await waitFor(
            () => {
                expect(goBackMock).toHaveBeenCalledTimes(1)
            },
            { timeout: 3000 }
        )
    })
})
