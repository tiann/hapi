import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn()
}))

vi.mock('cross-spawn', () => ({
    default: {
        sync: spawnSyncMock
    }
}))

import { getHapiRunnerProcessIdentity, killProcess } from './process'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    })
}

function completed(stdout: string, status = 0) {
    return {
        status,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from('')
    }
}

function unavailable(command: string) {
    const error = new Error(`spawnSync ${command} ENOENT`) as NodeJS.ErrnoException
    error.code = 'ENOENT'
    return {
        status: null,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        error
    }
}

describe('getHapiRunnerProcessIdentity on Windows', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime')
        }
    })

    beforeEach(() => {
        setPlatform('win32')
        spawnSyncMock.mockReset()
        // Prefer signal-0 probe in these identity tests: tasklist falls through.
        spawnSyncMock.mockImplementation((cmd: string, ...rest: unknown[]) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            return completed('')
        })
        vi.spyOn(process, 'kill').mockReturnValue(true)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
    })

    it('reports a foreign process when CIM identifies it', () => {
        spawnSyncMock.mockImplementation((cmd: string, args?: string[]) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            if (cmd === 'powershell') return completed('C:\\Windows\\System32\\conhost.exe')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(8328)).toBe('foreign')
        expect(spawnSyncMock.mock.calls.some((call) => call[0] === 'powershell')).toBe(true)
    })

    it('reports the runner when CIM identifies it', () => {
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            if (cmd === 'powershell') return completed('hapi-local.exe runner start-sync')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
    })

    it('falls back to WMIC when PowerShell is unavailable', () => {
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            if (cmd === 'powershell') return unavailable('powershell')
            if (cmd === 'wmic') return completed('hapi-local.exe runner start-sync')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
        expect(spawnSyncMock.mock.calls.some((call) => call[0] === 'wmic')).toBe(true)
    })

    it('falls back to WMIC when CIM reports no command line', () => {
        let powershellCalls = 0
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            if (cmd === 'powershell') {
                powershellCalls += 1
                return completed('')
            }
            if (cmd === 'wmic') return completed('CommandLine\r\nhapi-local.exe runner start-sync\r\n')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
        expect(spawnSyncMock.mock.calls.some((call) => call[0] === 'wmic')).toBe(true)
    })

    it('reports unknown when WMIC prints only the column header', () => {
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            if (cmd === 'powershell') return completed('')
            if (cmd === 'wmic') return completed('CommandLine\r\n\r\n')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(8328)).toBe('unknown')
    })

    it('falls back to WMIC when PowerShell exits non-zero', () => {
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            if (cmd === 'powershell') return completed('', 1)
            if (cmd === 'wmic') return completed('hapi-local.exe runner start-sync')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
    })

    it('reports unknown when no probe reports a command line', () => {
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            if (cmd === 'powershell') return completed('')
            if (cmd === 'wmic') return unavailable('wmic')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(8328)).toBe('unknown')
    })

    it('reports dead when the pid exits while the probes run', () => {
        vi.spyOn(process, 'kill')
            .mockReturnValueOnce(true)
            .mockImplementationOnce(() => {
                throw new Error('ESRCH')
            })
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            return unavailable(cmd)
        })

        expect(getHapiRunnerProcessIdentity(8328)).toBe('dead')
    })

    it('reports dead without probing when the pid is already gone', () => {
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw new Error('ESRCH')
        })
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'tasklist') return unavailable('tasklist')
            return completed('')
        })

        expect(getHapiRunnerProcessIdentity(8328)).toBe('dead')
        expect(spawnSyncMock.mock.calls.every((call) => call[0] === 'tasklist')).toBe(true)
    })
})

