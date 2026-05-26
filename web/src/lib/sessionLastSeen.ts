const STORAGE_KEY = 'hapi.sessionLastSeen.v1'

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

export function markSessionSeen(sessionId: string, seenAt: number): void {
    if (!sessionId) {
        return
    }
    const store = readStore()
    store[sessionId] = Math.max(store[sessionId] ?? 0, seenAt)
    writeStore(store)
}
