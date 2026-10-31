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
    let rejectSoft: boolean
    beforeEach(() => {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        rows = [row(0, 0, null), row(100), row(200, 100)]
        kills = []
        rejectSoft = false
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
                    callback(rejectSoft && !args.includes('/F') ? new Error('Soft termination refused') : null, '', '')
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

    it.each(['refused', 'grace-expired'])('force-stops new descendants tree-wide when soft termination is %s', async reason => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        rejectSoft = reason === 'refused'
        onKill = (pid, force) => {
            if (!force) { rows.push(row(300, 100)); return }
            if (pid === 100 && kills.at(-1)?.tree) rows = [row(0, 0, null)]
            else rows = rows.filter(p => p.ProcessId !== pid)
        }
        const operation = killProcessTreeByPid(100, false)
        await vi.advanceTimersByTimeAsync(3_000)
        await expect(operation).resolves.toBe(true)
        expect(kills).toContainEqual({ pid: 100, force: true, tree: true })
        expect(rows.some(p => p.ProcessId === 300)).toBe(false)
    })

    it('does not confirm cleanup if a newly discovered descendant survives forced tree termination', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        rejectSoft = true
        onKill = (pid, force) => {
            if (!force) { rows.push(row(300, 100)); return }
            if (pid !== 300) rows = rows.filter(p => p.ProcessId !== pid)
        }
        const operation = killProcessTreeByPid(100, false)
        await vi.advanceTimersByTimeAsync(46_000)
        await expect(operation).resolves.toBe(false)
        expect(rows.some(p => p.ProcessId === 300)).toBe(true)
    })

    it('does not force a replacement root or its new children after soft termination', async () => {
        rejectSoft = true
        onKill = (pid, force) => {
            if (!force) {
                rows = [row(0, 0, null), row(100, 0, 'replacement-root'), row(200, 100), row(300, 100)]
                return
            }
            rows = rows.filter(p => p.ProcessId !== pid)
        }
        await expect(killProcessTreeByPid(100, false)).resolves.toBe(true)
        expect(kills.filter(k => k.force).map(k => k.pid)).toEqual([200])
        expect(rows.map(p => p.ProcessId)).toContain(300)
    })

    it.each([false, true])('terminates late descendants behind an exited intermediate process (force=%s)', async force => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        rows = [row(0, 0, null), row(100), row(200, 100), row(300, 200)]
        onKill = (pid) => {
            if (pid === 100) { rows = [row(0, 0, null), row(300, 200), row(400, 300)]; return }
            if (pid === 300 && kills.at(-1)?.tree) rows = [row(0, 0, null)]
            else rows = rows.filter(p => p.ProcessId !== pid)
        }
        const operation = killProcessTreeByPid(100, force)
        await vi.advanceTimersByTimeAsync(3_000)
        await expect(operation).resolves.toBe(true)
        expect(kills).toContainEqual({ pid: 300, force: true, tree: true })
        expect(rows.some(p => p.ProcessId === 400)).toBe(false)
    })

    it('does not confirm a disconnected survivor subtree while its new child remains alive', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        rows = [row(0, 0, null), row(100), row(200, 100), row(300, 200)]
        onKill = pid => {
            if (pid === 100) { rows = [row(0, 0, null), row(300, 200), row(400, 300)]; return }
            if (pid !== 400) rows = rows.filter(p => p.ProcessId !== pid)
        }
        const operation = killProcessTreeByPid(100, true)
        await vi.advanceTimersByTimeAsync(46_000)
        await expect(operation).resolves.toBe(false)
        expect(rows.some(p => p.ProcessId === 400)).toBe(true)
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
