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
    const [state, setState] = useState(() => readHistory(storageKey) ?? emptyHistory())
    const current = useRef(state)
    const storageFailed = useRef(false)
    const value = useMemo<HistoryContextValue>(() => {
        const update = (change: (previous: SearchHistoryState) => SearchHistoryState) => {
            // Read the latest persisted state so writes in another tab aren't overwritten.
            const previous = storageFailed.current ? current.current : readHistory(storageKey) ?? current.current
            const next = change(previous)
            if (next === previous) return
            current.current = next
            setState(next)
            try {
                window.localStorage.setItem(storageKey, JSON.stringify(next))
                storageFailed.current = false
            } catch {
                // Keep the setting and history usable in memory when storage is blocked/full.
                storageFailed.current = true
            }
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
    }, [state, storageKey])

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key !== storageKey && event.key !== null) return
            const next = parseSearchHistory(event.key === null ? null : event.newValue)
            current.current = next
            storageFailed.current = false
            setState(next)
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [storageKey])

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
