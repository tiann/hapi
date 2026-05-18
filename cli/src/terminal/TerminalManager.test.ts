import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    TerminalManager,
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
