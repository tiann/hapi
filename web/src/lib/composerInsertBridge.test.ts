import { describe, expect, it, vi } from 'vitest'
import { insertIntoLiveComposer, padInsertion, registerComposerInserter } from './composerInsertBridge'

describe('composerInsertBridge', () => {
    it('routes inserts to the mounted composer for that session only', () => {
        const inserter = vi.fn()
        const unregister = registerComposerInserter('s1', inserter)
        expect(insertIntoLiveComposer('s1', '`a.ts`')).toBe(true)
        expect(insertIntoLiveComposer('s2', '`a.ts`')).toBe(false)
        expect(inserter).toHaveBeenCalledWith('`a.ts`')
        unregister()
        expect(insertIntoLiveComposer('s1', '`a.ts`')).toBe(false)
    })

    it('keeps a newer registration when an older composer unmounts late', () => {
        const older = vi.fn()
        const newer = vi.fn()
        const unregisterOlder = registerComposerInserter('s1', older)
        const unregisterNewer = registerComposerInserter('s1', newer)
        unregisterOlder()
        expect(insertIntoLiveComposer('s1', 'x')).toBe(true)
        expect(newer).toHaveBeenCalledWith('x')
        unregisterNewer()
    })

    it.each([
        ['', { start: 0, end: 0 }, 'ref '],
        ['look at', { start: 7, end: 7 }, ' ref '],
        ['look  here', { start: 5, end: 5 }, 'ref'],
        ['ab', { start: 1, end: 1 }, ' ref '],
        ['see\nnext', { start: 4, end: 4 }, 'ref '],
    ])('pads %j at %j', (text, selection, expected) => {
        expect(padInsertion(text, selection, 'ref')).toBe(expected)
    })
})
