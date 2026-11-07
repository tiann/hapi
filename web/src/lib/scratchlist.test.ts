import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    addScratchlistEntry,
    clearScratchlist,
    deleteScratchlistEntry,
    moveScratchlistEntry,
    persistScratchlist,
    reorderScratchlistEntry,
    readScratchlist,
    SCRATCHLIST_MAX_ENTRIES,
    SCRATCHLIST_MAX_TEXT_LENGTH,
    updateScratchlistEntry,
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

describe('reorderScratchlistEntry', () => {
    function ids(entries: ScratchlistEntry[]): string[] {
        return entries.map((e) => e.id)
    }

    const sample: ScratchlistEntry[] = [
        makeEntry({ id: 'a' }),
        makeEntry({ id: 'b' }),
        makeEntry({ id: 'c' }),
    ]

    it('moves an entry to a target index', () => {
        expect(ids(reorderScratchlistEntry(sample, 'a', 2))).toEqual(['b', 'c', 'a'])
        expect(ids(reorderScratchlistEntry(sample, 'c', 0))).toEqual(['c', 'a', 'b'])
    })

    it('clamps out-of-range target indexes', () => {
        expect(ids(reorderScratchlistEntry(sample, 'a', 99))).toEqual(['b', 'c', 'a'])
        expect(ids(reorderScratchlistEntry(sample, 'c', -1))).toEqual(['c', 'a', 'b'])
    })

    it('returns the same list for an unknown id, invalid index, or no-op', () => {
        expect(reorderScratchlistEntry(sample, 'missing', 1)).toBe(sample)
        expect(reorderScratchlistEntry(sample, 'a', 1.5)).toBe(sample)
        expect(reorderScratchlistEntry(sample, 'b', 1)).toBe(sample)
    })
})

describe('updateScratchlistEntry', () => {
    it('normalizes text, records the update time, and preserves other entries', () => {
        const sample = [
            makeEntry({ id: 'a', text: 'before' }),
            makeEntry({ id: 'b', text: 'untouched' }),
        ]
        const next = updateScratchlistEntry(sample, 'a', '  after  \n', 2000)
        expect(next.map((entry) => entry.text)).toEqual(['after', 'untouched'])
        expect(next[0]?.updatedAt).toBe(2000)
        expect(next[1]).toBe(sample[1])
    })

    it('rejects empty edits and truncates overlong edits', () => {
        const sample = [makeEntry({ id: 'a', text: 'before' })]
        expect(updateScratchlistEntry(sample, 'a', '   ')).toBe(sample)
        const next = updateScratchlistEntry(sample, 'a', 'x'.repeat(SCRATCHLIST_MAX_TEXT_LENGTH + 10))
        expect(next[0]?.text).toHaveLength(SCRATCHLIST_MAX_TEXT_LENGTH)
    })

    it('updates attachment metadata without changing the entry text', () => {
        const attachment = {
            id: 'photo-1',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-test/photo-1.png',
        } as NonNullable<ScratchlistEntry['attachments']>[number]
        const sample = [makeEntry({ id: 'a', text: 'with photo', attachments: [attachment] })]

        const next = updateScratchlistEntry(sample, 'a', 'with photo', 2000, [])

        expect(next[0]?.text).toBe('with photo')
        expect(next[0]?.attachments).toEqual([])
        expect(next[0]?.updatedAt).toBe(2000)
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
