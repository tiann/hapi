import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    addScratchlistEntry,
    clearScratchlist,
    deleteScratchlistEntry,
    moveScratchlistEntry,
    persistScratchlist,
    readScratchlist,
    SCRATCHLIST_CONFIRM_DELETE_THRESHOLD,
    SCRATCHLIST_MAX_ENTRIES,
    SCRATCHLIST_MAX_TEXT_LENGTH,
    shouldConfirmDelete,
    type ScratchlistEntry,
} from './scratchlist'

const SID = 'session-test'

function makeEntry(overrides: Partial<ScratchlistEntry> & { id: string }): ScratchlistEntry {
    return {
        text: 'note',
        createdAt: 1000,
        ...overrides,
    }
}

describe('addScratchlistEntry', () => {
    it('prepends new entries (newest-first ordering)', () => {
        const initial: ScratchlistEntry[] = [makeEntry({ id: 'old', text: 'older' })]
        const { entries, added } = addScratchlistEntry(initial, 'newer', 2000)
        expect(added?.text).toBe('newer')
        expect(added?.createdAt).toBe(2000)
        expect(entries.map((e) => e.text)).toEqual(['newer', 'older'])
    })

    it('rejects empty / whitespace-only input', () => {
        const initial: ScratchlistEntry[] = [makeEntry({ id: 'a' })]
        expect(addScratchlistEntry(initial, '').added).toBeNull()
        expect(addScratchlistEntry(initial, '   ').added).toBeNull()
        expect(addScratchlistEntry(initial, '\n\t').added).toBeNull()
        expect(addScratchlistEntry(initial, '   ').entries).toBe(initial)
    })

    it('trims surrounding whitespace before storing', () => {
        const { added } = addScratchlistEntry([], '  hello world  \n', 1000)
        expect(added?.text).toBe('hello world')
    })

    it('truncates entries longer than the per-entry cap rather than rejecting', () => {
        const huge = 'x'.repeat(SCRATCHLIST_MAX_TEXT_LENGTH + 50)
        const { added } = addScratchlistEntry([], huge)
        expect(added).not.toBeNull()
        expect(added!.text.length).toBe(SCRATCHLIST_MAX_TEXT_LENGTH)
    })

    it('caps the list at SCRATCHLIST_MAX_ENTRIES (drops oldest tail)', () => {
        const initial: ScratchlistEntry[] = []
        for (let i = 0; i < SCRATCHLIST_MAX_ENTRIES; i++) {
            initial.push(makeEntry({ id: `e${i}`, text: `entry-${i}` }))
        }
        const { entries } = addScratchlistEntry(initial, 'fresh')
        expect(entries.length).toBe(SCRATCHLIST_MAX_ENTRIES)
        expect(entries[0]?.text).toBe('fresh')
        // The previous tail entry (oldest) should be dropped after cap-trim.
        expect(entries[entries.length - 1]?.text).toBe(
            initial[SCRATCHLIST_MAX_ENTRIES - 2]?.text
        )
    })

    it('assigns unique ids to consecutive entries', () => {
        const a = addScratchlistEntry([], 'one').added
        const b = addScratchlistEntry([], 'two').added
        expect(a?.id).toBeTruthy()
        expect(b?.id).toBeTruthy()
        expect(a?.id).not.toBe(b?.id)
    })
})

describe('deleteScratchlistEntry', () => {
    it('removes the entry with the matching id', () => {
        const entries: ScratchlistEntry[] = [
            makeEntry({ id: 'a' }),
            makeEntry({ id: 'b' }),
            makeEntry({ id: 'c' }),
        ]
        expect(deleteScratchlistEntry(entries, 'b').map((e) => e.id)).toEqual(['a', 'c'])
    })

    it('is a no-op for unknown ids', () => {
        const entries: ScratchlistEntry[] = [makeEntry({ id: 'a' })]
        expect(deleteScratchlistEntry(entries, 'missing')).toEqual(entries)
    })
})

