import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import TerminalPage from './terminal'

type FakeTerminalHandle = {
    write: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    emitData: (data: string) => void
}

const mocks = vi.hoisted(() => ({
    write: vi.fn(),
    connect: vi.fn(),
    resize: vi.fn(),
    disconnect: vi.fn(),
    refreshTerminals: vi.fn(),
    createTerminal: vi.fn(),
    detachTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    outputHandler: null as ((data: string) => void) | null,
    exitHandler: null as ((code: number | null, signal: string | null) => void) | null,
    terminals: [] as FakeTerminalHandle[]
}))

vi.mock('@xterm/xterm', () => {
    class FakeTerminal {
        cols = 80
        rows = 24
        options: Record<string, unknown>
        write = vi.fn()
        focus = vi.fn()
        blur = vi.fn()
        refresh = vi.fn()
        dispose = vi.fn()
        loadAddon = vi.fn()
        open = vi.fn()
        private dataHandler: ((data: string) => void) | null = null

        constructor(options: Record<string, unknown>) {
            this.options = { ...options }
            mocks.terminals.push(this)
        }

        onData(handler: (data: string) => void) {
            this.dataHandler = handler
            return {
                dispose: vi.fn(() => {
                    if (this.dataHandler === handler) {
                        this.dataHandler = null
                    }
                })
            }
        }

        emitData(data: string): void {
            this.dataHandler?.(data)
        }
    }

    return { Terminal: FakeTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
    FitAddon: class {
        fit = vi.fn()
        dispose = vi.fn()
    }
}))

vi.mock('@xterm/addon-web-links', () => ({
    WebLinksAddon: class {
        dispose = vi.fn()
    }
}))

vi.mock('@xterm/addon-canvas', () => ({
    CanvasAddon: class {
        dispose = vi.fn()
    }
}))

vi.mock('@/lib/terminalFont', () => ({
    ensureBuiltinFontLoaded: vi.fn(async () => false),
    getFontProvider: () => ({ getFontFamily: () => 'monospace' })
}))

vi.mock('@/hooks/useTerminalFontSize', () => ({
    getInitialTerminalFontSize: () => 14
}))

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

vi.mock('@/utils/terminalSupport', () => ({
    isRemoteTerminalSupported: () => true
}))

vi.mock('@/hooks/useTerminalSocket', () => ({
    useTerminalSocket: () => ({
        state: { status: 'connected' as const },
        terminals: [
            { terminalId: 'terminal-1', createdAt: 1, attached: false },
            { terminalId: 'terminal-2', createdAt: 2, attached: false }
        ],
        maxTerminals: 4,
        hasLoadedTerminals: true,
        connect: mocks.connect,
        refreshTerminals: mocks.refreshTerminals,
        createTerminal: mocks.createTerminal,
        detachTerminal: mocks.detachTerminal,
        closeTerminal: mocks.closeTerminal,
        write: mocks.write,
        resize: mocks.resize,
        disconnect: mocks.disconnect,
        onOutput: (handler: (data: string) => void) => {
            mocks.outputHandler = handler
        },
        onExit: (handler: (code: number | null, signal: string | null) => void) => {
            mocks.exitHandler = handler
        }
    })
}))

class MockResizeObserver {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
}

describe('TerminalPage real TerminalView lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.terminals.length = 0
        mocks.outputHandler = null
        mocks.exitHandler = null
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
        Object.defineProperty(globalThis, 'ResizeObserver', {
            writable: true,
            configurable: true,
            value: MockResizeObserver
        })
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0)
            return 1
        })
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
    })

    it('keeps the newly mounted xterm ref and input subscription alive after switching terminals', async () => {
        render(
            <I18nProvider>
                <TerminalPage />
            </I18nProvider>
        )

        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute('aria-selected', 'true')
            expect(mocks.terminals).toHaveLength(1)
        })
        const firstTerminal = mocks.terminals[0]!

        fireEvent.click(screen.getByRole('tab', { name: 'Terminal 1' }))

        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Terminal 1' })).toHaveAttribute('aria-selected', 'true')
            expect(mocks.terminals).toHaveLength(2)
        })
        const secondTerminal = mocks.terminals[1]!
        expect(firstTerminal.dispose).toHaveBeenCalled()

        act(() => {
            mocks.outputHandler?.('after-switch')
        })
        expect(secondTerminal.write).toHaveBeenCalledWith('after-switch')

        act(() => {
            secondTerminal.emitData('x')
        })
        expect(mocks.write).toHaveBeenCalledWith('x')
        expect(mocks.detachTerminal).toHaveBeenCalledWith('terminal-2')
    })
})
