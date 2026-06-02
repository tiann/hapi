/**
 * Per-session scratchlist storage (issue #11).
 *
 * The scratchlist is the operator's *workbench*: notes / drafts / parking lot
 * entries that are explicitly **not** queued for sending. Compare to the
 * queue (`QueuedMessagesBar`), which is a conveyor belt that auto-fires
 * messages in order. Scratchlist entries are held until the operator
 * promotes them (to the composer or into the queue) or deletes them.
 *
 * Storage is per-session in `localStorage` under
 * `hapi.scratchlist.v1.<sessionId>` so entries survive reloads but stay
 * scoped to a single conversation. Hub-sync is intentionally deferred
 * (v2) to keep this PR small.
 */
const STORAGE_KEY_PREFIX = 'hapi.scratchlist.v1.'

/** Hard upper bound to keep payloads sane and rule out runaway growth. */
export const SCRATCHLIST_MAX_ENTRIES = 200

/** Per-entry text cap: matches what a long composer paste can produce. */
export const SCRATCHLIST_MAX_TEXT_LENGTH = 10_000

export type ScratchlistEntry = {
    id: string
    text: string
    createdAt: number
}

function getStorageKey(sessionId: string): string {
    return `${STORAGE_KEY_PREFIX}${sessionId}`
}

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

function isEntry(value: unknown): value is ScratchlistEntry {
    if (!value || typeof value !== 'object') return false
    const entry = value as Record<string, unknown>
    return (
        typeof entry.id === 'string'
        && entry.id.length > 0
        && typeof entry.text === 'string'
        && typeof entry.createdAt === 'number'
        && Number.isFinite(entry.createdAt)
    )
}

export function readScratchlist(sessionId: string): ScratchlistEntry[] {
    if (!sessionId) return []
    const storage = getLocalStorage()
    if (!storage) return []

    let raw: string | null
    try {
        raw = storage.getItem(getStorageKey(sessionId))
    } catch {
        return []
    }
    if (!raw) return []

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []

    const entries: ScratchlistEntry[] = []
    for (const item of parsed) {
        if (isEntry(item)) entries.push(item)
        if (entries.length >= SCRATCHLIST_MAX_ENTRIES) break
    }
    return entries
}

function writeScratchlist(sessionId: string, entries: ScratchlistEntry[]): void {
    if (!sessionId) return
    const storage = getLocalStorage()
    if (!storage) return
    try {
        const trimmed = entries.slice(0, SCRATCHLIST_MAX_ENTRIES)
        storage.setItem(getStorageKey(sessionId), JSON.stringify(trimmed))
    } catch {
        // Storage quota or serialization failures are non-fatal: the in-memory
        // copy still works for the rest of the session.
    }
}

function makeEntryId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    return `scratch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Append a new entry to the scratchlist. Returns the new entry list (or
 * the previous list unchanged when text is empty / would exceed the cap).
 *
 * Trimming behavior: leading/trailing whitespace stripped; empty input
 * is rejected (returns the input list unchanged). Entries longer than
 * `SCRATCHLIST_MAX_TEXT_LENGTH` are truncated rather than rejected so
 * pasting a giant blob still ends up captured.
 */
export function addScratchlistEntry(
    entries: ScratchlistEntry[],
    rawText: string,
    now: number = Date.now()
): { entries: ScratchlistEntry[]; added: ScratchlistEntry | null } {
    const text = rawText.trim()
    if (text.length === 0) {
        return { entries, added: null }
    }
    const truncated = text.length > SCRATCHLIST_MAX_TEXT_LENGTH
        ? text.slice(0, SCRATCHLIST_MAX_TEXT_LENGTH)
        : text
    const entry: ScratchlistEntry = {
        id: makeEntryId(),
        text: truncated,
        createdAt: now,
    }
    // Newest-first ordering: matches the way operators read the workbench
    // (most recent thought at the top, scrolling down for older).
    const next = [entry, ...entries].slice(0, SCRATCHLIST_MAX_ENTRIES)
    return { entries: next, added: entry }
}

export function deleteScratchlistEntry(
    entries: ScratchlistEntry[],
    id: string
): ScratchlistEntry[] {
    return entries.filter((e) => e.id !== id)
}

/**
 * Move an entry up (toward index 0) or down (toward the end). Out-of-range
 * moves are no-ops so the UI can call this unconditionally without first
 * checking position.
 */
export function moveScratchlistEntry(
    entries: ScratchlistEntry[],
    id: string,
    direction: 'up' | 'down'
): ScratchlistEntry[] {
    const index = entries.findIndex((e) => e.id === id)
    if (index < 0) return entries
    const swapWith = direction === 'up' ? index - 1 : index + 1
    if (swapWith < 0 || swapWith >= entries.length) return entries
    const next = [...entries]
    const tmp = next[index]
    const other = next[swapWith]
    if (!tmp || !other) return entries
    next[index] = other
    next[swapWith] = tmp
    return next
}

export function persistScratchlist(sessionId: string, entries: ScratchlistEntry[]): void {
    writeScratchlist(sessionId, entries)
}

export function clearScratchlist(sessionId: string): void {
    if (!sessionId) return
    const storage = getLocalStorage()
    if (!storage) return
    try {
        storage.removeItem(getStorageKey(sessionId))
    } catch {
        // Non-fatal.
    }
}

/**
 * Confirm-on-delete threshold. Trivial entries delete instantly; longer
 * notes deserve a confirmation prompt so a stray click doesn't lose work.
 * Threshold tuned to "anything longer than a one-line reminder".
 */
export const SCRATCHLIST_CONFIRM_DELETE_THRESHOLD = 100

export function shouldConfirmDelete(entry: ScratchlistEntry | null | undefined): boolean {
    if (!entry) return false
    return entry.text.length > SCRATCHLIST_CONFIRM_DELETE_THRESHOLD
}
