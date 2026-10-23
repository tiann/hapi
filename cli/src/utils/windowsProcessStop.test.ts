import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, syncMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), syncMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('cross-spawn', () => ({ default: { sync: syncMock } }))
import { killProcessTreeByPid } from './process'
import { readWindowsProcessTable, windowsGenerationMayBeAlive } from './windowsProcessStop'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
type Row = { ProcessId: number; ParentProcessId: number; CreationDate: string | null }
const row = (pid: number, parent = 0, marker: string | null = `gen-${pid}`): Row => ({
    ProcessId: pid, ParentProcessId: parent, CreationDate: marker
})

describe('Windows asynchronous tree stop', () => {
    let rows: Row[]
    let kills: Array<{ pid: number; force: boolean; tree: boolean }>
    let onKill: (pid: number, force: boolean) => void
    beforeEach(() => {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        rows = [row(0, 0, null), row(100), row(200, 100)]
        kills = []
        onKill = pid => { rows = rows.filter(p => p.ProcessId !== pid) }
        syncMock.mockReset().mockReturnValue({ status: 1, error: new Error('No synchronous probes permitted') })
        execFileMock.mockReset().mockImplementation((file, args, _options, callback) => {
            queueMicrotask(() => {
                if (file === 'powershell') {
                    callback(null, JSON.stringify({ complete: true, processes: rows }), '')
                } else {
                    const pid = Number(args[args.indexOf('/PID') + 1])
                    kills.push({ pid, force: args.includes('/F'), tree: args.includes('/T') })
                    onKill(pid, args.includes('/F'))
                    callback(null, '', '')
                }
            })
            return { kill: vi.fn() }
        })
    })
    afterEach(() => {
        Object.defineProperty(process, 'platform', originalPlatform)
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('confirms all descendants without blocking the runner with per-PID shell probes', async () => {
        await expect(killProcessTreeByPid(100, true)).resolves.toBe(true)
        expect(kills.map(k => k.pid)).toEqual([100, 200])
        expect(syncMock).not.toHaveBeenCalled()
    })

    it('does not terminate a PID reused after the original descendant exits', async () => {
        onKill = pid => {
            rows = rows.filter(p => p.ProcessId !== pid)
            if (pid === 100) rows = [row(0, 0, null), row(200, 0, 'new-generation')]
        }
        await expect(killProcessTreeByPid(100, true)).resolves.toBe(true)
        expect(kills.map(k => k.pid)).toEqual([100])
    })

    it('never treats a failed snapshot as proof of exit', async () => {
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            queueMicrotask(() => callback(new Error('CIM failed'), '', ''))
            return { kill: vi.fn() }
        })
        await expect(killProcessTreeByPid(100, true)).resolves.toBe(false)
        expect(kills).toEqual([])
    })

    it.each(['', '[]', '{"complete":true,"processes":[]}', '{"complete":false,"processes":[]}',
        '{"complete":true,"processes":[{"ProcessId":100}]}'])('rejects incomplete or malformed snapshot %s', async output => {
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            queueMicrotask(() => callback(null, output, ''))
            return { kill: vi.fn() }
        })
        expect(await readWindowsProcessTable()).toBeNull()
    })

    it('keeps ownership on failed or missing markers and recognizes only positive exit evidence', async () => {
        const table = await readWindowsProcessTable()
        expect(windowsGenerationMayBeAlive(null, 100, 'gen-100')).toBe(true)
        expect(windowsGenerationMayBeAlive(table, 100, 'gen-100')).toBe(true)
        expect(windowsGenerationMayBeAlive(table, 100, 'old-generation')).toBe(false)
        expect(windowsGenerationMayBeAlive(table, 999, 'gen-999')).toBe(false)
    })

    it('does not signal a root whose PID was reused between snapshots', async () => {
        let scans = 0
        const implementation = execFileMock.getMockImplementation()!
        execFileMock.mockImplementation((file, ...args) => {
            if (file === 'powershell' && ++scans === 2) rows = [row(0, 0, null), row(100, 0, 'new-root')]
            return implementation(file, ...args)
        })
        await expect(killProcessTreeByPid(100, true)).resolves.toBe(true)
        expect(kills).toEqual([])
    })

    it('keeps the Runner event loop responsive while OS probes are pending', async () => {
        const callbacks: Array<() => void> = []
        execFileMock.mockImplementation((_file, _args, _options, callback) => {
            callbacks.push(() => callback(new Error('probe unavailable'), '', ''))
            return { kill: vi.fn() }
        })
        const operation = killProcessTreeByPid(100, true)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(callbacks).toHaveLength(1)
        callbacks[0]()
        await expect(operation).resolves.toBe(false)
    })

    it('bounds an unkillable tree by elapsed time including OS queries', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        onKill = () => {}
        const operation = killProcessTreeByPid(100, true)
        await vi.advanceTimersByTimeAsync(46_000)
        await expect(operation).resolves.toBe(false)
        expect(kills.every(k => k.force)).toBe(true)
        expect(syncMock).not.toHaveBeenCalled()
    })
})
