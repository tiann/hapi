import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import type { StoredMessage } from './types'
import { safeJsonParse } from './json'

type DbMessageRow = {
    id: string
    session_id: string
    content: string
    created_at: number
    seq: number
    local_id: string | null
    invoked_at: number | null
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: safeJsonParse(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        invokedAt: row.invoked_at ?? null
    }
}

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string
): StoredMessage {
    const now = Date.now()

    if (localId) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    const msgSeqRow = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { nextSeq: number }
    const msgSeq = msgSeqRow.nextSeq

    const id = randomUUID()
    const json = JSON.stringify(content)

    // Messages without a localId have no ack path (markMessagesInvoked matches by localId).
    // Treat them as already-invoked at insert time so they land in the thread normally instead
    // of being stuck in the queued floating bar forever.
    const invokedAt = localId ? null : now

    db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, invoked_at
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at
        )
    `).run({
        id,
        session_id: sessionId,
        content: json,
        created_at: now,
        seq: msgSeq,
        local_id: localId ?? null,
        invoked_at: invokedAt
    })

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to create message')
    }
    return toStoredMessage(row)
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200,
    beforeSeq?: number
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = (beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(beforeSeq))
        ? db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, beforeSeq, safeLimit) as DbMessageRow[]
        : db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeAfterSeq, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** Paginate messages by COALESCE(invoked_at, created_at) DESC, seq DESC.
 *  Used for V8 byPosition mode.  Results are returned in ascending display order. */
export function getMessagesByPosition(
    db: Database,
    sessionId: string,
    limit: number,
    before?: { at: number; seq: number }
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const beforeClause = before
        ? 'AND (COALESCE(invoked_at, created_at) < @beforeAt OR (COALESCE(invoked_at, created_at) = @beforeAt AND seq < @beforeSeq))'
        : ''
    const rows = db.prepare(`
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          ${beforeClause}
        ORDER BY position_at DESC, seq DESC
        LIMIT @limit
    `).all({
        sessionId,
        beforeAt: before?.at ?? null,
        beforeSeq: before?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    // Reverse so results are in ascending display order (oldest first)
    return rows.reverse().map(toStoredMessage)
}

/** Returns user messages that have a localId but no invoked_at.
 *  Used to surface queued messages on refresh / secondary clients even when they
 *  fall outside the latest position-ordered page (their position key is the send
 *  time, but the floating bar still needs to render them). */
export function getUninvokedLocalMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
}

export type CancelQueuedMessageResult =
    | { status: 'cancelled'; localId: string | null }
    | { status: 'invoked'; message: StoredMessage }

/** Delete a queued (invoked_at IS NULL) message by session + message id.
 *
 * Runs inside a transaction to eliminate the SELECT-then-DELETE race window.
 * Returns a discriminated union so callers can distinguish two zero-delete cases:
 *   - 'cancelled': row was absent (already cancelled, or wrong id/session) — treat as success.
 *   - 'invoked':   row exists but invoked_at IS NOT NULL (CLI consumed it first) —
 *                  caller must revert any optimistic removal using the returned row,
 *                  not a stale client-side snapshot, so invokedAt is authoritative.
 *
 * The invoked_at IS NULL guard ensures cancel and invoke are mutually exclusive at
 * the DB level (first-write-wins, mirrors markMessagesInvoked). */
export function cancelQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): CancelQueuedMessageResult {
    return db.transaction(() => {
        // Accept either the server-assigned uuid (id) or the client localId.
        // This handles the pre-echo window where the web client still holds
        // msg.id === localId and passes that as the messageId parameter.
        // Note: local_id = ? evaluates to NULL (no match) when local_id IS NULL,
        // which is safe — messages without a localId are inserted with invoked_at set
        // and are never queued, so they cannot reach this code path anyway.
        const row = db.prepare(`
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

        if (!row) {
            // Row absent: already cancelled or wrong id — fold into 'cancelled'
            return { status: 'cancelled' as const, localId: null }
        }

        if (row.invoked_at !== null) {
            // CLI already consumed this message before the cancel arrived.
            // Return the full row so the web client can restore authoritative invoked state
            // rather than reverting to a stale queued snapshot (invokedAt: null).
            return { status: 'invoked' as const, message: toStoredMessage(row) }
        }

        db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)

        return { status: 'cancelled' as const, localId: row.local_id }
    })()
}

