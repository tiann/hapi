import { useSyncExternalStore } from 'react'
import { getSessionActivityTimestamp } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'

// v2 changes the stored clock from raw `updatedAt` to the same
// `lastAssistantMessageAt ?? updatedAt` activity clock used by the list.
// Keeping the old values would make already-read sessions look unread after
// the reply-clock feature is enabled.
const STORAGE_KEY = 'hapi.sessionLastSeen.v2'
const MANUAL_UNREAD_KEY = 'hapi.sessionManualUnread.v2'
const BASELINE_KEY = 'hapi.sessionLastSeenBaseline.v2'
const PENDING_BASELINE_KEY = 'hapi.sessionLastSeenPendingBaseline.v2'
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

function readPendingBaseline(scope: string): Set<string> {
    const storage = getLocalStorage()
    if (!storage) {
        return new Set()
    }

    try {
        const raw = storage.getItem(`${PENDING_BASELINE_KEY}:${scope}`)
        if (!raw) {
            return new Set()
        }
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) {
            return new Set()
        }
        return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0))
    } catch {
        return new Set()
    }
}

function writePendingBaseline(scope: string, sessionIds: Set<string>): boolean {
    const storage = getLocalStorage()
    if (!storage) {
        return false
    }
    try {
        const key = `${PENDING_BASELINE_KEY}:${scope}`
        if (sessionIds.size === 0) {
            storage.removeItem(key)
        } else {
            storage.setItem(key, JSON.stringify(Array.from(sessionIds)))
        }
        return true
    } catch {
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

export function initializeSessionLastSeen(
    scope: string,
    sessions: Iterable<Pick<SessionSummary, 'id' | 'updatedAt' | 'lastAssistantMessageAt' | 'assistantReplyClockBackfilled'>>
): void {
    const storage = getLocalStorage()
    if (!storage) {
        return
    }

    try {
        const baselineKey = `${BASELINE_KEY}:${scope}`
        const store = readStore()
        const pendingBaseline = readPendingBaseline(scope)
        const baselineInitialized = storage.getItem(baselineKey) === '1'
        let storeChanged = false
        let pendingChanged = false

        for (const session of sessions) {
            const replyClockReady = session.assistantReplyClockBackfilled !== false
            if (!baselineInitialized) {
                if (!replyClockReady) {
                    if (!pendingBaseline.has(session.id)) {
                        pendingBaseline.add(session.id)
                        pendingChanged = true
                    }
                    continue
                }
                if (store[session.id] === undefined) {
                    store[session.id] = getSessionActivityTimestamp(session)
                    storeChanged = true
                }
                continue
            }

            // A legacy row may have been skipped on the first list because its
            // asynchronous reply-clock backfill was not complete yet. Seed it
            // once the full reply clock becomes authoritative, but do not seed
            // sessions that first appeared after the original baseline.
            if (!replyClockReady || !pendingBaseline.has(session.id)) {
                continue
            }
            pendingBaseline.delete(session.id)
            pendingChanged = true
            if (store[session.id] === undefined) {
                store[session.id] = getSessionActivityTimestamp(session)
                storeChanged = true
            }
        }

        const storeWritten = !storeChanged || writeStore(store)
        if (!storeWritten) {
            return
        }
        const pendingWritten = !pendingChanged || writePendingBaseline(scope, pendingBaseline)
        if (!pendingWritten) {
            return
        }
        if (!baselineInitialized) {
            storage.setItem(baselineKey, '1')
        }
        if (storeChanged) {
            notifyStoreChanged()
        }
    } catch {
        // Ignore storage errors
    }
}

/** Advance the local watermark for the shared reply/activity clock. */
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
export function markSessionUnread(sessionId: string, activityAt: number): void {
    if (!sessionId || !Number.isFinite(activityAt)) {
        return
    }

    const store = readStore()
    const manualUnreadStore = readManualUnreadStore()
    const unreadBefore = activityAt - 1
    const currentSeenAt = store[sessionId]
    const seenChanged = !(typeof currentSeenAt === 'number' && currentSeenAt <= unreadBefore)
    const manualUnreadChanged = manualUnreadStore[sessionId] !== activityAt
    if (!seenChanged && !manualUnreadChanged) {
        return
    }

    if (seenChanged) {
        store[sessionId] = unreadBefore
    }
    if (manualUnreadChanged) {
        manualUnreadStore[sessionId] = activityAt
    }

    const seenWritten = !seenChanged || writeStore(store)
    const manualUnreadWritten = !manualUnreadChanged || writeManualUnreadStore(manualUnreadStore)
    if (seenWritten || manualUnreadWritten) {
        notifyStoreChanged()
    }
}