describe('moveScratchlistEntry', () => {
    function ids(entries: ScratchlistEntry[]): string[] {
        return entries.map((e) => e.id)
    }

    const sample: ScratchlistEntry[] = [
        makeEntry({ id: 'a' }),
        makeEntry({ id: 'b' }),
        makeEntry({ id: 'c' }),
    ]

    it('moves an entry up by one position', () => {
        expect(ids(moveScratchlistEntry(sample, 'b', 'up'))).toEqual(['b', 'a', 'c'])
    })

    it('moves an entry down by one position', () => {
        expect(ids(moveScratchlistEntry(sample, 'b', 'down'))).toEqual(['a', 'c', 'b'])
    })

    it('is a no-op when moving the first entry up', () => {
        expect(moveScratchlistEntry(sample, 'a', 'up')).toBe(sample)
    })

    it('is a no-op when moving the last entry down', () => {
        expect(moveScratchlistEntry(sample, 'c', 'down')).toBe(sample)
    })

    it('is a no-op for unknown ids', () => {
        expect(moveScratchlistEntry(sample, 'missing', 'up')).toBe(sample)
    })
})

describe('shouldConfirmDelete', () => {
    it('confirms only when entry text exceeds the threshold', () => {
        const short = makeEntry({ id: 'a', text: 'x'.repeat(SCRATCHLIST_CONFIRM_DELETE_THRESHOLD) })
        const long = makeEntry({ id: 'b', text: 'x'.repeat(SCRATCHLIST_CONFIRM_DELETE_THRESHOLD + 1) })
        expect(shouldConfirmDelete(short)).toBe(false)
        expect(shouldConfirmDelete(long)).toBe(true)
    })

    it('returns false for null / undefined entries', () => {
        expect(shouldConfirmDelete(null)).toBe(false)
        expect(shouldConfirmDelete(undefined)).toBe(false)
    })
})

describe('localStorage round-trip', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('persists and reads back entries scoped per session', () => {
        const entriesA: ScratchlistEntry[] = [
            makeEntry({ id: 'a1', text: 'a-one' }),
            makeEntry({ id: 'a2', text: 'a-two' }),
        ]
        const entriesB: ScratchlistEntry[] = [makeEntry({ id: 'b1', text: 'b-one' })]
        persistScratchlist('session-a', entriesA)
        persistScratchlist('session-b', entriesB)

        expect(readScratchlist('session-a')).toEqual(entriesA)
        expect(readScratchlist('session-b')).toEqual(entriesB)
    })

    it('returns [] for an unknown session', () => {
        expect(readScratchlist('never-written')).toEqual([])
    })

    it('clears entries for a session', () => {
        persistScratchlist(SID, [makeEntry({ id: 'a' })])
        clearScratchlist(SID)
        expect(readScratchlist(SID)).toEqual([])
    })

    it('returns [] when stored value is malformed JSON', () => {
        localStorage.setItem(`hapi.scratchlist.v1.${SID}`, '{not-json')
        expect(readScratchlist(SID)).toEqual([])
    })

    it('skips invalid entries inside the stored array (forward compatibility)', () => {
        const valid = makeEntry({ id: 'valid', text: 'ok' })
        localStorage.setItem(
            `hapi.scratchlist.v1.${SID}`,
            JSON.stringify([
                valid,
                { id: '', text: 'no id', createdAt: 1 }, // invalid id
                { id: 'x', text: 5, createdAt: 1 }, // wrong text type
                'string entry', // wrong shape
                null,
            ])
        )
        const got = readScratchlist(SID)
        expect(got).toEqual([valid])
    })

    it('survives localStorage write failures', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded')
        })
        expect(() => persistScratchlist(SID, [makeEntry({ id: 'a' })])).not.toThrow()
        setItem.mockRestore()
    })
})
