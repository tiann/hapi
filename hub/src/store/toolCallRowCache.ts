import type { Database } from 'bun:sqlite'

/**
 * In-process memo of "which stored row is the live row of this tool call".
 *
 * `upsertToolCallMessage` used to find that row by scanning the newest 200
 * messages of a session and zstd-decoding each row until the callId matched.
 * ACP agents re-emit a call under a stable callId on every state tick, so
 * that scan (and its decodes) ran on nearly every `tool_call_update`. This
 * cache turns the common case into a primary-key UPDATE of a remembered row.
 *
 * Correctness contract — an entry is only valid while the row it names is
 * still the *live* row of the call, i.e. while nothing has arrived after it
 * that the tail scan would treat as closing the call:
 *
 *  - a stored `tool-call-result` with the same callId closes it, and
 *  - a user message row starts a new turn and closes every live call of
 *    that session.
 *
 * Both of those inserts drop the affected entries (see addMessage), and the
 * delete/move paths drop whole sessions (see the *_messages functions and
 * deleteSession). A stale entry that slips through anyway is still safe:
 * the hit path re-reads the row by id and verifies it still carries the
 * callId, and falls back to the authoritative tail scan otherwise.
 *
 * Keyed per `Database` so concurrent Store instances (tests, imports) never
 * share entries, and so the cache dies with the connection it describes.
 */

type ToolCallRowEntry = {
    sessionId: string
    rowId: string
}

const MAX_ENTRIES = 1024

const caches = new WeakMap<Database, Map<string, ToolCallRowEntry>>()

/** callIds are only unique per session (forked sessions copy them verbatim),
 *  so entries are keyed by the pair. */
function entryKey(sessionId: string, callId: string): string {
    return `${sessionId}\u0000${callId}`
}

function cacheFor(db: Database): Map<string, ToolCallRowEntry> {
    let cache = caches.get(db)
    if (!cache) {
        cache = new Map()
        caches.set(db, cache)
    }
    return cache
}

/** The remembered row id for a live tool call, or null when unknown. */
export function getCachedToolCallRowId(db: Database, sessionId: string, callId: string): string | null {
    const cache = caches.get(db)
    if (!cache) return null
    const entry = cache.get(entryKey(sessionId, callId))
    if (!entry) return null
    // Refresh recency: Map preserves insertion order, so a re-touched entry
    // moves to the back and simple oldest-first eviction approximates LRU.
    cache.delete(entryKey(sessionId, callId))
    cache.set(entryKey(sessionId, callId), entry)
    return entry.rowId
}

/** Remember (or refresh) the live row of a tool call. Evicts the
 *  least-recently-used entry once the cache exceeds its bound. */
export function setCachedToolCallRowId(db: Database, sessionId: string, callId: string, rowId: string): void {
    const cache = cacheFor(db)
    const key = entryKey(sessionId, callId)
    cache.delete(key)
    cache.set(key, { sessionId, rowId })
    if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
    }
}

/** Forget one call's entry — used when its result row lands. */
export function dropCachedToolCallRow(db: Database, sessionId: string, callId: string): void {
    caches.get(db)?.delete(entryKey(sessionId, callId))
}

/** Forget every entry of one session — used when rows are deleted, moved, or
 *  a user message starts a new turn there. */
export function dropCachedToolCallRowsForSession(db: Database, sessionId: string): void {
    const cache = caches.get(db)
    if (!cache) return
    for (const [key, entry] of cache) {
        if (entry.sessionId === sessionId) cache.delete(key)
    }
}
