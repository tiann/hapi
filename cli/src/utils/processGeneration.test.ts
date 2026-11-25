import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
}))

vi.mock('cross-spawn', () => ({
    default: { sync: spawnSyncMock },
}))

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import {
    getSystemBootId,
    getProcessThreadGroupId,
    normalizeBootId,
    classifyRetainedIdentity,
    killRetainedProcessTree,
    retainedIdentityStillAlive,
    type RetainedProcessIdentity,
} from './process'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const bootId = 'e7c92900-5693-4ba0-b40c-9dfc57512edb'
const read = vi.mocked(readFileSync)

function platform(value: string) {
    Object.defineProperty(process, 'platform', { configurable: true, value })
}

afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    read.mockReset()
    spawnSyncMock.mockReset()
    vi.restoreAllMocks()
})

describe('Linux recovered process identity', () => {
    it('reads and normalizes boot identity', () => {
        platform('linux')
        read.mockReturnValue(`${bootId.toUpperCase()}\n`)
        expect(getSystemBootId()).toBe(bootId)
        expect(read).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8')
    })

    it.each([undefined, null, '', 'invalid', 17])('rejects malformed boot identity %s', value => {
        expect(normalizeBootId(value)).toBeNull()
    })

    it('reads the exact thread group field', () => {
        platform('linux')
        read.mockReturnValue('Name:\tgdbus\nTgid:\t2067\nPid:\t2109\n')
        expect(getProcessThreadGroupId(2109)).toBe(2067)
        expect(read).toHaveBeenCalledWith('/proc/2109/status', 'utf8')
    })

    it.each(['Tgid: 0', 'Tgid: -1', 'Tgid: 12junk', 'NotTgid: 12', 'Tgid: 9007199254740992'])('does not invent evidence from %s', value => {
        platform('linux')
        read.mockReturnValue(value)
        expect(getProcessThreadGroupId(2109)).toBeNull()
    })

    it('keeps unavailable procfs evidence unknown', () => {
        platform('linux')
        read.mockImplementation(() => { throw new Error('EACCES') })
        expect(getSystemBootId()).toBeNull()
        expect(getProcessThreadGroupId(2109)).toBeNull()
    })

    it.each(['win32', 'darwin'])('does not probe procfs on %s', value => {
        platform(value)
        expect(getSystemBootId()).toBeNull()
        expect(getProcessThreadGroupId(2109)).toBeNull()
        expect(read).not.toHaveBeenCalled()
    })

    it.each([0, -1, NaN, 1.5, Infinity])('does not probe invalid pid %s', value => {
        platform('linux')
        expect(getProcessThreadGroupId(value)).toBeNull()
        expect(read).not.toHaveBeenCalled()
    })
})

describe('retained process identity classification (#2021)', () => {
    const identity = (overrides: Partial<RetainedProcessIdentity> = {}): RetainedProcessIdentity => ({
        pid: 4242,
        startMarker: 'Wed Nov 25 00:00:00 2026',
        bootId,
        tgid: 4242,
        ...overrides,
    })

    beforeEach(() => {
        platform('linux')
        spawnSyncMock.mockReset()
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (signal === 0 || signal === undefined) return true
            return true
        }) as typeof process.kill)
    })

    function mockPsMarker(marker: string | null, status = 0) {
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'ps') {
                return {
                    status: marker === null ? 1 : status,
                    stdout: marker ?? '',
                    stderr: '',
                    error: null,
                }
            }
            return { status: 1, stdout: '', stderr: '', error: null }
        })
    }

    it('distinguishes match, gone, and unknown — signals only confirmed matches', async () => {
        mockPsMarker('Wed Nov 25 00:00:00 2026')
        expect(classifyRetainedIdentity(identity())).toBe('match')
        expect(retainedIdentityStillAlive(identity())).toBe(true)

        mockPsMarker('Thu Nov 26 00:00:00 2026')
        expect(classifyRetainedIdentity(identity())).toBe('gone')
        expect(retainedIdentityStillAlive(identity())).toBe(false)

        // Probe failed while PID appears alive → unknown (do not signal).
        mockPsMarker(null)
        expect(classifyRetainedIdentity(identity())).toBe('unknown')
        expect(retainedIdentityStillAlive(identity())).toBe(true)

        // Alive without a start-marker cannot confirm generation (boot+tgid alone).
        expect(classifyRetainedIdentity(identity({ startMarker: null }))).toBe('unknown')

        vi.mocked(process.kill).mockImplementation((() => {
            throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
        }) as typeof process.kill)
        expect(classifyRetainedIdentity(identity())).toBe('gone')

        // Restore alive + failed marker: killRetained must not signal, return false.
        vi.mocked(process.kill).mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (signal === 0) return true
            throw new Error('should not signal unknown identity')
        }) as typeof process.kill)
        mockPsMarker(null)
        expect(await killRetainedProcessTree([identity()])).toBe(false)

        // Confirmed match then gone after kill → verified.
        let alive = true
        const signals: Array<NodeJS.Signals | number | undefined> = []
        vi.mocked(process.kill).mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (signal === 0) {
                if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
                return true
            }
            signals.push(signal)
            alive = false
            return true
        }) as typeof process.kill)
        mockPsMarker('Wed Nov 25 00:00:00 2026')
        expect(await killRetainedProcessTree([identity()], true)).toBe(true)
        expect(signals).toEqual(['SIGKILL'])

        // Generation changes after SIGTERM — must not escalate SIGKILL to the replacement.
        alive = true
        let marker = 'Wed Nov 25 00:00:00 2026'
        signals.length = 0
        mockPsMarker(marker)
        spawnSyncMock.mockImplementation((cmd: string) => {
            if (cmd === 'ps') {
                return { status: 0, stdout: marker, stderr: '', error: null }
            }
            return { status: 1, stdout: '', stderr: '', error: null }
        })
        vi.mocked(process.kill).mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (signal === 0) return true
            signals.push(signal)
            if (signal === 'SIGTERM') {
                marker = 'Thu Nov 26 00:00:00 2026' // PID reused during grace
            }
            return true
        }) as typeof process.kill)
        expect(await killRetainedProcessTree([identity()], false)).toBe(true)
        expect(signals).toEqual(['SIGTERM'])
        expect(signals).not.toContain('SIGKILL')
    })
})
