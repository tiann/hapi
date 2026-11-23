import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type SearchHistoryType = 'sessions' | 'files' | 'outlines'
export type SearchHistoryState = Record<SearchHistoryType, string[]> & { enabled: boolean }
export const SEARCH_HISTORY_LIMIT = 20
const PREFIX = 'hapi.searchHistory.v1.'

function emptyHistory(): SearchHistoryState {
    return { enabled: false, sessions: [], files: [], outlines: [] }
}

export function parseSearchHistory(raw: string | null): SearchHistoryState {
    try {
        const parsed: unknown = JSON.parse(raw ?? 'null')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyHistory()
        const data = parsed as Record<string, unknown>
        const entries = (type: SearchHistoryType): string[] => {
            const values = data[type]
            if (!Array.isArray(values)) return []
            return [...new Set(values.filter((value: unknown): value is string =>
                typeof value === 'string' && value.trim().length > 0).map(value => value.trim()))].slice(0, SEARCH_HISTORY_LIMIT)
        }
        return { enabled: data.enabled === true, sessions: entries('sessions'), files: entries('files'), outlines: entries('outlines') }
    } catch {
        return emptyHistory()
    }
}

// The JWT is read only to partition local preferences, never to authorize access.
// Do not use the token itself: it is secret and changes on refresh.
export function getSearchHistoryKey(baseUrl: string, token: string): string | null {
    try {
        const payload = token.split('.')[1]
        if (!payload) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
        const decoded: unknown = JSON.parse(atob(base64))
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null
        const { uid, ns } = decoded as Record<string, unknown>
        if (typeof uid !== 'number' || !Number.isFinite(uid) || typeof ns !== 'string' || !ns) return null
        const hub = new URL(baseUrl || window.location.origin, window.location.origin).href.replace(/\/$/, '')
        return PREFIX + encodeURIComponent(JSON.stringify([hub, uid, ns]))
    } catch {
        return null
    }
}

type HistoryContextValue = {
    state: SearchHistoryState
    record: (type: SearchHistoryType, query: string) => void
    remove: (type: SearchHistoryType, query: string) => void
    clear: (type?: SearchHistoryType) => void
    setEnabled: (enabled: boolean) => void
}
const HistoryContext = createContext<HistoryContextValue>({
    state: { ...emptyHistory(), enabled: false },
    record: () => {}, remove: () => {}, clear: () => {}, setEnabled: () => {},
})

function readHistory(key: string): SearchHistoryState | null {
    try {
        return parseSearchHistory(window.localStorage.getItem(key))
    } catch {
        return null
    }
}

function ScopedSearchHistoryProvider({ storageKey, children }: { storageKey: string; children: ReactNode }) {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    const [state, setState] = useState(() => (locks ? readHistory(storageKey) : null) ?? emptyHistory())
    const memoryFallback = useRef<SearchHistoryState | null>(null)
    const value = useMemo<HistoryContextValue>(() => {
        const show = (next: SearchHistoryState) => {
            setState(next)
        }
        const updateInMemory = (change: (previous: SearchHistoryState) => SearchHistoryState) => {
            // No cross-tab lock means no access to the persisted history. A
            // stale tab must never write it back after an opt-out or clear.
            const next = change(memoryFallback.current ?? emptyHistory())
            memoryFallback.current = next
            show(next)
        }
        const update = (change: (previous: SearchHistoryState) => SearchHistoryState) => {
            if (!locks) {
                updateInMemory(change)
                return
            }
            void locks.request(storageKey, () => {
                // Read and write under the same exclusive origin/scope lock.
                const previous = readHistory(storageKey)
                if (!previous) {
                    updateInMemory(change)
                    return
                }
                const next = change(previous)
                try {
                    if (next !== previous) window.localStorage.setItem(storageKey, JSON.stringify(next))
                    memoryFallback.current = null
                    show(next)
                } catch {
                    // Storage is full/blocked. Never make this unsaved state an
                    // authoritative input to a future persisted mutation.
                    updateInMemory(change)
                }
            }).catch(() => updateInMemory(change))
        }
        return {
            state,
            record: (type, query) => update(previous => {
                const trimmed = query.trim()
                if (!previous.enabled || !trimmed) return previous
                return { ...previous, [type]: [trimmed, ...previous[type].filter(entry => entry !== trimmed)].slice(0, SEARCH_HISTORY_LIMIT) }
            }),
            remove: (type, query) => update(previous => ({ ...previous, [type]: previous[type].filter(entry => entry !== query) })),
            clear: type => update(previous => type
                ? { ...previous, [type]: [] }
                : { ...emptyHistory(), enabled: previous.enabled }),
            setEnabled: enabled => update(previous => ({ ...previous, enabled })),
        }
    }, [locks, state, storageKey])

    useEffect(() => {
        if (!locks) return
        const onStorage = (event: StorageEvent) => {
            if (event.key !== storageKey && event.key !== null) return
            // A storage event describes the write that queued it, not necessarily
            // the value still on disk after a more recent write in this tab.
            const next = readHistory(storageKey)
            if (!next) return
            memoryFallback.current = null
            setState(next)
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [locks, storageKey])

    return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}

export function SearchHistoryProvider({ storageKey, children }: { storageKey: string | null; children: ReactNode }) {
    // Remount when identity changes so a previous Hub/account never flashes in the new view.
    return storageKey
        ? <ScopedSearchHistoryProvider key={storageKey} storageKey={storageKey}>{children}</ScopedSearchHistoryProvider>
        : <HistoryContext.Provider value={{ state: { ...emptyHistory(), enabled: false }, record: () => {}, remove: () => {}, clear: () => {}, setEnabled: () => {} }}>{children}</HistoryContext.Provider>
}

export function useSearchHistory() {
    return useContext(HistoryContext)
}
