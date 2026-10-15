import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { clearDraft, getDraft } from '@/lib/composer-drafts'
import TerminalPage, { buildTerminalCommandSequence } from './terminal'

const writeMock = vi.fn()
const goBackMock = vi.fn()
const navigateMock = vi.fn()
const connectMock = vi.fn()
const resizeMock = vi.fn()
const disconnectMock = vi.fn()
const onOutputMock = vi.fn()
let onExitHandler: ((code: number | null, signal: string | null) => void) | null = null
type MountedTerminal = {
    hasSelection: () => boolean
    getSelection: () => string
    focus: () => void
    write: (data: string) => void
    onData: (handler: (data: string) => void) => { dispose: () => void }
    onSelectionChange: (handler: () => void) => { dispose: () => void }
    buffer: {
        active: {
            length: number
            getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined
        }
    }
    __setSelection: (value: string | null) => void
    __fireSelectionChange: () => void
}
let mountedTerminal: MountedTerminal | null = null
let selectionChangeHandler: (() => void) | null = null

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
    useParams: () => ({ sessionId: 'session-1' }),
    useNavigate: () => navigateMock,
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

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: (props: { onMount?: (terminal: MountedTerminal) => void }) => {
        useEffect(() => {
            let selection: string | null = null
            const terminal: MountedTerminal = {
                hasSelection: () => selection !== null && selection.length > 0,
                getSelection: () => selection ?? '',
                focus: vi.fn(),
                write: vi.fn(),
                onData: () => ({ dispose: vi.fn() }),
                onSelectionChange: (handler: () => void) => {
                    selectionChangeHandler = handler
                    return { dispose: vi.fn() }
                },
                buffer: {
                    active: {
                        length: 2,
                        getLine: (index: number) => {
                            const lines = [
                                'REFUSE: lane B authorisation',
                                'must be granted by an operator',
                            ]
                            const value = lines[index]
                            if (value === undefined) return undefined
                            return { isWrapped: false, translateToString: () => value }
                        },
                    },
                },
                __setSelection: (value: string | null) => {
                    selection = value
                },
                __fireSelectionChange: () => {
                    selectionChangeHandler?.()
                },
            }
            mountedTerminal = terminal
            props.onMount?.(terminal)
        }, [props.onMount])
        return <div data-testid="terminal-view" />
    },
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
        mountedTerminal = null
        selectionChangeHandler = null
        clearDraft('session-1')
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

    it('keeps WebKit IME confirmation from submitting when keyCode is 229', () => {
        renderWithProviders()
        const input = screen.getByRole('textbox', { name: 'Command input' })

        fireEvent.change(input, { target: { value: '你好' } })
        fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 229 })

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

    it('supports keyboard and assistive activation through native button clicks', () => {
        renderWithProviders()

        fireEvent.click(screen.getByRole('button', { name: 'Interrupt process' }), { detail: 0 })

        expect(writeMock).toHaveBeenCalledWith('\u0003')
    })

    it('sends a compact terminal key once for a touch tap', () => {
        renderWithProviders()
        const button = screen.getByRole('button', { name: 'Interrupt process' })

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.click(button, { detail: 1 })

        expect(writeMock).toHaveBeenCalledOnce()
        expect(writeMock).toHaveBeenCalledWith('\u0003')
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

    it('sends dedicated Ctrl+X and Ctrl+S C0 sequences from the Control pad', () => {
        renderWithProviders()

        fireEvent.click(screen.getByRole('button', { name: 'Direct' }))
        fireEvent.click(screen.getByRole('button', { name: 'Cancel / prefix (C-x)' }))
        fireEvent.click(screen.getByRole('button', { name: 'XOFF / search / save (C-s)' }))

        expect(writeMock).toHaveBeenNthCalledWith(1, '\u0018')
        expect(writeMock).toHaveBeenNthCalledWith(2, '\u0013')
        // Keep Ctrl+L; density still fits a 4-col grid with the two Jed chords.
        expect(screen.getByRole('button', { name: 'Clear screen' })).toBeInTheDocument()
    })
})

describe('buildTerminalCommandSequence', () => {
    it('normalizes pasted lines and appends one carriage return', () => {
        expect(buildTerminalCommandSequence('echo one\necho two')).toBe('echo one\recho two\r')
        expect(buildTerminalCommandSequence('echo done\r')).toBe('echo done\r')
    })
})

describe('TerminalPage to agent', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        setCompactTerminalControls(false)
        onExitHandler = null
        mountedTerminal = null
        selectionChangeHandler = null
        clearDraft('session-1')
    })

    it('labels the control To agent until a selection exists', () => {
        renderWithProviders()
        expect(screen.getByTestId('terminal-to-agent')).toHaveTextContent('To agent')
    })

    it('flips the label when the terminal selection becomes nonempty', async () => {
        renderWithProviders()
        await waitFor(() => {
            expect(mountedTerminal).not.toBeNull()
        })

        await act(async () => {
            mountedTerminal?.__setSelection('lane B refuse')
            mountedTerminal?.__fireSelectionChange()
        })

        expect(screen.getByTestId('terminal-to-agent')).toHaveTextContent('Selection to agent')
    })

    it('appends the buffer to the composer draft and navigates to chat', async () => {
        renderWithProviders()
        await waitFor(() => {
            expect(mountedTerminal).not.toBeNull()
        })
        fireEvent.click(screen.getByTestId('terminal-to-agent'))

        expect(getDraft('session-1')).toContain('### Terminal output')
        expect(getDraft('session-1')).toContain('REFUSE: lane B authorisation')
        expect(navigateMock).toHaveBeenCalledWith(
            expect.objectContaining({
                to: '/sessions/$sessionId',
                params: { sessionId: 'session-1' },
            })
        )
    })

    it('appends the selection instead of the full buffer when selected', async () => {
        renderWithProviders()
        await waitFor(() => {
            expect(mountedTerminal).not.toBeNull()
        })

        await act(async () => {
            mountedTerminal?.__setSelection('selected refuse line')
            mountedTerminal?.__fireSelectionChange()
        })

        fireEvent.click(screen.getByTestId('terminal-to-agent'))

        expect(getDraft('session-1')).toContain('### Terminal selection')
        expect(getDraft('session-1')).toContain('selected refuse line')
        expect(getDraft('session-1')).not.toContain('must be granted by an operator')
    })
})
