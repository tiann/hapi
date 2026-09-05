import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'hapi.sessionLastSeen.v1'
const MANUAL_UNREAD_KEY = 'hapi.sessionManualUnread.v1'
const BASELINE_KEY = 'hapi.sessionLastSeenBaseline.v1'
const CHANGE_EVENT = 'hapi.sessionLastSeen.changed'

let changeVersion = 0

type LastSeenStore = Record<string, number>
type ManualUnreadStore = Record<string, number>

function getLocalStorage(): Storage | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function readStore(): LastSeenStore {
    const storage = getLocalStorage()
    if (!storage) {
        return {}
    }

    try {
        const raw = storage.getItem(STORAGE_KEY)
        if (!raw) {
            return {}
        }
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') {
            return {}
        }
        return parsed as LastSeenStore
    } catch {
        return {}
    }
}

function readManualUnreadStore(): ManualUnreadStore {
    const storage = getLocalStorage()
    if (!storage) {
        return {}
    }

    try {
        const raw = storage.getItem(MANUAL_UNREAD_KEY)
        if (!raw) {
            return {}
        }
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') {
            return {}
        }
        return parsed as ManualUnreadStore
    } catch {
        return {}
    }
}

function writeStore(store: LastSeenStore): boolean {
    const storage = getLocalStorage()
    if (!storage) {
        return false
    }
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(store))
        return true
    } catch {
        // Ignore storage errors
        return false
    }
}

function writeManualUnreadStore(store: ManualUnreadStore): boolean {
    const storage = getLocalStorage()
    if (!storage) {
        return false
    }
    try {
        storage.setItem(MANUAL_UNREAD_KEY, JSON.stringify(store))
        return true
    } catch {
        // Ignore storage errors
        return false
    }
}

function notifyStoreChanged(): void {
    changeVersion += 1
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(CHANGE_EVENT))
    }
}

function subscribeToStoreChanges(listener: () => void): () => void {
    if (typeof window === 'undefined') {
        return () => {}
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key !== STORAGE_KEY && event.key !== MANUAL_UNREAD_KEY) {
            return
        }
        changeVersion += 1
        listener()
    }

    window.addEventListener(CHANGE_EVENT, listener)
    window.addEventListener('storage', handleStorage)
    return () => {
        window.removeEventListener(CHANGE_EVENT, listener)
        window.removeEventListener('storage', handleStorage)
    }
}

function getStoreChangeVersion(): number {
    return changeVersion
}

/** Re-render consumers when same-tab read-state changes. */
export function useSessionLastSeenVersion(): number {
    return useSyncExternalStore(
        subscribeToStoreChanges,
        getStoreChangeVersion,
        () => 0
    )
}

export function getSessionLastSeenAt(sessionId: string): number {
    return readStore()[sessionId] ?? 0
}

/** Timestamp of the activity the operator explicitly marked unread, if any. */
export function getSessionManualUnreadAt(sessionId: string): number | null {
    const value = readManualUnreadStore()[sessionId]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** One localStorage read/parse for bulk filters (e.g. unread-only lens). */
export function getSessionLastSeenSnapshot(): Readonly<Record<string, number>> {
    return readStore()
}

type SessionReadStateInput = {
    id: string
    updatedAt: number
}

function latestSessionUpdates(sessions: Iterable<SessionReadStateInput>): Map<string, number> {
    const latest = new Map<string, number>()
    for (const session of sessions) {
        if (!session.id || !Number.isFinite(session.updatedAt)) {
            continue
        }
        const current = latest.get(session.id)
        if (current === undefined || session.updatedAt > current) {
            latest.set(session.id, session.updatedAt)
        }
    }
    return latest
}

function hasUnreadActivity(
    sessionId: string,
    updatedAt: number,
    store: LastSeenStore,
    manualUnreadStore: ManualUnreadStore
): boolean {
    const lastSeenAt = store[sessionId]
    const manualUnreadAt = manualUnreadStore[sessionId]
    return updatedAt > (typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) ? lastSeenAt : 0)
        || manualUnreadAt === updatedAt
}