describe('killProcess on Windows (orphanReap / stopSession)', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime')
        }
    })

    beforeEach(() => {
        setPlatform('win32')
        spawnSyncMock.mockReset()
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
    })

    it('escalates soft taskkill to /F when the process stays alive (mirrors SIGTERM→SIGKILL)', async () => {
        // Soft taskkill on win32 console trees often fails with
        // "can only be terminated forcefully" — orphanReap must escalate.
        let alive = true
        // Match @types/node process.kill(pid, signal?: string | number): true
        vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
            if (signal === 0 || signal === undefined) {
                if (!alive) {
                    const err = new Error('ESRCH') as NodeJS.ErrnoException
                    err.code = 'ESRCH'
                    throw err
                }
                return true
            }
            return true
        })
        spawnSyncMock.mockImplementation((cmd: string, args: string[] = []) => {
            if (cmd === 'tasklist') {
                if (!alive) {
                    return completed('INFO: No tasks are running which match the specified criteria.')
                }
                return completed(`hapi.exe                      5544 Console                    1     5,000 K`)
            }
            if (cmd !== 'taskkill') {
                return completed('')
            }
            if (args.includes('/F')) {
                alive = false
                return completed('', 0)
            }
            // Soft refuse — process still alive (real Windows console-tree behavior)
            return {
                status: 1,
                stdout: Buffer.from(''),
                stderr: Buffer.from('ERROR: This process can only be terminated forcefully (with /F option).')
            }
        })

        const done = killProcess(5544, false)
        // Soft fails → immediate /F; then brief death-poll timers
        await vi.advanceTimersByTimeAsync(500)
        await expect(done).resolves.toBe(true)

        const taskkills = spawnSyncMock.mock.calls.filter((call) => call[0] === 'taskkill')
        expect(taskkills.length).toBeGreaterThanOrEqual(2)
        expect(taskkills[0]![1]).toEqual(['/T', '/PID', '5544'])
        expect(taskkills.some((call) => (call[1] as string[]).includes('/F'))).toBe(true)
    })

    it('waits for grace when soft taskkill succeeds before escalating to /F', async () => {
        // Soft status=0 but PID still draining archive flush — do not /F immediately.
        let alive = true
        let softCalls = 0
        vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
            if (signal === 0 || signal === undefined) {
                if (!alive) {
                    const err = new Error('ESRCH') as NodeJS.ErrnoException
                    err.code = 'ESRCH'
                    throw err
                }
                return true
            }
            return true
        })
        spawnSyncMock.mockImplementation((cmd: string, args: string[] = []) => {
            if (cmd === 'tasklist') {
                if (!alive) {
                    return completed('INFO: No tasks are running which match the specified criteria.')
                }
                return completed(`hapi.exe                      7788 Console                    1     5,000 K`)
            }
            if (cmd === 'taskkill' && args.includes('/F')) {
                alive = false
                return completed('', 0)
            }
            if (cmd === 'taskkill') {
                softCalls += 1
                // Succeeds, but process remains alive until grace elapses
                return completed('', 0)
            }
            return completed('')
        })

        const done = killProcess(7788, false)
        // During grace, process exits without needing /F
        await vi.advanceTimersByTimeAsync(100)
        alive = false
        await vi.advanceTimersByTimeAsync(2_500)
        await expect(done).resolves.toBe(true)

        expect(softCalls).toBeGreaterThanOrEqual(1)
        const forceKills = spawnSyncMock.mock.calls.filter(
            (call) => call[0] === 'taskkill' && (call[1] as string[]).includes('/F')
        )
        expect(forceKills).toHaveLength(0)
    })

    it('uses forced taskkill immediately when force=true', async () => {
        let alive = true
        vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
            if (signal === 0 || signal === undefined) {
                if (!alive) {
                    const err = new Error('ESRCH') as NodeJS.ErrnoException
                    err.code = 'ESRCH'
                    throw err
                }
                return true
            }
            return true
        })
        spawnSyncMock.mockImplementation((cmd: string, args: string[] = []) => {
            if (cmd === 'tasklist') {
                if (!alive) {
                    return completed('INFO: No tasks are running which match the specified criteria.')
                }
                return completed(`hapi.exe                      9901 Console                    1     5,000 K`)
            }
            if (cmd === 'taskkill' && args.includes('/F')) {
                alive = false
                return completed('', 0)
            }
            return completed('', 1)
        })

        const done = killProcess(9901, true)
        await vi.advanceTimersByTimeAsync(500)
        await expect(done).resolves.toBe(true)

        const taskkills = spawnSyncMock.mock.calls.filter((call) => call[0] === 'taskkill')
        expect(taskkills).toHaveLength(1)
        expect(taskkills[0]![1]).toEqual(['/F', '/T', '/PID', '9901'])
    })

    it('killProcessTreeByPid returns false when a descendant survives after taskkill /T', async () => {
        // #1911 B2: taskkill /T exit 0 is "signalled", not "tree gone". Root may
        // die while claude.exe/node grandchild stays alive — must not report stopped.
        const { killProcessTreeByPid } = await import('./process')
        const alive = new Set([100, 200]) // 100=root, 200=descendant
        vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
            if (signal === 0 || signal === undefined) {
                if (!alive.has(pid)) {
                    const err = new Error('ESRCH') as NodeJS.ErrnoException
                    err.code = 'ESRCH'
                    throw err
                }
                return true
            }
            return true
        })
        spawnSyncMock.mockImplementation((cmd: string, args: string[] = []) => {
            if (cmd === 'powershell') {
                const script = String(args[args.length - 1] ?? '')
                if (script.includes('ParentProcessId')) {
                    // collectWindowsProcessTree: children-first then root
                    return completed('200,100')
                }
                return completed('')
            }
            if (cmd === 'tasklist') {
                const filter = args.find((a) => a.startsWith('PID eq '))
                const pid = filter ? Number(filter.replace('PID eq ', '')) : NaN
                if (!alive.has(pid)) {
                    return completed('INFO: No tasks are running which match the specified criteria.')
                }
                return completed(`proc.exe                       ${pid} Console                    1     1,000 K`)
            }
            if (cmd === 'taskkill') {
                // Root dies; descendant refuses — the false-stopped class.
                alive.delete(100)
                return completed('', 0)
            }
            return completed('')
        })

        const done = killProcessTreeByPid(100, true)
        await vi.advanceTimersByTimeAsync(500)
        await expect(done).resolves.toBe(false)
        expect(alive.has(200)).toBe(true)
    })
})

describe('killProcessTreeByPid on POSIX (pgrep tree scan)', () => {
    beforeEach(() => {
        setPlatform('linux')
        spawnSyncMock.mockReset()
        vi.spyOn(process, 'kill').mockReturnValue(true)
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
    })

    it('returns false when pgrep is missing (fail closed — do not verify root-only)', async () => {
        const { killProcessTreeByPid } = await import('./process')
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'pgrep') return unavailable('pgrep')
            return completed('')
        })
        await expect(killProcessTreeByPid(4242, true)).resolves.toBe(false)
        // Must not have signalled the root after a failed tree scan.
        expect(process.kill).not.toHaveBeenCalled()
    })
})

describe('getHapiRunnerProcessIdentity on POSIX', () => {
    beforeEach(() => {
        setPlatform('linux')
        spawnSyncMock.mockReset()
        vi.spyOn(process, 'kill').mockReturnValue(true)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
    })

    it('reports the runner from the ps command line', () => {
        spawnSyncMock.mockReturnValueOnce(completed('hapi runner start-sync'))

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
    })

    it('reports unknown when ps cannot report a command line', () => {
        spawnSyncMock.mockReturnValueOnce(completed(''))

        expect(getHapiRunnerProcessIdentity(8328)).toBe('unknown')
    })
})
