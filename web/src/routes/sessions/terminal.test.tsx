import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import TerminalPage, { buildTerminalCommandSequence } from './terminal'

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

function setCompactTerminalControls(compact: boolean) {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: compact && query.includes('max-width: 640px'),
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(() => false),
        })),
    })
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
        setCompactTerminalControls(false)
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
        setCompactTerminalControls(false)
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

describe('TerminalPage compact command input', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        setCompactTerminalControls(true)
        onExitHandler = null
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0)
            return 1
        })
    })

    it('sends spaces and Chinese punctuation as one command', () => {
        renderWithProviders()
        const input = screen.getByRole('textbox', { name: 'Command input' })

        fireEvent.change(input, {
            target: { value: "printf '你好，世界！' && cd My Folder" },
        })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(writeMock).toHaveBeenCalledWith("printf '你好，世界！' && cd My Folder\r")
        expect(input).toHaveValue('')
    })

    it('keeps Enter inside an active IME composition from submitting', () => {
        renderWithProviders()
        const input = screen.getByRole('textbox', { name: 'Command input' })

        fireEvent.change(input, { target: { value: '你好' } })
        fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

        expect(writeMock).not.toHaveBeenCalled()
        expect(input).toHaveValue('你好')
    })

    it('inserts a basic command for review before running it', () => {
        renderWithProviders()
        const input = screen.getByRole('textbox', { name: 'Command input' })

        fireEvent.click(screen.getByRole('button', { name: 'ls' }))

        expect(input).toHaveValue('ls')
        expect(writeMock).not.toHaveBeenCalled()

        fireEvent.keyDown(input, { key: 'Enter' })
        expect(writeMock).toHaveBeenCalledWith('ls\r')
    })

    it('keeps the cursor after the space in commands that need an argument', () => {
        renderWithProviders()
        const input = screen.getByRole('textbox', {
            name: 'Command input',
        }) as HTMLTextAreaElement

        fireEvent.click(screen.getByRole('button', { name: 'cd' }))

        expect(input).toHaveValue('cd ')
        expect(input.selectionStart).toBe(3)
        expect(input.selectionEnd).toBe(3)
    })

    it('provides an explicit space key in direct mode', () => {
        renderWithProviders()

        fireEvent.click(screen.getByRole('button', { name: 'Direct' }))
        expect(screen.queryByRole('textbox', { name: 'Command input' })).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Space' }))
        expect(writeMock).toHaveBeenCalledWith(' ')
    })

    it('shows direct terminal keys in paged multi-row grids', () => {
        renderWithProviders()

        fireEvent.click(screen.getByRole('button', { name: 'Direct' }))

        expect(screen.getByTestId('compact-terminal-quick-keys')).toHaveClass('grid-cols-4')
        expect(screen.getByRole('button', { name: 'Shift Tab' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Navigation' }))
        expect(screen.getByRole('button', { name: 'Page down' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
        expect(screen.getByRole('button', { name: 'Pipe' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Symbols' }))
        expect(screen.getByRole('button', { name: 'Left brace' })).toBeInTheDocument()
    })

    it('sends added direct terminal key sequences', () => {
        renderWithProviders()

        fireEvent.click(screen.getByRole('button', { name: 'Direct' }))
        fireEvent.click(screen.getByRole('button', { name: 'Shift Tab' }))
        fireEvent.click(screen.getByRole('button', { name: 'Enter' }))

        fireEvent.click(screen.getByRole('button', { name: 'Navigation' }))
        fireEvent.click(screen.getByRole('button', { name: 'Page down' }))

        fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
        fireEvent.click(screen.getByRole('button', { name: 'Pipe' }))

        expect(writeMock).toHaveBeenNthCalledWith(1, '\u001b[Z')
        expect(writeMock).toHaveBeenNthCalledWith(2, '\r')
        expect(writeMock).toHaveBeenNthCalledWith(3, '\u001b[6~')
        expect(writeMock).toHaveBeenNthCalledWith(4, '|')
    })
})

describe('buildTerminalCommandSequence', () => {
    it('normalizes pasted lines and appends one carriage return', () => {
        expect(buildTerminalCommandSequence('echo one\necho two')).toBe('echo one\recho two\r')
        expect(buildTerminalCommandSequence('echo done\r')).toBe('echo done\r')
    })
})