/** Count unread sessions in the supplied list using one localStorage snapshot. */
export function getUnreadSessionCount(sessions: Iterable<SessionReadStateInput>): number {
    const latest = latestSessionUpdates(sessions)
    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    let count = 0
    for (const [sessionId, updatedAt] of latest) {
        if (hasUnreadActivity(sessionId, updatedAt, store, manualUnreadStore)) {
            count += 1
        }
    }
    return count
}

/** Mark all supplied unread sessions as seen on this device. Returns changed count. */
export function markAllSessionsSeen(sessions: Iterable<SessionReadStateInput>): number {
    const latest = latestSessionUpdates(sessions)
    if (latest.size === 0) {
        return 0
    }

    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    let count = 0
    let seenChanged = false
    let manualUnreadChanged = false

    for (const [sessionId, updatedAt] of latest) {
        if (!hasUnreadActivity(sessionId, updatedAt, store, manualUnreadStore)) {
            continue
        }

        count += 1
        const currentSeenAt = store[sessionId]
        const nextSeenAt = Math.max(
            typeof currentSeenAt === 'number' && Number.isFinite(currentSeenAt) ? currentSeenAt : 0,
            updatedAt
        )
        if (store[sessionId] !== nextSeenAt) {
            store[sessionId] = nextSeenAt
            seenChanged = true
        }
        if (Object.prototype.hasOwnProperty.call(manualUnreadStore, sessionId)) {
            delete manualUnreadStore[sessionId]
            manualUnreadChanged = true
        }
    }

    if (count === 0) {
        return 0
    }

    const seenWritten = !seenChanged || writeStore(store)
    const manualUnreadWritten = !manualUnreadChanged || writeManualUnreadStore(manualUnreadStore)
    if (seenWritten || manualUnreadWritten) {
        notifyStoreChanged()
    }
    return count
}

export function initializeSessionLastSeen(scope: string, sessions: Iterable<{ id: string; updatedAt: number }>): void {
    const storage = getLocalStorage()
    if (!storage) {
        return
    }

    try {
        const baselineKey = `${BASELINE_KEY}:${scope}`
        if (storage.getItem(baselineKey) === '1') {
            return
        }
        const store = readStore()
        for (const session of sessions) {
            store[session.id] ??= session.updatedAt
        }
        storage.setItem(STORAGE_KEY, JSON.stringify(store))
        storage.setItem(baselineKey, '1')
    } catch {
        // Ignore storage errors
    }
}

export function markSessionSeen(sessionId: string, seenAt: number): void {
    if (!sessionId) {
        return
    }
    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    const nextSeenAt = Math.max(store[sessionId] ?? 0, seenAt)
    const seenChanged = store[sessionId] !== nextSeenAt
    const manualUnreadAt = manualUnreadStore[sessionId]
    const manualUnreadChanged = typeof manualUnreadAt === 'number'
        && Number.isFinite(manualUnreadAt)
        && nextSeenAt >= manualUnreadAt
    if (!seenChanged && !manualUnreadChanged) {
        return
    }

    if (seenChanged) {
        store[sessionId] = nextSeenAt
    }
    if (manualUnreadChanged) {
        delete manualUnreadStore[sessionId]
    }

    const seenWritten = !seenChanged || writeStore(store)
    const manualUnreadWritten = !manualUnreadChanged || writeManualUnreadStore(manualUnreadStore)
    if (seenWritten || manualUnreadWritten) {
        notifyStoreChanged()
    }
}

/** Move the local watermark just behind the current activity and remember the explicit action. */
export function markSessionUnread(sessionId: string, updatedAt: number): void {
    if (!sessionId || !Number.isFinite(updatedAt)) {
        return
    }

    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    const unreadBefore = updatedAt - 1
    const currentSeenAt = store[sessionId]
    const seenChanged = !(typeof currentSeenAt === 'number' && currentSeenAt <= unreadBefore)
    const manualUnreadChanged = manualUnreadStore[sessionId] !== updatedAt
    if (!seenChanged && !manualUnreadChanged) {
        return
    }

    if (seenChanged) {
        store[sessionId] = unreadBefore
    }
    if (manualUnreadChanged) {
        manualUnreadStore[sessionId] = updatedAt
    }

    const seenWritten = !seenChanged || writeStore(store)
    const manualUnreadWritten = !manualUnreadChanged || writeManualUnreadStore(manualUnreadStore)
    if (seenWritten || manualUnreadWritten) {
        notifyStoreChanged()
    }
}