export type LookupQueuedMessageResult =
    | { status: 'absent' }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'queued'; localId: string | null; resolvedId: string }

/** Look up a queued message without deleting it.
 *
 * Returns one of three discriminated states:
 *   - 'absent':  row not found (already cancelled or wrong id).
 *   - 'invoked': row exists but invoked_at IS NOT NULL (CLI consumed it first).
 *   - 'queued':  row exists and is cancellable; resolvedId is the server-assigned uuid.
 *
 * Used by the service layer to inspect state before issuing a CLI ack round-trip.
 * The actual DELETE (after CLI ack) is performed by deleteQueuedMessageById. */
export function lookupQueuedMessage(
    db: Database,
    sessionId: string,
    messageId: string
): LookupQueuedMessageResult {
    const row = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ? AND (id = ? OR local_id = ?)
        LIMIT 1
    `).get(sessionId, messageId, messageId) as DbMessageRow | undefined

    if (!row) {
        return { status: 'absent' as const }
    }

    if (row.invoked_at !== null) {
        return { status: 'invoked' as const, message: toStoredMessage(row) }
    }

    return { status: 'queued' as const, localId: row.local_id, resolvedId: row.id }
}

/** Delete a queued (invoked_at IS NULL) message by id or local_id.
 *
 * This is the "confirmed DELETE" step after the service layer has received a
 * CLI ack with removed:true.  Uses the same first-write-wins guard as the
 * original cancelQueuedMessage. */
export function deleteQueuedMessageById(
    db: Database,
    sessionId: string,
    messageId: string
): void {
    db.prepare(`
        DELETE FROM messages
        WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
    `).run(sessionId, messageId, messageId)
}

/** Mark messages as invoked at the given server timestamp.
 *  Only updates rows whose local_id is in localIds.
 *  First-write-wins: rows with a non-NULL invoked_at are not updated.  A duplicate
 *  ack (e.g. a CLI re-emit) would otherwise re-stamp the timestamp and shuffle
 *  the message's position in the byPosition-ordered thread. */
export function markMessagesInvoked(
    db: Database,
    sessionId: string,
    localIds: string[],
    invokedAt: number
): void {
    if (localIds.length === 0) return
    const placeholders = localIds.map(() => '?').join(', ')
    db.prepare(
        `UPDATE messages
         SET invoked_at = ?
         WHERE session_id = ?
           AND local_id IN (${placeholders})
           AND invoked_at IS NULL`
    ).run(invokedAt, sessionId, ...localIds)
}

export function mergeSessionMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    const oldMaxSeq = getMaxSeq(db, fromSessionId)
    const newMaxSeq = getMaxSeq(db, toSessionId)

    try {
        db.exec('BEGIN')

        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            db.prepare(
                'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
            ).run(oldMaxSeq, toSessionId)
        }

        const collisions = db.prepare(`
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

        if (collisions.length > 0) {
            const localIds = collisions.map((row) => row.local_id)
            const placeholders = localIds.map(() => '?').join(', ')
            // Force-invoke the older copy: clearing local_id severs its ack path
            // (markMessagesInvoked matches by local_id), so leaving invoked_at
            // NULL would strand the row in the queued floating bar forever.
            // Use COALESCE so an already-invoked row keeps its server timestamp.
            db.prepare(
                `UPDATE messages
                 SET local_id = NULL,
                     invoked_at = COALESCE(invoked_at, created_at)
                 WHERE session_id = ? AND local_id IN (${placeholders})`
            ).run(fromSessionId, ...localIds)
        }

        const result = db.prepare(
            'UPDATE messages SET session_id = ? WHERE session_id = ?'
        ).run(toSessionId, fromSessionId)

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}
