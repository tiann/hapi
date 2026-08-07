const STORAGE_KEY = 'hapi.sessionLastSeen.v1'
const BASELINE_KEY = 'hapi.sessionLastSeenBaseline.v1'

type LastSeenStore = Record<string, number>

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

function writeStore(store: LastSeenStore): void {
    const storage = getLocalStorage()
    if (!storage) {
        return
    }
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(store))
    } catch {
        // Ignore storage errors
    }
}

export function getSessionLastSeenAt(sessionId: string): number {
    return readStore()[sessionId] ?? 0
}

/** One localStorage read/parse for bulk filters (e.g. unread-only lens). */
export function getSessionLastSeenSnapshot(): Readonly<Record<string, number>> {
    return readStore()
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
    store[sessionId] = Math.max(store[sessionId] ?? 0, seenAt)
    writeStore(store)
}
