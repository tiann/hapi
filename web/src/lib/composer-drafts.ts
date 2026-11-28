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

function readStored(): DraftsMap {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = safeParseJson(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const result: DraftsMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key.trim().length === 0) continue
        if (typeof value !== 'string') continue
        result[key] = value
    }
    return result
}

// localStorage (not sessionStorage) so drafts survive closing the tab and the
// browser/OS discarding a backgrounded mobile PWA, matching attachment drafts
// in IndexedDB.
function hydrate(): DraftsMap {
    if (cache) return cache
    if (typeof window === 'undefined') {
        cache = {}
        return cache
    }
    try {
        cache = readStored()
    } catch {
        cache = {}
    }
    for (const key of Object.keys(cache)) markDraftEdited(key)
    return cache
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

// Other tabs share localStorage: re-read before writing and change only this
// session's entry, so a stale in-memory map never drops their drafts.
function persist(sessionId: string, text: string | null): void {
    if (typeof window === 'undefined') return
    try {
        const stored = readStored()
        delete stored[sessionId]
        if (text !== null) stored[sessionId] = text
        evict(stored)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
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
    evict(drafts)
    persist(sessionId, trimmed ? text : null)
}

export function clearDraft(sessionId: string): void {
    markDraftEdited(sessionId)
    const drafts = hydrate()
    delete drafts[sessionId]
    persist(sessionId, null)
}
