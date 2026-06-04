import { useCallback, useEffect, useState } from 'react'
import {
    addScratchlistEntry,
    deleteScratchlistEntry,
    moveScratchlistEntry,
    persistScratchlist,
    readScratchlist,
    type ScratchlistEntry,
} from '@/lib/scratchlist'

/**
 * useScratchlist - per-session scratchlist state hook.
 *
 * Originally the entries lived inside ScratchlistPanel's useState. The
 * composer-controlled drawer (v1.1) needs the same data exposed in two
 * places (the drawer + the composer-toolbar counter), so the state is
 * lifted here. localStorage stays the source of truth; this hook is the
 * React mirror.
 *
 * Cross-session race protection
 * -----------------------------
 * The naive shape (entries: useState, sessionId: prop, two useEffects)
 * leaks across session navigation:
 *
 *   1. Mount with sessionId=A → entries = readScratchlist(A) = [a1, a2]
 *   2. Parent rerenders with sessionId=B (same component instance — the
 *      v1 panel sidestepped this with key={props.session.id}; the v1.1
 *      lifted hook can't, because its parent SessionChat *isn't*
 *      remounted on session switch).
 *   3. React commits with sessionId=B but `entries` is still A's data.
 *   4. Persist effect fires: persistScratchlist(B, [a1, a2]) —
 *      OVERWRITES B's storage with A's entries before the rehydrate
 *      effect has a chance to run.
 *
 * Fix (per upstream review on PR #798): keep the loaded sessionId in
 * state alongside the entries so they can swap atomically, and persist
 * against the LOADED sessionId, not the current prop. After step 2 the
 * loaded sessionId is still A (until the rehydrate effect runs), so a
 * spurious persist re-writes A's storage with A's entries — a no-op
 * instead of a corruption.
 */
export function useScratchlist(sessionId: string) {
    const [{ sessionId: loadedSessionId, entries }, setScratchlist] = useState<{
        sessionId: string
        entries: ScratchlistEntry[]
    }>(() => ({ sessionId, entries: readScratchlist(sessionId) }))

    // Rehydrate when the parent navigates to a different session. This
    // atomically swaps both the loaded sessionId and the entries, so the
    // persist effect below sees a consistent (sessionId, entries) pair.
    useEffect(() => {
        setScratchlist({ sessionId, entries: readScratchlist(sessionId) })
    }, [sessionId])

    // Persist using the LOADED sessionId, not the prop. If the prop has
    // moved ahead of the rehydrate effect, this still writes back to the
    // session whose entries we currently hold — no cross-session leak.
    useEffect(() => {
        persistScratchlist(loadedSessionId, entries)
    }, [loadedSessionId, entries])

    const add = useCallback((rawText: string): boolean => {
        const result = addScratchlistEntry(entries, rawText)
        if (result.entries === entries) return false
        setScratchlist({ sessionId: loadedSessionId, entries: result.entries })
        return true
    }, [entries, loadedSessionId])

    const remove = useCallback((id: string) => {
        setScratchlist((prev) => ({
            sessionId: prev.sessionId,
            entries: deleteScratchlistEntry(prev.entries, id),
        }))
    }, [])

    const move = useCallback((id: string, direction: 'up' | 'down') => {
        setScratchlist((prev) => ({
            sessionId: prev.sessionId,
            entries: moveScratchlistEntry(prev.entries, id, direction),
        }))
    }, [])

    return { entries, add, remove, move }
}
