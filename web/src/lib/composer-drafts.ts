/**
 * Per-session composer draft persistence.
 * Saves unsent input text so it survives session switching.
 */

const STORAGE_KEY = 'hapi:composer-drafts'

const drafts = new Map<string, string>()

// Hydrate from sessionStorage on module init
try {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (stored) {
        const parsed = JSON.parse(stored) as Record<string, string>
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string' && v.length > 0) {
                drafts.set(k, v)
            }
        }
    }
} catch { /* ignore */ }

function persist() {
    try {
        const obj: Record<string, string> = {}
        for (const [k, v] of drafts) {
            obj[k] = v
        }
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch { /* ignore */ }
}

export function getDraft(sessionId: string): string {
    return drafts.get(sessionId) ?? ''
}

export function saveDraft(sessionId: string, text: string) {
    if (text.trim().length === 0) {
        drafts.delete(sessionId)
    } else {
        drafts.set(sessionId, text)
    }
    persist()
}

export function clearDraft(sessionId: string) {
    drafts.delete(sessionId)
    persist()
}
