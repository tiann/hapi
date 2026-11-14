import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileSync, getProcessStartMarker, getSystemBootId } = vi.hoisted(() => ({
    readFileSync: vi.fn(),
    getProcessStartMarker: vi.fn(),
    getSystemBootId: vi.fn()
}))
vi.mock('node:fs', () => ({ readFileSync }))
vi.mock('@/utils/process', () => ({ getProcessStartMarker, getSystemBootId }))

import { getSessionProcessMarker } from './sessionProcessMarker'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const bootId = '11111111-2222-3333-4444-555555555555'
function stat(start: string, comm = 'worker') {
    return `42 (${comm}) S ${Array(18).fill('0').join(' ')} ${start} 0 0\n`
}

beforeEach(() => {
    vi.resetAllMocks()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    getSystemBootId.mockReturnValue(bootId)
    readFileSync.mockReturnValue(stat('123456'))
    getProcessStartMarker.mockImplementation(() => { throw new Error('spawnSync ps ENOENT') })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

describe('Linux session lease generations', () => {
    it('uses readable proc data without invoking an unavailable ps', () => {
        readFileSync.mockReturnValue(stat('123456', 'worker ) with ( spaces'))
        expect(getSessionProcessMarker(42)).toBe(`linux:${bootId}:123456`)
        expect(readFileSync).toHaveBeenCalledExactlyOnceWith('/proc/42/stat', 'utf8')
        expect(getProcessStartMarker).not.toHaveBeenCalled()
    })

    it('distinguishes PID reuse and boots even when start ticks repeat', () => {
        const first = getSessionProcessMarker(42)
        readFileSync.mockReturnValue(stat('123457'))
        expect(getSessionProcessMarker(42)).not.toBe(first)
        readFileSync.mockReturnValue(stat('123456'))
        getSystemBootId.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
        expect(getSessionProcessMarker(42)).not.toBe(first)
    })

    it.each(['43 (worker) S ' + Array(18).fill('0').join(' ') + ' 123',
        '42 (worker S 123', '42 (worker) S 0', stat('invalid')])(
        'returns unknown for malformed or mismatched kernel data: %s', value => {
            readFileSync.mockReturnValue(value)
            expect(getSessionProcessMarker(42)).toBeNull()
            expect(getProcessStartMarker).not.toHaveBeenCalled()
        }
    )

    it('preserves unknown identity when proc is unreadable or the boot is unknown', () => {
        readFileSync.mockImplementation(() => { throw new Error('EACCES') })
        expect(getSessionProcessMarker(42)).toBeNull()
        getSystemBootId.mockReturnValue(null)
        expect(getSessionProcessMarker(42)).toBeNull()
        expect(getProcessStartMarker).not.toHaveBeenCalled()
    })

    it.each([0, -1, 1.5, NaN, Infinity])('does not probe invalid PID %s', pid => {
        expect(getSessionProcessMarker(pid)).toBeNull()
        expect(readFileSync).not.toHaveBeenCalled()
        expect(getSystemBootId).not.toHaveBeenCalled()
    })

    it.each(['darwin', 'win32'])('preserves the existing %s probe', target => {
        Object.defineProperty(process, 'platform', { value: target, configurable: true })
        getProcessStartMarker.mockReturnValue('existing-generation')
        expect(getSessionProcessMarker(42)).toBe('existing-generation')
        expect(getProcessStartMarker).toHaveBeenCalledExactlyOnceWith(42)
        expect(readFileSync).not.toHaveBeenCalled()
        expect(getSystemBootId).not.toHaveBeenCalled()
    })
})
