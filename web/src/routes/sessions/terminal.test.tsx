import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import TerminalPage from './terminal'

const writeMock = vi.fn()

let hasSelectionMock = false
let selectionTextMock = ''
let keyHandler: ((event: KeyboardEvent) => boolean) | null = null

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
    useAppGoBack: () => vi.fn()
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

vi.mock('@/hooks/useTerminalSocket', () => ({
    useTerminalSocket: () => ({
        state: { status: 'connected' as const },
        connect: vi.fn(),
        write: writeMock,
        resize: vi.fn(),
        disconnect: vi.fn(),
        onOutput: vi.fn(),
        onExit: vi.fn()
    })
}))

vi.mock('@/hooks/useLongPress', () => ({
    useLongPress: ({ onClick }: { onClick: () => void }) => ({
        onClick
    })
}))

type TerminalMountMock = {
    onData: () => { dispose: () => void }
    attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void
    hasSelection: () => boolean
    getSelection: () => string
    write: () => void
    focus: () => void
}

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: ({ onMount }: { onMount?: (terminal: TerminalMountMock) => void }) => {
        useEffect(() => {
            const terminal: TerminalMountMock = {
                onData: () => ({ dispose: vi.fn() }),
                attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
                    keyHandler = handler
                },
                hasSelection: () => hasSelectionMock,
                getSelection: () => selectionTextMock,
                write: vi.fn(),
                focus: vi.fn(),
            }
            onMount?.(terminal)
        }, [onMount])
        return <div data-testid="terminal-view" />
    }
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
        hasSelectionMock = false
        selectionTextMock = ''
        keyHandler = null
        localStorage.clear()
        localStorage.setItem('zs-lang', 'en')
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

    it('copies selected text on Ctrl/Cmd+C and does not send control bytes', async () => {
        const writeText = vi.fn(async () => undefined)
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        hasSelectionMock = true
        selectionTextMock = 'echo hello'

        renderWithProviders()

        const preventDefault = vi.fn()
        const stopPropagation = vi.fn()
        const handled = keyHandler?.({
            key: 'c',
            ctrlKey: true,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            preventDefault,
            stopPropagation,
        } as unknown as KeyboardEvent)

        expect(handled).toBe(false)
        await waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('echo hello')
        })
        expect(preventDefault).toHaveBeenCalledTimes(1)
        expect(stopPropagation).toHaveBeenCalledTimes(1)
        expect(writeMock).not.toHaveBeenCalled()
    })

    it('falls back to interrupt behavior when there is no terminal selection', () => {
        const writeText = vi.fn(async () => undefined)
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        hasSelectionMock = false

        renderWithProviders()

        const handled = keyHandler?.({
            key: 'c',
            ctrlKey: true,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as unknown as KeyboardEvent)

        expect(handled).toBe(true)
        expect(writeText).not.toHaveBeenCalled()
    })
})
