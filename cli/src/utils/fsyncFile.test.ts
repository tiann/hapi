import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ openSync: vi.fn(), fsyncSync: vi.fn(), closeSync: vi.fn() }))
vi.mock('node:fs', () => fs)
import { fsyncFile } from './fsyncFile'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { vi.resetAllMocks(); fs.openSync.mockReturnValue(17) })
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

describe('regular-file durability flush', () => {
    it.each(['linux', 'darwin', 'win32'] as const)('uses the required native handle access on %s', value => {
        Object.defineProperty(process, 'platform', { value, configurable: true })
        fsyncFile('native-or-journal.jsonl')
        expect(fs.openSync).toHaveBeenCalledWith('native-or-journal.jsonl', value === 'win32' ? 'r+' : 'r')
        expect(fs.fsyncSync).toHaveBeenCalledWith(17)
        expect(fs.closeSync).toHaveBeenCalledWith(17)
    })

    it('does not suppress a real flush error and always closes the handle', () => {
        fs.fsyncSync.mockImplementation(() => { throw new Error('flush failed') })
        expect(() => fsyncFile('native.jsonl')).toThrow('flush failed')
        expect(fs.closeSync).toHaveBeenCalledWith(17)
    })

    it('does not flush or close an unopened handle', () => {
        fs.openSync.mockImplementation(() => { throw new Error('open failed') })
        expect(() => fsyncFile('native.jsonl')).toThrow('open failed')
        expect(fs.fsyncSync).not.toHaveBeenCalled()
        expect(fs.closeSync).not.toHaveBeenCalled()
    })
})
