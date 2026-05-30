import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn()
}))

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    execSync: vi.fn()
}))

vi.mock('node:os', () => ({
    homedir: () => '/home/test'
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}))

const existsSyncMock = vi.mocked(existsSync)
const readFileSyncMock = vi.mocked(readFileSync)
const execFileSyncMock = vi.mocked(execFileSync)
const execSyncMock = vi.mocked(execSync)

afterEach(() => {
    vi.clearAllMocks()
    delete process.env.HAPI_CLAUDE_PATH
})

describe('resolveClaudeCodeExecutable', () => {
    it('uses HAPI_CLAUDE_PATH after validating the executable', async () => {
        process.env.HAPI_CLAUDE_PATH = '/opt/wrapper/claude'
        existsSyncMock.mockReturnValue(true)
        execFileSyncMock.mockReturnValue('1.0.0')

        const { resolveClaudeCodeExecutable } = await import('./utils')

        expect(resolveClaudeCodeExecutable()).toEqual({
            path: '/opt/wrapper/claude',
            source: 'env'
        })
        expect(execFileSyncMock).toHaveBeenCalledWith(
            '/opt/wrapper/claude',
            ['--version'],
            expect.objectContaining({
                timeout: 5_000
            })
        )
    })

    it('rejects a missing HAPI_CLAUDE_PATH', async () => {
        process.env.HAPI_CLAUDE_PATH = '/missing/claude'
        existsSyncMock.mockReturnValue(false)

        const { resolveClaudeCodeExecutable } = await import('./utils')

        expect(() => resolveClaudeCodeExecutable()).toThrow('HAPI_CLAUDE_PATH does not exist: /missing/claude')
    })

    it('reports preflight timeouts with wrapper guidance', async () => {
        process.env.HAPI_CLAUDE_PATH = '/opt/wrapper/claude'
        existsSyncMock.mockReturnValue(true)
        execFileSyncMock.mockImplementation(() => {
            const error = new Error('spawn timed out') as Error & { killed: boolean }
            error.killed = true
            throw error
        })

        const { resolveClaudeCodeExecutable } = await import('./utils')

        expect(() => resolveClaudeCodeExecutable()).toThrow('check for recursive invocation')
    })

    it('does not reject non-timeout --version failures for compatible wrappers', async () => {
        process.env.HAPI_CLAUDE_PATH = '/opt/wrapper/claude'
        existsSyncMock.mockReturnValue(true)
        execFileSyncMock.mockImplementation(() => {
            const error = new Error('unsupported flag') as Error & { status: number; stderr: Buffer }
            error.status = 1
            error.stderr = Buffer.from('unsupported flag')
            throw error
        })

        const { resolveClaudeCodeExecutable } = await import('./utils')

        expect(resolveClaudeCodeExecutable()).toEqual({
            path: '/opt/wrapper/claude',
            source: 'env'
        })
    })

    it('detects obvious wrapper recursion in script files', async () => {
        process.env.HAPI_CLAUDE_PATH = '/opt/wrapper/claude.cmd'
        existsSyncMock.mockReturnValue(true)
        readFileSyncMock.mockReturnValue('@echo off\n"/opt/wrapper/claude.cmd" %*\n')

        const { resolveClaudeCodeExecutable } = await import('./utils')

        expect(() => resolveClaudeCodeExecutable()).toThrow('wrapper appears to call itself')
        expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('detects Windows PATH wrappers that point back to HAPI_CLAUDE_PATH', async () => {
        process.env.HAPI_CLAUDE_PATH = 'C:\\Tools\\wrapper\\claude.exe'
        existsSyncMock.mockReturnValue(true)
        execSyncMock.mockImplementation((command) => {
            if (command === 'where claude') {
                return 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd'
            }
            return ''
        })
        readFileSyncMock.mockReturnValue('@echo off\n"C:\\Tools\\wrapper\\claude.exe" %*\n')

        const { resolveClaudeCodeExecutable } = await import('./utils')

        if (process.platform === 'win32') {
            expect(() => resolveClaudeCodeExecutable()).toThrow('may recurse through PATH wrapper')
            expect(execFileSyncMock).not.toHaveBeenCalled()
        } else {
            expect(resolveClaudeCodeExecutable()).toEqual({
                path: 'C:\\Tools\\wrapper\\claude.exe',
                source: 'env'
            })
        }
    })

    it('falls back to global claude when HAPI_CLAUDE_PATH is not set', async () => {
        existsSyncMock.mockImplementation((candidate) => String(candidate) === 'C:\\Tools\\claude.exe')
        execSyncMock.mockReturnValue('C:\\Tools\\claude.exe')

        const { resolveClaudeCodeExecutable } = await import('./utils')

        const resolved = resolveClaudeCodeExecutable()
        expect(resolved.source).toBe('auto')
        expect(resolved.path).toMatch(/claude(\.exe)?$/)
    })
})

describe('getClaudeCodeExecutableShell', () => {
    it('does not use shell for real executable paths on non-Windows platforms', async () => {
        const { getClaudeCodeExecutableShell } = await import('./utils')

        expect(getClaudeCodeExecutableShell('/opt/claude')).toBe(false)
    })
})
