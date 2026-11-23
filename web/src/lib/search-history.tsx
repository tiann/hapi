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

const historyTypes = ['sessions', 'files', 'outlines'] as const

type FailedWrite = { action: 'enable' } | {
    action: 'delete'
    affected: Array<{ type: SearchHistoryType; queries: string[] }>
}

function reconcileFailedWrite(failed: FailedWrite | null, saved: SearchHistoryState): FailedWrite | null {
    if (!failed) return null
    if (failed.action === 'enable') return saved.enabled ? null : failed
    const affected = failed.affected.flatMap(({ type, queries }) => {
        const unresolved = queries.filter(query => saved[type].includes(query))
        return unresolved.length ? [{ type, queries: unresolved }] : []
    })
    return affected.length > 0 ? { action: 'delete', affected } : null
}

type HistoryContextValue = {
    state: SearchHistoryState
    optOutNotSaved: boolean
    failedWrite: 'enable' | 'delete' | null
    failedDeletionTypes: readonly SearchHistoryType[]
    record: (type: SearchHistoryType, query: string) => void
    remove: (type: SearchHistoryType, query: string) => void
    clear: (type?: SearchHistoryType) => void
    setEnabled: (enabled: boolean) => void
}
const HistoryContext = createContext<HistoryContextValue>({
    state: emptyHistory(), optOutNotSaved: false, failedWrite: null, failedDeletionTypes: [],
    record: () => {}, remove: () => {}, clear: () => {}, setEnabled: () => {},
})

function readHistory(key: string): SearchHistoryState | null {
    try {
        return parseSearchHistory(window.localStorage.getItem(key))
    } catch {
        return null
    }
}

let coordinationDb: Promise<IDBDatabase> | undefined

function withIndexedDbLock(storageKey: string, run: () => void): Promise<void> {
    // Plain HTTP LAN clients have IndexedDB but not Web Locks. A read-write
    // transaction on a single store serializes these synchronous localStorage
    // updates across tabs without moving or copying any search queries.
    coordinationDb ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('hapi-search-history-coordination', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('lock')
        request.onsuccess = () => {
            const db = request.result
            db.onversionchange = () => { db.close(); coordinationDb = undefined }
            resolve(db)
        }
        request.onerror = () => reject(request.error)
    }).catch(error => { coordinationDb = undefined; throw error })
    return coordinationDb.then(db => new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('lock', 'readwrite')
        const request = transaction.objectStore('lock').get(storageKey)
        request.onsuccess = run
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
    }))
}

