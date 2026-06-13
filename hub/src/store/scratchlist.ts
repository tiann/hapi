import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import type { StoredScratchlistEntry } from './types'

/**
 * Per-session scratchlist storage (tiann/hapi#893, scratchlist v2).
 *
 * The hub is the source of truth for scratchlist entries; web treats
 * `localStorage` as an offline cache only. All queries are scoped by
 * `session_id` + (where it matters) the session's namespace - the latter
 * is enforced one layer up in `SyncEngine` / web routes via
 * `requireSessionFromParam`, so the SQL layer here treats `session_id`
 * as the primary scope.
 *
 * Mental model carried from v1 (#798): scratchlist != queue. Entries are
 * notes / drafts / parking-lot ideas, never auto-sent. The hub-side
 * representation is deliberately lean:
 *
 *   - `text` plain string (no markdown rendering planned for v2)
 *   - `created_at` immutable since insert
 *   - `updated_at` bumped on edits to drive the SSE patch token
 *   - cascade-delete from `sessions(id)` covers the delete-session path
 *
 * Per-session caps live in `@hapi/protocol/apiTypes`
 * (`SCRATCHLIST_MAX_ENTRIES`, `SCRATCHLIST_MAX_TEXT_LENGTH`); the route
 * layer enforces them at write time. The SQL layer accepts whatever it's
 * given - the cap is policy, not schema.
 */

type DbScratchlistRow = {
    session_id: string
    entry_id: string
    text: string
    created_at: number
    updated_at: number
}

function toStoredEntry(row: DbScratchlistRow): StoredScratchlistEntry {
    return {
        sessionId: row.session_id,
        entryId: row.entry_id,
        text: row.text,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export function listScratchlistEntries(
    db: Database,
    sessionId: string
): StoredScratchlistEntry[] {
    const rows = db.prepare(
        `SELECT session_id, entry_id, text, created_at, updated_at
         FROM session_scratchlist
         WHERE session_id = ?
         ORDER BY created_at DESC, entry_id DESC`
    ).all(sessionId) as DbScratchlistRow[]
    return rows.map(toStoredEntry)
}

export function countScratchlistEntries(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COUNT(*) AS n FROM session_scratchlist WHERE session_id = ?'
    ).get(sessionId) as { n: number } | undefined
    return row?.n ?? 0
}

export function getScratchlistEntry(
    db: Database,
    sessionId: string,
    entryId: string
): StoredScratchlistEntry | null {
    const row = db.prepare(
        `SELECT session_id, entry_id, text, created_at, updated_at
         FROM session_scratchlist
         WHERE session_id = ? AND entry_id = ?`
    ).get(sessionId, entryId) as DbScratchlistRow | undefined
    return row ? toStoredEntry(row) : null
}

/**
 * Insert a new scratchlist entry. Returns the stored row on success, or
 * `{ outcome: 'duplicate' }` when the supplied `entryId` already exists
 * (the migration path can collide on retry; clients should treat that as
 * idempotent). `{ outcome: 'session-not-found' }` is returned when the FK
 * to `sessions` would fail - keeps the route handler from having to
 * pre-check session existence.
 */
export type CreateScratchlistResult =
    | { outcome: 'created'; entry: StoredScratchlistEntry }
    | { outcome: 'duplicate'; entry: StoredScratchlistEntry }
    | { outcome: 'session-not-found' }

export function createScratchlistEntry(
    db: Database,
    sessionId: string,
    text: string,
    options?: { entryId?: string; createdAt?: number }
): CreateScratchlistResult {
    const now = Date.now()
    const entryId = options?.entryId ?? randomUUID()
    const createdAt = options?.createdAt ?? now
    const updatedAt = now

    // Pre-check FK so the route layer can return a clean 404. Doing this
    // before the INSERT keeps the error-handling path narrower (no
    // SQLite-error string parsing).
    const sessionExists = db.prepare(
        'SELECT 1 FROM sessions WHERE id = ? LIMIT 1'
    ).get(sessionId) as { 1: number } | undefined
    if (!sessionExists) {
        return { outcome: 'session-not-found' }
    }

    const existing = getScratchlistEntry(db, sessionId, entryId)
    if (existing) {
        return { outcome: 'duplicate', entry: existing }
    }

    db.prepare(
        `INSERT INTO session_scratchlist
            (session_id, entry_id, text, created_at, updated_at)
         VALUES (@session_id, @entry_id, @text, @created_at, @updated_at)`
    ).run({
        session_id: sessionId,
        entry_id: entryId,
        text,
        created_at: createdAt,
        updated_at: updatedAt
    })

    const created = getScratchlistEntry(db, sessionId, entryId)
    if (!created) {
        // Should be unreachable: we just inserted under the same scope.
        throw new Error('Failed to read scratchlist entry after insert')
    }
    return { outcome: 'created', entry: created }
}

/**
 * Update an existing entry's `text`. Bumps `updated_at` to `Date.now()`.
 * Returns `null` when the entry does not exist (route layer turns into a
 * 404). Note: `created_at` is intentionally NOT updated.
 */
export function updateScratchlistEntry(
    db: Database,
    sessionId: string,
    entryId: string,
    text: string
): StoredScratchlistEntry | null {
    const now = Date.now()
    const result = db.prepare(
        `UPDATE session_scratchlist
            SET text = @text,
                updated_at = @updated_at
          WHERE session_id = @session_id
            AND entry_id = @entry_id`
    ).run({
        session_id: sessionId,
        entry_id: entryId,
        text,
        updated_at: now
    })
    if (result.changes === 0) {
        return null
    }
    return getScratchlistEntry(db, sessionId, entryId)
}

export function deleteScratchlistEntry(
    db: Database,
    sessionId: string,
    entryId: string
): boolean {
    const result = db.prepare(
        `DELETE FROM session_scratchlist
          WHERE session_id = ? AND entry_id = ?`
    ).run(sessionId, entryId)
    return result.changes > 0
}
