import { render, screen, waitFor } from '@testing-library/react'
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
let remoteTerminals: Array<{ terminalId: string; createdAt: number; attached: boolean }> = []
let hasLoadedTerminals = true
let maxTerminals = 4

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
        maxTerminals,
        hasLoadedTerminals,
        connect: connectMock,
        refreshTerminals: refreshTerminalsMock,
        createTerminal: createTerminalMock,
        detachTerminal: detachTerminalMock,
        closeTerminal: closeTerminalMock,
        write: writeMock,
        resize: resizeMock,
        disconnect: disconnectMock,
        onOutput: vi.fn(),
        onExit: vi.fn()
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

describe('TerminalPage localization', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        remoteTerminals = []
        hasLoadedTerminals = true
        maxTerminals = 4
        window.localStorage.clear()
        window.localStorage.setItem('hapi-lang', 'zh-CN')
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

    it('localizes selector, attach hint, close/new actions, and max-limit text in zh-CN', async () => {
        remoteTerminals = [
            { terminalId: 'terminal-1', createdAt: 1, attached: true },
            { terminalId: 'terminal-2', createdAt: 2, attached: false }
        ]
        maxTerminals = 2
        render(page())

        await waitFor(() => {
            expect(screen.getByRole('tab', { name: '终端 2' })).toHaveAttribute('aria-selected', 'true')
        })

        expect(screen.getByRole('tablist', { name: '终端会话' })).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: '终端 1' })).toHaveAttribute(
            'title',
            '终端 1 也已在另一个窗口中连接。'
        )
        expect(screen.getByRole('button', { name: '关闭终端 1' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '新建终端' })).toHaveAttribute('title', '最多 2 个终端')
        expect(screen.getByText('终端')).toBeInTheDocument()
    })

    it('localizes loading and empty terminal inventory states in zh-CN', async () => {
        hasLoadedTerminals = false
        const view = render(page())
        expect(screen.getByText('正在加载终端…')).toBeInTheDocument()

        hasLoadedTerminals = true
        view.rerender(page())

        await waitFor(() => expect(screen.getByText('未选择终端。')).toBeInTheDocument())
        expect(screen.getAllByRole('button', { name: '新建终端' }).length).toBeGreaterThan(0)
    })
})