function ScopedSearchHistoryProvider({ storageKey, children }: { storageKey: string; children: ReactNode }) {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    const hasIndexedDb = typeof indexedDB !== 'undefined'
    const canCoordinate = Boolean(locks || hasIndexedDb)
    const [initialHistory] = useState(() => canCoordinate ? readHistory(storageKey) : null)
    const [state, setState] = useState(() => initialHistory ?? emptyHistory())
    const lastKnownPersisted = useRef(initialHistory)
    const [optOutNotSaved, setOptOutNotSaved] = useState(false)
    const [failedWrite, setFailedWrite] = useState<FailedWrite | null>(null)
    const suspendedRecording = useRef(false)
    const memoryFallback = useRef<SearchHistoryState | null>(null)
    const value = useMemo<HistoryContextValue>(() => {
        type Change = (previous: SearchHistoryState) => SearchHistoryState
        type Action = 'record' | 'disable' | 'enable' | 'delete'
        const updateInMemory = (change: Change) => {
            // No cross-tab lock means no write to persisted history. A stale
            // tab must never write it back after an opt-out or clear.
            const next = change(memoryFallback.current ?? emptyHistory())
            memoryFallback.current = next
            setState(next)
        }
        const handleUnsavedOptOut = (previous: SearchHistoryState) => {
            suspendedRecording.current = true
            setOptOutNotSaved(true)
            setFailedWrite(null)
            setState({ ...previous, enabled: false })
        }
        const onUnavailable = (change: Change, action: Action) => {
            const saved = lastKnownPersisted.current
            if (!saved) {
                updateInMemory(change)
                return
            }
            if (action === 'disable' && saved.enabled) {
                handleUnsavedOptOut(saved)
                return
            }
            // Don't replace saved entries with a memory-only result when the
            // coordinator, a read, or a write stops working mid-session.
            if (action === 'enable' && !saved.enabled) setFailedWrite({ action })
            if (action === 'delete') {
                const next = change(saved)
                const affected = historyTypes.map(type => ({
                    type, queries: saved[type].filter(query => !next[type].includes(query)),
                })).filter(entry => entry.queries.length > 0)
                if (affected.length) setFailedWrite(failed => {
                    const prior = failed?.action === 'delete' ? failed.affected : []
                    const unresolved = historyTypes.flatMap(type => {
                        const queries = [...new Set([...prior, ...affected].filter(entry => entry.type === type)
                            .flatMap(entry => entry.queries))].filter(query => saved[type].includes(query))
                        return queries.length ? [{ type, queries }] : []
                    })
                    return { action, affected: unresolved }
                })
            }
            setState(suspendedRecording.current ? { ...saved, enabled: false } : saved)
        }
        const update = (change: Change, action: Action) => {
            if (action === 'record' && suspendedRecording.current) return
            if (!canCoordinate) {
                updateInMemory(change)
                return
            }
            const mutate = () => {
                if (action === 'record' && suspendedRecording.current) return
                const previous = readHistory(storageKey)
                if (!previous) {
                    onUnavailable(change, action)
                    return
                }
                lastKnownPersisted.current = previous
                const next = change(previous)
                try {
                    if (next !== previous) {
                        // Disabled is already the parser's default. Omitting
                        // the flag makes opting out a smaller write at quota.
                        const { enabled, ...lists } = next
                        window.localStorage.setItem(storageKey, JSON.stringify(enabled ? next : lists))
                    }
                    lastKnownPersisted.current = next
                    setFailedWrite(failed => reconcileFailedWrite(failed, next))
                    memoryFallback.current = null
                    if (action === 'enable' || !next.enabled) {
                        suspendedRecording.current = false
                        setOptOutNotSaved(false)
                    }
                    setState(suspendedRecording.current ? { ...next, enabled: false } : next)
                } catch {
                    onUnavailable(change, action)
                }
            }
            const coordination = locks ? locks.request(storageKey, mutate) : withIndexedDbLock(storageKey, mutate)
            void coordination.catch(() => onUnavailable(change, action))
        }
        return {
            state, optOutNotSaved, failedWrite: failedWrite?.action ?? null,
            failedDeletionTypes: failedWrite?.action === 'delete' ? failedWrite.affected.filter(entry => entry.queries.some(query => state[entry.type].includes(query))).map(entry => entry.type) : [],
            record: (type, query) => update(previous => {
                const trimmed = query.trim()
                if (!previous.enabled || !trimmed) return previous
                return { ...previous, [type]: [trimmed, ...previous[type].filter(entry => entry !== trimmed)].slice(0, SEARCH_HISTORY_LIMIT) }
            }, 'record'),
            remove: (type, query) => update(previous => ({ ...previous, [type]: previous[type].filter(entry => entry !== query) }), 'delete'),
            clear: type => update(previous => type
                ? { ...previous, [type]: [] }
                : { ...emptyHistory(), enabled: previous.enabled }, 'delete'),
            setEnabled: enabled => update(previous => ({ ...previous, enabled }), enabled ? 'enable' : 'disable'),
        }
    }, [canCoordinate, failedWrite, locks, optOutNotSaved, state, storageKey])

    useEffect(() => {
        if (!canCoordinate) return
        const onStorage = (event: StorageEvent) => {
            if (event.key !== storageKey && event.key !== null) return
            // A storage event describes the write that queued it, not necessarily
            // the value still on disk after a more recent write in this tab.
            const next = readHistory(storageKey)
            if (!next) return
            lastKnownPersisted.current = next
            setFailedWrite(failed => reconcileFailedWrite(failed, next))
            memoryFallback.current = null
            if (!next.enabled) {
                suspendedRecording.current = false
                setOptOutNotSaved(false)
            }
            setState(suspendedRecording.current ? { ...next, enabled: false } : next)
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [canCoordinate, storageKey])

    return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
}

export function SearchHistoryProvider({ storageKey, children }: { storageKey: string | null; children: ReactNode }) {
    // Remount when identity changes so a previous Hub/account never flashes in the new view.
    return storageKey
        ? <ScopedSearchHistoryProvider key={storageKey} storageKey={storageKey}>{children}</ScopedSearchHistoryProvider>
        : <HistoryContext.Provider value={{ state: emptyHistory(), optOutNotSaved: false, failedWrite: null, failedDeletionTypes: [], record: () => {}, remove: () => {}, clear: () => {}, setEnabled: () => {} }}>{children}</HistoryContext.Provider>
}

export function useSearchHistory() {
    return useContext(HistoryContext)
}
