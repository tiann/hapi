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

    it('killProcessTreeByPid signals surviving descendants after taskkill /T misses them', async () => {
        // #1911 bot Major: taskkill /T exit 0 is "signalled", not "tree gone".
        // When the root dies but a grandchild survives (broken intermediate link),
        // individually signal survivors from the pre-kill snapshot — but only when
        // the process-generation marker still matches (PID reuse guard).
        const { killProcessTreeByPid } = await import('./process')
        const alive = new Set([100, 200]) // 100=root, 200=descendant
        const markers = new Map([[100, 'gen-100'], [200, 'gen-200']])
        const taskkillPids: number[] = []
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
                    return completed('OK:200,100')
                }
                // getProcessStartMarker CIM probe
                const filterMatch = /ProcessId = (\d+)/.exec(script)
                if (filterMatch) {
                    const pid = Number(filterMatch[1])
                    if (!alive.has(pid)) return completed('')
                    return completed(markers.get(pid) ?? '')
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
                const idx = args.indexOf('/PID')
                const pid = Number(args[idx + 1])
                taskkillPids.push(pid)
                alive.delete(pid)
                return completed('', 0)
            }
            return completed('')
        })

        const done = killProcessTreeByPid(100, true)
        await vi.advanceTimersByTimeAsync(500)
        await expect(done).resolves.toBe(true)
        expect(taskkillPids).toContain(100)
        expect(taskkillPids).toContain(200)
        expect(alive.size).toBe(0)
    })

    it('killProcessTreeByPid does not kill a surviving PID that was reused', async () => {
        const { killProcessTreeByPid } = await import('./process')
        const alive = new Set([100, 200])
        // After root kill, PID 200 is recycled with a new generation marker.
        let rootGone = false
        const taskkillPids: number[] = []
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
                    return completed('OK:200,100')
                }
                const filterMatch = /ProcessId = (\d+)/.exec(script)
                if (filterMatch) {
                    const pid = Number(filterMatch[1])
                    if (!alive.has(pid)) return completed('')
                    if (pid === 200 && rootGone) return completed('gen-200-reused')
                    return completed(pid === 100 ? 'gen-100' : 'gen-200')
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
                const idx = args.indexOf('/PID')
                const pid = Number(args[idx + 1])
                taskkillPids.push(pid)
                if (pid === 100) {
                    alive.delete(100)
                    rootGone = true
                } else {
                    alive.delete(pid)
                }
                return completed('', 0)
            }
            return completed('')
        })

        const done = killProcessTreeByPid(100, true)
        await vi.advanceTimersByTimeAsync(500)
        // Root signalled; reused descendant left alone → tree verify fails closed.
        await expect(done).resolves.toBe(false)
        expect(taskkillPids).toEqual([100])
        expect(alive.has(200)).toBe(true)
    })

    it('windowsProcessTreeCimCommand is newline-separated (WinPS-parseable)', async () => {
        // #1911 bot Major: `.join(' ')` yields `$seen=@{} $bfs=@()` — parse error.
        // Assert generated command text, not mocked stdout (mocks never parse PS).
        const { windowsProcessTreeCimCommand } = await import('./process')
        const cmd = windowsProcessTreeCimCommand(4242)
        expect(cmd).toContain('$root=4242')
        expect(cmd).toContain('ParentProcessId=$p')
        // Statements must be on separate lines — spaces between `$x=@{}` tokens fail.
        expect(cmd).toContain('\n$seen=@{}')
        expect(cmd).toContain('\n$bfs=@()')
        expect(cmd).toContain('\n$queue=@($root)')
        expect(cmd).toContain('\nwhile($queue.Count -gt 0){')
        // Space-join regression: adjacent statement tokens on one line (not newline).
        expect(cmd).not.toMatch(/\$seen=@\{\}[ ]+\$bfs=@\(\)/)
        expect(cmd).not.toMatch(/\$bfs=@\(\)[ ]+\$queue=@/)
        // Do not terminate `while(...){` with `;` (also invalid).
        expect(cmd).not.toMatch(/while\(\$queue\.Count -gt 0\)\{\s*;/)
        // #1911 B1: never SilentlyContinue — CIM failure must not look like childless root.
        expect(cmd).toContain("$ErrorActionPreference='Stop'")
        expect(cmd).toContain('trap { exit 1 }')
        expect(cmd).not.toContain('SilentlyContinue')
        expect(cmd).toContain('Write-Output ("OK:" + ($bfs -join ","))')
    })

    it('parseWindowsProcessTreeStdout requires OK: sentinel (B1 root-only is scan_failed)', async () => {
        const { parseWindowsProcessTreeStdout } = await import('./process')
        // Overseer measured: CIM failure with SilentlyContinue prints "1234" exit 0 —
        // byte-identical to healthy childless. Without OK: that must be scan_failed.
        expect(parseWindowsProcessTreeStdout('1234', 1234)).toBe('scan_failed')
        expect(parseWindowsProcessTreeStdout('4000,3000,2000,1234', 1234)).toBe('scan_failed')
        expect(parseWindowsProcessTreeStdout('', 1234)).toBe('scan_failed')
        expect(parseWindowsProcessTreeStdout('OK:', 1234)).toBe('scan_failed')
        expect(parseWindowsProcessTreeStdout('OK:1234', 1234)).toEqual([1234])
        expect(parseWindowsProcessTreeStdout('OK:4000,3000,2000,1234', 1234)).toEqual([
            4000, 3000, 2000, 1234,
        ])
        expect(parseWindowsProcessTreeStdout('OK:200,100', 100)).toEqual([200, 100])
        expect(parseWindowsProcessTreeStdout('OK:200,100', 999)).toBe('scan_failed')
    })

    it('killProcessTreeByPid treats bare root stdout (B1 fail-open shape) as scan_failed', async () => {
        const { killProcessTreeByPid } = await import('./process')
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
        spawnSyncMock.mockImplementation((cmd: string) => {
            // Status 0 + root-only — the measured CIM-failure shape under SilentlyContinue.
            if (cmd === 'powershell') return completed('1234')
            if (cmd === 'tasklist') {
                if (!alive) {
                    return completed('INFO: No tasks are running which match the specified criteria.')
                }
                return completed(`proc.exe                      1234 Console                    1     1,000 K`)
            }
            if (cmd === 'taskkill') {
                alive = false
                return completed('', 0)
            }
            return completed('')
        })
        const done = killProcessTreeByPid(1234, true)
        await vi.advanceTimersByTimeAsync(500)
        await expect(done).resolves.toBe(false)
        expect(spawnSyncMock.mock.calls.some((c) => c[0] === 'taskkill')).toBe(true)
    })

    it('killProcessTreeByPid signals root but returns false when Windows tree scan fails', async () => {
        const { killProcessTreeByPid } = await import('./process')
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
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'powershell') {
                return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('parse error') }
            }
            if (cmd === 'tasklist') {
                if (!alive) {
                    return completed('INFO: No tasks are running which match the specified criteria.')
                }
                return completed(`proc.exe                       100 Console                    1     1,000 K`)
            }
            if (cmd === 'taskkill') {
                alive = false
                return completed('', 0)
            }
            return completed('')
        })
        const done = killProcessTreeByPid(100, true)
        await vi.advanceTimersByTimeAsync(500)
        await expect(done).resolves.toBe(false)
        // Partial kill: root signalled, but never claim stopped without tree verify.
        expect(spawnSyncMock.mock.calls.some((c) => c[0] === 'taskkill')).toBe(true)
    })

    it('killProcessTreeByPid signals root but returns false when Windows tree scan returns empty stdout', async () => {
        const { killProcessTreeByPid } = await import('./process')
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
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'powershell') return completed('') // status 0, empty — scan_failed
            if (cmd === 'tasklist') {
                if (!alive) {
                    return completed('INFO: No tasks are running which match the specified criteria.')
                }
                return completed(`proc.exe                       100 Console                    1     1,000 K`)
            }
            if (cmd === 'taskkill') {
                alive = false
                return completed('', 0)
            }
            return completed('')
        })
        const done = killProcessTreeByPid(100, true)
        await vi.advanceTimersByTimeAsync(500)
        await expect(done).resolves.toBe(false)
        expect(spawnSyncMock.mock.calls.some((c) => c[0] === 'taskkill')).toBe(true)
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

    it('returns false when pgrep is missing (signal root, never claim stopped)', async () => {
        const { killProcessTreeByPid } = await import('./process')
        let dead = false
        vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
            if (signal === 0 || signal === undefined) {
                if (dead) {
                    const err = new Error('ESRCH') as NodeJS.ErrnoException
                    err.code = 'ESRCH'
                    throw err
                }
                return true
            }
            dead = true
            return true
        })
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'pgrep') return unavailable('pgrep')
            return completed('')
        })
        const done = killProcessTreeByPid(4242, true)
        await vi.advanceTimersByTimeAsync(3000)
        await expect(done).resolves.toBe(false)
        // Root still signalled — partial kill > zero kill on hosts without pgrep.
        expect(process.kill).toHaveBeenCalledWith(4242, 'SIGKILL')
    })

    it('returns false when pgrep is signalled (status null — partial tree)', async () => {
        const { killProcessTreeByPid } = await import('./process')
        let dead = false
        vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
            if (signal === 0 || signal === undefined) {
                if (dead) {
                    const err = new Error('ESRCH') as NodeJS.ErrnoException
                    err.code = 'ESRCH'
                    throw err
                }
                return true
            }
            dead = true
            return true
        })
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'pgrep') {
                return { status: null, stdout: '999\n', stderr: '', error: null }
            }
            return completed('')
        })
        const done = killProcessTreeByPid(4242, true)
        await vi.advanceTimersByTimeAsync(3000)
        await expect(done).resolves.toBe(false)
        expect(process.kill).toHaveBeenCalledWith(4242, 'SIGKILL')
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
