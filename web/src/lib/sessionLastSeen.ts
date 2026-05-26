const STORAGE_KEY = 'hapi.sessionLastSeen.v1'

type LastSeenStore = Record<string, number>

function readStore(): LastSeenStore {
    if (typeof localStorage === 'undefined') {
        return {}
    }

    try {
        const raw = localStorage.getItem(STORAGE_KEY)
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
    if (typeof localStorage === 'undefined') {
        return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

export function getSessionLastSeenAt(sessionId: string): number {
    return readStore()[sessionId] ?? 0
}

export function markSessionSeen(sessionId: string, seenAt: number = Date.now()): void {
    if (!sessionId) {
        return
    }
    const store = readStore()
    store[sessionId] = Math.max(store[sessionId] ?? 0, seenAt)
    writeStore(store)
}
