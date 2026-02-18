const TERMINAL_INSTANCE_ID_STORAGE_PREFIX = 'hapi:terminal:instance:'

function generateTerminalInstanceId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getStorageKey(sessionId: string): string {
    return `${TERMINAL_INSTANCE_ID_STORAGE_PREFIX}${sessionId}`
}

export function getSessionTerminalInstanceId(sessionId: string): string {
    const fallback = generateTerminalInstanceId()

    if (typeof window === 'undefined' || !sessionId) {
        return fallback
    }

    const key = getStorageKey(sessionId)

    try {
        const existing = window.localStorage.getItem(key)
        if (existing && existing.length > 0) {
            return existing
        }

        window.localStorage.setItem(key, fallback)
    } catch {
        // Ignore storage errors (private mode / disabled storage)
    }

    return fallback
}
