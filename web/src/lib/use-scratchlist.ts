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
 * composer-controlled drawer needs the same data exposed in two places
 * (the panel + the composer-toolbar counter), so the state gets lifted
 * here. localStorage stays the source of truth; this hook is the React
 * mirror.
 */
export function useScratchlist(sessionId: string) {
    const [entries, setEntries] = useState<ScratchlistEntry[]>(() => readScratchlist(sessionId))

    useEffect(() => {
        setEntries(readScratchlist(sessionId))
    }, [sessionId])

    useEffect(() => {
        persistScratchlist(sessionId, entries)
    }, [sessionId, entries])

    const add = useCallback((rawText: string): boolean => {
        const result = addScratchlistEntry(entries, rawText)
        if (result.entries === entries) return false
        setEntries(result.entries)
        return true
    }, [entries])

    const remove = useCallback((id: string) => {
        setEntries((prev) => deleteScratchlistEntry(prev, id))
    }, [])

    const move = useCallback((id: string, direction: 'up' | 'down') => {
        setEntries((prev) => moveScratchlistEntry(prev, id, direction))
    }, [])

    return { entries, add, remove, move, setEntries }
}
