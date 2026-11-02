import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { getSystemBootId, getProcessThreadGroupId, normalizeBootId } from './process'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const bootId = 'e7c92900-5693-4ba0-b40c-9dfc57512edb'
const read = vi.mocked(readFileSync)

function platform(value: string) {
    Object.defineProperty(process, 'platform', { configurable: true, value })
}

afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    read.mockReset()
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
