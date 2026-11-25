const STORAGE_KEY = 'hapi:composer-drafts'
const MAX_DRAFTS = 50

type DraftsMap = Record<string, string>

let cache: DraftsMap | null = null

let revision = 0
const revisions = new Map<string, number>()

export function getDraftRevision(sessionId: string): number {
    // An evicted revision must never match an older pending send.
    return revisions.get(sessionId) ?? revision
}

export function markDraftEdited(sessionId: string): void {
    revisions.delete(sessionId)
    revisions.set(sessionId, ++revision)
    if (revisions.size > MAX_DRAFTS) {
        const oldest = revisions.keys().next().value
        if (oldest !== undefined) revisions.delete(oldest)
    }
}

function safeParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

function hydrate(): DraftsMap {
    if (cache) return cache
    if (typeof window === 'undefined') {
        cache = {}
        return cache
    }
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        if (!raw) {
            cache = {}
            return cache
        }
        const parsed = safeParseJson(raw)
        if (!parsed || typeof parsed !== 'object') {
            cache = {}
            return cache
        }
        const record = parsed as Record<string, unknown>
        const result: DraftsMap = {}
        for (const [key, value] of Object.entries(record)) {
            if (key.trim().length === 0) continue
            if (typeof value !== 'string') continue
            result[key] = value
            markDraftEdited(key)
        }
        cache = result
        return cache
    } catch {
        cache = {}
        return cache
    }
}

function evict(drafts: DraftsMap): void {
    const keys = Object.keys(drafts)
    if (keys.length <= MAX_DRAFTS) return
    // Remove oldest entries (first inserted) to stay under the cap
    const excess = keys.length - MAX_DRAFTS
    for (let i = 0; i < excess; i++) {
        delete drafts[keys[i]!]
    }
}

function persist(): void {
    if (typeof window === 'undefined') return
    try {
        const drafts = hydrate()
        evict(drafts)
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
    } catch {
        // Ignore storage errors
    }
}

export function getDraft(sessionId: string): string {
    const drafts = hydrate()
    return drafts[sessionId] ?? ''
}

export function saveDraft(sessionId: string, text: string): void {
    markDraftEdited(sessionId)
    const trimmed = text.trim()
    const drafts = hydrate()
    if (!trimmed) {
        delete drafts[sessionId]
    } else {
        // Delete before re-inserting to refresh Object.keys() order for eviction
        delete drafts[sessionId]
        drafts[sessionId] = text
    }
    persist()
}

export function clearDraft(sessionId: string): void {
    markDraftEdited(sessionId)
    const drafts = hydrate()
    delete drafts[sessionId]
    persist()
}
