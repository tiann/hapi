import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    TerminalManager,
    buildFilteredEnv,
    normalizeTerminalInputForHost,
    resolveShellCommand
} from './TerminalManager'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const originalTerminalShell = process.env.HAPI_TERMINAL_SHELL
const originalComSpec = process.env.ComSpec
const globalWithBun = globalThis as unknown as {
    Bun?: {
        spawn?: unknown
        which?: unknown
    }
}
const originalBun = globalWithBun.Bun

function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    })
}

describe('buildFilteredEnv web Terminal PTY', () => {
    it('strips secrets and agent-context markers and sets HAPI_USER_TERMINAL', () => {
        const env = buildFilteredEnv({
            PATH: '/usr/bin',
            HOME: '/home/op',
            HAPI_SESSION_ID: 'hub-session-1',
            HAPI_AGENT_CONTEXT: '1',
            CURSOR_AGENT: '1',
            CURSOR_AGENT_SESSION_ID: 'cursor-sess',
            CLAUDECODE: '1',
            CLI_API_TOKEN: 'secret-token',
            OPENAI_API_KEY: 'sk-test',
            TERM: 'xterm-256color',
        })

        expect(env.HAPI_USER_TERMINAL).toBe('1')
        expect(env.HAPI_SESSION_ID).toBe('hub-session-1')
        expect(env.PATH).toBe('/usr/bin')
        expect(env.HAPI_AGENT_CONTEXT).toBeUndefined()
        expect(env.CURSOR_AGENT).toBeUndefined()
        expect(env.CURSOR_AGENT_SESSION_ID).toBeUndefined()
        expect(env.CLAUDECODE).toBeUndefined()
        expect(env.CLI_API_TOKEN).toBeUndefined()
        expect(env.OPENAI_API_KEY).toBeUndefined()
    })

    it('passes filtered env into Bun.spawn for a new terminal', () => {
        const previousAgentContext = process.env.HAPI_AGENT_CONTEXT
        const previousCursorAgent = process.env.CURSOR_AGENT
        process.env.HAPI_AGENT_CONTEXT = '1'
        process.env.CURSOR_AGENT = '1'

        const terminal = {
            write: vi.fn(),
            resize: vi.fn(),
            close: vi.fn()
        } as unknown as Bun.Terminal
        const proc = {
            terminal,
            killed: false,
            exitCode: null,
            signalCode: null,
            kill: vi.fn()
        } as unknown as Bun.Subprocess
        const spawnMock = vi.fn((_cmd: string[], _opts: { env?: NodeJS.ProcessEnv }) => proc)
        const previousBun = globalWithBun.Bun
        globalWithBun.Bun = { spawn: spawnMock }

        try {
            const manager = new TerminalManager({
                sessionId: 'session-env',
                getSessionPath: () => '/tmp/project',
                onReady: () => {},
                onOutput: () => {},
                onExit: () => {},
                onError: () => {},
                idleTimeoutMs: 0
            })
            manager.create('term-env', 80, 24)

            expect(spawnMock).toHaveBeenCalled()
            const spawnEnv = spawnMock.mock.calls[0]?.[1]?.env
            expect(spawnEnv?.HAPI_USER_TERMINAL).toBe('1')
            expect(spawnEnv?.HAPI_AGENT_CONTEXT).toBeUndefined()
            expect(spawnEnv?.CURSOR_AGENT).toBeUndefined()
        } finally {
            globalWithBun.Bun = previousBun
            if (previousAgentContext === undefined) {
                delete process.env.HAPI_AGENT_CONTEXT
            } else {
                process.env.HAPI_AGENT_CONTEXT = previousAgentContext
            }
            if (previousCursorAgent === undefined) {
                delete process.env.CURSOR_AGENT
            } else {
                process.env.CURSOR_AGENT = previousCursorAgent
            }
        }
    })
})

describe('TerminalManager Windows support', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime')
        }
    })

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
        process.env.HAPI_TERMINAL_SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
        setPlatform('win32')
    })

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
        if (originalBun === undefined) {
            delete globalWithBun.Bun
        } else {
            globalWithBun.Bun = originalBun
        }
        if (originalTerminalShell === undefined) {
            delete process.env.HAPI_TERMINAL_SHELL
        } else {
            process.env.HAPI_TERMINAL_SHELL = originalTerminalShell
        }
        if (originalComSpec === undefined) {
            delete process.env.ComSpec
        } else {
            process.env.ComSpec = originalComSpec
        }
    })

    it('resolves an explicit Windows terminal shell command', () => {
        expect(resolveShellCommand()).toEqual(['C:\\Program Files\\PowerShell\\7\\pwsh.exe'])
    })

    it('normalizes lone line feeds to carriage returns for Windows terminal input', () => {
        expect(normalizeTerminalInputForHost('echo one\nsecond\r\nthird\n')).toBe('echo one\rsecond\r\nthird\r')
    })

    it('opens a Windows PTY instead of rejecting the request', () => {
        const terminal = {
            write: vi.fn(),
            resize: vi.fn(),
            close: vi.fn()
        } as unknown as Bun.Terminal

        const proc = {
            terminal,
            killed: false,
            exitCode: null,
            signalCode: null,
            kill: vi.fn()
        } as unknown as Bun.Subprocess

        const spawnMock = vi.fn(() => proc)
        globalWithBun.Bun = {
            spawn: spawnMock
        }

        const ready: unknown[] = []
        const errors: unknown[] = []
        const manager = new TerminalManager({
            sessionId: 'session-1',
            getSessionPath: () => 'C:\\workspace\\project',
            onReady: (payload) => ready.push(payload),
            onOutput: () => {},
            onExit: () => {},
            onError: (payload) => errors.push(payload),
            idleTimeoutMs: 0
        })

        manager.create('terminal-1', 120, 30)
        manager.write('terminal-1', 'echo one\n')

        expect(errors).toEqual([])
        expect(ready).toEqual([{ sessionId: 'session-1', terminalId: 'terminal-1' }])
        expect(spawnMock).toHaveBeenCalledWith(
            ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
            expect.objectContaining({
                cwd: 'C:\\workspace\\project',
                terminal: expect.objectContaining({
                    cols: 120,
                    rows: 30
                })
            })
        )
        expect(terminal.write).toHaveBeenCalledWith('echo one\r')
    })
})
