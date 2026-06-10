import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addScratchlistEntry, persistScratchlist, readScratchlist } from './scratchlist'
import { useScratchlist } from './use-scratchlist'

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

describe('useScratchlist', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        localStorage.clear()
    })

    it('hydrates from localStorage on mount', () => {
        const { entries: seeded } = addScratchlistEntry([], 'a-only', 1000)
        persistScratchlist(SESSION_A, seeded)
        const { result } = renderHook(({ id }: { id: string }) => useScratchlist(id), {
            initialProps: { id: SESSION_A },
        })
        expect(result.current.entries.map((e) => e.text)).toEqual(['a-only'])
    })

    it('add() persists to the current sessions storage', () => {
        const { result } = renderHook(({ id }: { id: string }) => useScratchlist(id), {
            initialProps: { id: SESSION_A },
        })
        act(() => {
            result.current.add('first')
        })
        expect(readScratchlist(SESSION_A).map((e) => e.text)).toEqual(['first'])
        expect(readScratchlist(SESSION_B)).toEqual([])
    })

    it('switching sessions does NOT overwrite the new sessions storage with stale entries', () => {
        // Regression test for the cross-session leak found by upstream review on PR #798.
        // Seed both sessions distinctly; mount with A; rerender with B.
        // The persist effect must not write A's entries into B's localStorage
        // key during the brief render where the prop has changed but the
        // rehydrate effect hasn't run yet.
        const { entries: aEntries } = addScratchlistEntry([], 'a-original', 1000)
        const { entries: bEntries } = addScratchlistEntry([], 'b-original', 2000)
        persistScratchlist(SESSION_A, aEntries)
        persistScratchlist(SESSION_B, bEntries)

        const { rerender } = renderHook(({ id }: { id: string }) => useScratchlist(id), {
            initialProps: { id: SESSION_A },
        })

        rerender({ id: SESSION_B })

        // After the session switch, B's storage must still contain B's
        // entry (not A's). Reading from disk because that's what the next
        // mount of any other component would see.
        expect(readScratchlist(SESSION_B).map((e) => e.text)).toEqual(['b-original'])
        // A's storage stays intact too.
        expect(readScratchlist(SESSION_A).map((e) => e.text)).toEqual(['a-original'])
    })

    it('after switching sessions, add() targets the new session', () => {
        const { entries: aEntries } = addScratchlistEntry([], 'a-original', 1000)
        persistScratchlist(SESSION_A, aEntries)

        const { result, rerender } = renderHook(
            ({ id }: { id: string }) => useScratchlist(id),
            { initialProps: { id: SESSION_A } }
        )
        rerender({ id: SESSION_B })
        act(() => {
            result.current.add('b-only')
        })
        expect(readScratchlist(SESSION_B).map((e) => e.text)).toEqual(['b-only'])
        expect(readScratchlist(SESSION_A).map((e) => e.text)).toEqual(['a-original'])
    })

    it('switching sessions never writes the previous sessions entries to the new sessions storage key', () => {
        // The bot's review on PR #798 specifically called out the write
        // window: between commit-with-new-id and the rehydrate effect
        // running, the persist effect can fire one corrupting write
        // (sessionId=B, entries=A's). That write self-heals on the next
        // render once the rehydrate completes, so a "read after rerender"
        // assertion would falsely pass. This test inspects every setItem
        // call that happens during the rerender lifecycle and asserts no
        // call wrote A's entries to B's storage key.
        const { entries: aEntries } = addScratchlistEntry([], 'a-original', 1000)
        const { entries: bEntries } = addScratchlistEntry([], 'b-original', 2000)
        persistScratchlist(SESSION_A, aEntries)
        persistScratchlist(SESSION_B, bEntries)

        const { rerender } = renderHook(({ id }: { id: string }) => useScratchlist(id), {
            initialProps: { id: SESSION_A },
        })

        const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
        rerender({ id: SESSION_B })

        // Storage format is a top-level array of entries (see writeScratchlist
        // in scratchlist.ts), so unpack and inspect each entry directly.
        const corruptingWrites = setItemSpy.mock.calls.filter(([key, value]) => {
            if (typeof key !== 'string' || typeof value !== 'string') return false
            if (!key.endsWith(SESSION_B)) return false
            try {
                const parsed = JSON.parse(value)
                if (!Array.isArray(parsed)) return false
                return parsed.some(
                    (e: { text?: string }) => e?.text === 'a-original'
                )
            } catch {
                return false
            }
        })
        setItemSpy.mockRestore()

        expect(corruptingWrites).toEqual([])
    })

    it('remove() and move() use the loaded sessionId', () => {
        const { entries: seeded } = addScratchlistEntry([], 'first', 1000)
        const { entries: seeded2 } = addScratchlistEntry(seeded, 'second', 2000)
        persistScratchlist(SESSION_A, seeded2)

        const { result } = renderHook(({ id }: { id: string }) => useScratchlist(id), {
            initialProps: { id: SESSION_A },
        })

        const firstId = result.current.entries[0]!.id
        act(() => {
            result.current.remove(firstId)
        })
        expect(result.current.entries.map((e) => e.text)).toEqual(['first'])
        expect(readScratchlist(SESSION_A).map((e) => e.text)).toEqual(['first'])
    })
})
