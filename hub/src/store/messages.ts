import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { getLiveReasoningStreamId } from '@hapi/protocol/messages'

import type { StoredMessage } from './types'
import { decodeMessageContent, encodeMessageContent, truncateOversizedMessageContent } from './contentCodec'

type DbMessageRow = {
    id: string
    session_id: string
    // TEXT (plaintext JSON, legacy rows) or BLOB (zstd-compressed JSON) — see contentCodec.ts
    content: string | Uint8Array
    created_at: number
    seq: number
    local_id: string | null
    invoked_at: number | null
    scheduled_at: number | null
    delivery_state: string | null
}

export type MessagePosition = {
    at: number
    seq: number
}

export type SteerDeliveryState = 'queued' | 'dispatching' | 'indeterminate'

export class ImportedMessageConflictError extends Error {
    constructor(readonly localId: string) {
        super(`Imported message content changed for localId: ${localId}`)
        this.name = 'ImportedMessageConflictError'
    }
}

export function addImportedMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId: string,
    createdAt: number
): { message: StoredMessage; inserted: boolean } {
    const existing = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
    ).get(sessionId, localId) as DbMessageRow | undefined
    if (existing) {
        const message = toStoredMessage(existing)
        const canonicalContent = truncateOversizedMessageContent(content)
        if (!isDeepStrictEqual(message.content, canonicalContent)) throw new ImportedMessageConflictError(localId)
        return { message, inserted: false }
    }

    const now = Date.now()
    const stampedAt = Number.isFinite(createdAt) ? Math.min(createdAt, now) : now
    return db.transaction(() => {
        const previousHead = getNewestMessagePosition(db, sessionId)
        const msgSeqRow = db.prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
        ).get(sessionId) as { nextSeq: number }
        const id = randomUUID()
        db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, NULL
            )
        `).run({
            id,
            session_id: sessionId,
            content: encodeMessageContent(truncateOversizedMessageContent(content)),
            created_at: stampedAt,
            seq: msgSeqRow.nextSeq,
            local_id: localId,
            invoked_at: stampedAt
        })
        if (previousHead && stampedAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create imported message')
        return { message: toStoredMessage(row), inserted: true }
    })()
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: decodeMessageContent(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        invokedAt: row.invoked_at ?? null,
        scheduledAt: row.scheduled_at ?? null,
        ...(row.delivery_state && row.delivery_state !== 'queued' ? { deliveryState: 'indeterminate' as const } : {})
    }
}

export type CopyStoredMessageInput = Pick<
    StoredMessage,
    'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'
>

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string,
    scheduledAt?: number | null,
    createdAt?: number
): StoredMessage {
    const now = Date.now()
    // Client-provided origin timestamp (e.g. a Claude transcript entry's own
    // `timestamp`), falling back to server-receive time when absent. Only
    // agent-message callers (sessionHandlers' `on('message')`) pass this today.
    const stampedAt = Number.isFinite(createdAt)
        ? Math.min(createdAt!, now)
        : now

    // Without a localId, invoked_at is stamped immediately below — there is no
    // ack path to flip it later.  A scheduled message in that state would be
    // skipped by the future-emit branch and never picked up by
    // getMatureScheduledMessages (which filters on invoked_at IS NULL), so
    // the schedule would be silently lost.
    if (scheduledAt != null && !localId) {
        throw new Error('addMessage: scheduledAt requires a localId for the ack flow')
    }

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
    const encoded = encodeMessageContent(truncateOversizedMessageContent(content))

    // Messages without a localId have no ack path (markMessagesInvoked matches by localId).
    // Treat them as already-invoked at insert time so they land in the thread normally instead
    // of being stuck in the queued floating bar forever. Stamped with `stampedAt` (the
    // client-provided createdAt when present) rather than server-now so getMessagesByPosition's
    // COALESCE(invoked_at, created_at) sort reflects the transcript's own jsonl order instead of
    // hub arrival order.
    const invokedAt = localId ? null : stampedAt

    return db.transaction(() => {
        const previousHead = getNewestMessagePosition(db, sessionId)
        db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at
            )
        `).run({
            id,
            session_id: sessionId,
            content: encoded,
            created_at: stampedAt,
            seq: msgSeq,
            local_id: localId ?? null,
            invoked_at: invokedAt,
            scheduled_at: scheduledAt ?? null
        })

        const positionAt = invokedAt ?? stampedAt
        if (previousHead && positionAt < previousHead.at) bumpMessageEpoch(db, sessionId)
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
        if (!row) throw new Error('Failed to create message')
        return toStoredMessage(row)
    })()
}

export function copyMessageToSession(
    db: Database,
    sessionId: string,
    message: CopyStoredMessageInput
): StoredMessage {
    const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
    const nextSeq = getMaxSeq(db, sessionId) + 1

    let localId = message.localId
    if (localId) {
        const collision = db.prepare(
            'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as { 1: number } | undefined
        if (collision) {
            // 中文注释：重复会话合并时如果 localId 撞车，给复制进目标会话的消息生成一个新 localId，避免误判成同一条已存在消息。
            localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
        }
    }

    if (message.scheduledAt != null && !localId && message.invokedAt === null) {
        // 中文注释：未来计划消息仍需要 ack 路径；异常情况下若源数据缺少 localId，这里补一个稳定可写的新值以保留调度语义。
        localId = `merged-scheduled:${randomUUID()}`
    }

    const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
    const id = randomUUID()
    db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, delivery_state
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @delivery_state
        )
    `).run({
        id,
        session_id: sessionId,
        // Lossless re-encode only — copies move existing history between
        // sessions, so no truncation here even for pre-codec oversized rows.
        content: encodeMessageContent(message.content),
        created_at: createdAt,
        seq: nextSeq,
        local_id: localId ?? null,
        invoked_at: invokedAt ?? null,
        scheduled_at: message.scheduledAt ?? null,
        delivery_state: message.deliveryState ?? 'queued'
    })

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to copy message into target session')
    }

    // Copies preserve the source display timestamp, so a new high-seq row can
    // still land behind a Web client's cached composite tail cursor. Mark the
    // target history as structurally changed so incremental readers reset.
    bumpMessageEpoch(db, sessionId)
    return toStoredMessage(row)
}

/**
 * Batch-hydrate a fork child: one transaction, contiguous seq allocation,
 * single epoch bump. Avoids O(n) max-seq lookups and epoch writes.
 */
export function copyMessagesToSession(
    db: Database,
    sessionId: string,
    messages: CopyStoredMessageInput[]
): number {
    if (messages.length === 0) return 0

    return db.transaction(() => {
        let nextSeq = getMaxSeq(db, sessionId) + 1
        const insert = db.prepare(`
            INSERT INTO messages (
                id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at, delivery_state
            ) VALUES (
                @id, @session_id, @content, @created_at, @seq, @local_id, @invoked_at, @scheduled_at, @delivery_state
            )
        `)
        const collisionCheck = db.prepare(
            'SELECT 1 FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        )

        for (const message of messages) {
            const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
            let localId = message.localId
            if (localId) {
                const collision = collisionCheck.get(sessionId, localId) as { 1: number } | undefined
                if (collision) {
                    localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
                }
            }
            if (message.scheduledAt != null && !localId && message.invokedAt === null) {
                localId = `merged-scheduled:${randomUUID()}`
            }
            const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
            insert.run({
                id: randomUUID(),
                session_id: sessionId,
                content: encodeMessageContent(message.content),
                created_at: createdAt,
                seq: nextSeq,
                local_id: localId ?? null,
                invoked_at: invokedAt ?? null,
                scheduled_at: message.scheduledAt ?? null,
                delivery_state: message.deliveryState ?? 'queued'
            })
            nextSeq += 1
        }

        bumpMessageEpoch(db, sessionId)
        return messages.length
    })()
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getAllMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMessagesAfterSeq(
    db: Database,
    sessionId: string,
    afterSeq: number
): StoredMessage[] {
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC'
    ).all(sessionId, afterSeq) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** Current seq for a message that still lives on this session (merge-stable id). */
export function getMessageSeqById(
    db: Database,
    sessionId: string,
    messageId: string
): number | null {
    const row = db.prepare(
        'SELECT seq FROM messages WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as { seq: number } | undefined
    return row ? row.seq : null
}

export function getFirstMessages(
    db: Database,
    sessionId: string,
    limit: number = 50
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** CLI reconnect backfill: returns messages above the seq cursor that are
 *  deliverable now, i.e. excludes future-scheduled rows (scheduled_at > now).
 *  Without this filter, a CLI reconnect between schedule time and release time
 *  would replay future-scheduled rows via the normal message stream and the
 *  runner would consume them immediately, bypassing the mature-scan path.
 *  Only the CLI backfill route should use this; the Web thread API still calls
 *  byPosition / getMessages and needs the full set so scheduled rows surface in
 *  the queued floating bar. */
export function getDeliverableMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    now: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
          AND seq > ?
          AND (scheduled_at IS NULL OR scheduled_at <= ?)
          AND delivery_state = 'queued'
        ORDER BY seq ASC
        LIMIT ?
    `).all(sessionId, safeAfterSeq, now, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

/** How far back to look for a stream's replaceable snapshots.
 *
 *  The CLI re-sends a growing reasoning buffer every few hundred milliseconds,
 *  so the previous snapshot of a stream is always among the newest rows of its
 *  session. Scanning a bounded tail keeps this off the hot path on sessions
 *  with tens of thousands of messages; anything older than the window is left
 *  alone, which errs toward keeping data. */
const REASONING_SNAPSHOT_LOOKBACK = 50

/** Drop the replaceable snapshots of one reasoning stream.
 *
 *  Only messages explicitly marked live are eligible, and `keepMessageId` is
 *  always spared. Callers run this *after* storing the message that supersedes
 *  them, so the stream never passes through a moment with no row at all — the
 *  two statements are separate transactions, and a crash between them must not
 *  be able to take the whole stream with it. Returns how many rows were
 *  removed. */
export function deleteLiveReasoningSnapshots(
    db: Database,
    sessionId: string,
    streamId: string,
    keepMessageId?: string
): number {
    const rows = db.prepare(`
        SELECT id, content FROM messages
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
    `).all(sessionId, REASONING_SNAPSHOT_LOOKBACK) as Array<Pick<DbMessageRow, 'id' | 'content'>>

    const staleIds = rows
        .filter((row) => row.id !== keepMessageId
            && getLiveReasoningStreamId(decodeMessageContent(row.content)) === streamId)
        .map((row) => row.id)
    if (staleIds.length === 0) return 0

    const placeholders = staleIds.map(() => '?').join(', ')
    const result = db.prepare(
        `DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`
    ).run(sessionId, ...staleIds)
    return Number(result.changes)
}

/** Paginate messages by COALESCE(invoked_at, created_at) DESC, seq DESC.
 *  Results are returned in ascending display order. */
export function getMessagesByPosition(
    db: Database,
    sessionId: string,
    limit: number,
    before?: MessagePosition
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

/** Return messages strictly after a display-position cursor in ascending order.
 *  `until`, when supplied, is an inclusive fixed snapshot head so a catch-up
 *  loop does not chase messages appended while it is running. */
export function getMessagesAfterPosition(
    db: Database,
    sessionId: string,
    limit: number,
    after: MessagePosition,
    until?: MessagePosition
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const untilClause = until
        ? `AND (
            COALESCE(invoked_at, created_at) < @untilAt
            OR (COALESCE(invoked_at, created_at) = @untilAt AND seq <= @untilSeq)
        )`
        : ''
    const rows = db.prepare(`
        SELECT *, COALESCE(invoked_at, created_at) AS position_at
        FROM messages
        WHERE session_id = @sessionId
          AND (
            COALESCE(invoked_at, created_at) > @afterAt
            OR (COALESCE(invoked_at, created_at) = @afterAt AND seq > @afterSeq)
          )
          ${untilClause}
        ORDER BY position_at ASC, seq ASC
        LIMIT @limit
    `).all({
        sessionId,
        afterAt: after.at,
        afterSeq: after.seq,
        untilAt: until?.at ?? null,
        untilSeq: until?.seq ?? null,
        limit: safeLimit
    }) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export function getNewestMessagePosition(db: Database, sessionId: string): MessagePosition | null {
    const row = db.prepare(`
        SELECT COALESCE(invoked_at, created_at) AS position_at, seq
        FROM messages
        WHERE session_id = ?
        ORDER BY position_at DESC, seq DESC
        LIMIT 1
    `).get(sessionId) as { position_at: number; seq: number } | undefined
    return row ? { at: row.position_at, seq: row.seq } : null
}

export function getMessageEpoch(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT epoch FROM message_epochs WHERE session_id = ?'
    ).get(sessionId) as { epoch: number } | undefined
    return row?.epoch ?? 0
}

export function bumpMessageEpoch(db: Database, sessionId: string): number {
    db.prepare(`
        INSERT INTO message_epochs (session_id, epoch)
        VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET epoch = epoch + 1
    `).run(sessionId)
    return getMessageEpoch(db, sessionId)
}

/** Returns user messages that have a localId but no invoked_at.
 *  Includes future scheduled messages — used to surface all queued messages
 *  (including scheduled) for the Web floating bar on refresh / secondary clients. */
export function getUninvokedLocalMessages(
    db: Database,
    sessionId: string,
    options?: { deliverableOnly?: boolean }
): StoredMessage[] {
    const deliverableClause = options?.deliverableOnly ? " AND delivery_state = 'queued'" : ''
    const rows = db.prepare(
        `SELECT * FROM messages WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL${deliverableClause} ORDER BY seq ASC`
    ).all(sessionId) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

export type LocalMessageState = {
    localId: string
    invokedAt: number | null
    deliveryState?: string | null
}

export function getLocalMessageStates(
    db: Database,
    sessionId: string,
    localIds: string[]
): LocalMessageState[] {
    if (localIds.length === 0) {
        return []
    }
    const placeholders = localIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        SELECT local_id, invoked_at, delivery_state
        FROM messages
        WHERE session_id = ? AND local_id IN (${placeholders})
        ORDER BY seq ASC
    `).all(sessionId, ...localIds) as Array<{
        local_id: string
        invoked_at: number | null
        delivery_state: string | null
    }>
    return rows.map((row) => ({
        localId: row.local_id,
        invokedAt: row.invoked_at,
        ...(row.delivery_state && row.delivery_state !== 'queued'
            ? { deliveryState: row.delivery_state }
            : {})
    }))
}

/** Returns scheduled messages across all sessions whose scheduled_at <= beforeTime
 *  and have not yet been invoked.  Used by the hub tick to emit mature messages to CLI.
 *  Ordered by scheduled_at ASC (oldest first). */
export function getMatureScheduledMessages(
    db: Database,
    beforeTime: number
): StoredMessage[] {
    const rows = db.prepare(
        "SELECT * FROM messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? AND invoked_at IS NULL AND delivery_state = 'queued' ORDER BY scheduled_at ASC"
    ).all(beforeTime) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

/** Returns immediate-queued local messages for a session — i.e. rows that have
 *  no scheduled_at (scheduled_at IS NULL).  Used by the session-end sweep
 *  (sweepImmediateQueuedOnSessionEnd): these are messages the user posted to a
 *  CLI session that ended before the runner consumed them, so they cannot ever
 *  be delivered and must be force-invoked to clear the floating bar.
 *
 *  Scheduled rows (scheduled_at IS NOT NULL) are *deliberately excluded*, mature
 *  or not.  The mature-scan path (releaseMatureScheduledMessages) is the sole
 *  emit channel for scheduled rows and it does not write invoked_at — the CLI
 *  ack does.  If the session-end sweep stamped a mature scheduled row as
 *  invoked, a subsequent CLI re-attach would never see the row in the
 *  mature-scan results (it filters on invoked_at IS NULL), and the user's
 *  scheduled prompt would be silently dropped.  See HAPI Bot R4 finding. */
export function getImmediateQueuedLocalMessages(
    db: Database,
    sessionId: string
): StoredMessage[] {
    const rows = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND delivery_state = 'queued'
        ORDER BY seq ASC
    `).all(sessionId) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

/**
 * Total messages persisted for a session - any role, any state (including
 * future-scheduled and never-invoked queued rows). Used as the
 * "is this session non-trivial?" signal for the cursor migrator's size
 * sanity check; intentionally broad so a session with 6 000 unread agent
 * outputs and zero invoked user turns still counts as non-trivial.
 * tiann/hapi#872.
 */
export function countMessages(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number } | undefined
    return row?.count ?? 0
}

/** Count uninvoked local messages scheduled for a future time (session list indicator). */
export function countFutureScheduledLocalMessages(
    db: Database,
    sessionId: string,
    now: number
): number {
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ?
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
    `).get(sessionId, now) as { count: number } | undefined
    return row?.count ?? 0
}

/** Batch variant for GET /sessions — one query for all session IDs in a namespace. */
export function countFutureScheduledBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const counts = new Map<string, number>()
    if (sessionIds.length === 0) {
        return counts
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT session_id, COUNT(*) AS count
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; count: number }[]

    for (const row of rows) {
        counts.set(row.session_id, row.count)
    }
    return counts
}

/** Earliest future scheduled_at per session (session-list clock tooltip). */
export function minFutureScheduledAtBySessionIds(
    db: Database,
    sessionIds: string[],
    now: number
): Map<string, number> {
    const nextAt = new Map<string, number>()
    if (sessionIds.length === 0) {
        return nextAt
    }

    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = db.prepare(`
        SELECT session_id, MIN(scheduled_at) AS next_at
        FROM messages
        WHERE session_id IN (${placeholders})
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ?
          AND delivery_state = 'queued'
        GROUP BY session_id
    `).all(...sessionIds, now) as { session_id: string; next_at: number }[]

    for (const row of rows) {
        nextAt.set(row.session_id, row.next_at)
    }
    return nextAt
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
    | { status: 'busy'; localId: string }

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

        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)

        if (deleted.changes > 0) {
            bumpMessageEpoch(db, sessionId)
        }

        return { status: 'cancelled' as const, localId: row.local_id }
    })()
}

export type LookupQueuedMessageResult =
    | { status: 'absent' }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'queued'; localId: string | null; resolvedId: string; scheduledAt: number | null }
    | { status: 'dispatching'; localId: string | null; resolvedId: string; scheduledAt: number | null }
    | { status: 'indeterminate'; localId: string | null; resolvedId: string; scheduledAt: number | null }

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

    if (row.delivery_state === 'dispatching') {
        return { status: 'dispatching' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
    }
    if (row.delivery_state === 'indeterminate') {
        return { status: 'indeterminate' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
    }

    return { status: 'queued' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
}

/** Delete a queued (invoked_at IS NULL) message by id or local_id.
 *
 * This is the "confirmed DELETE" step after the service layer has received a
 * CLI ack with removed:true.  Uses the same first-write-wins guard as the
 * original cancelQueuedMessage. */
/** Claim a durable unknown-delivery row for an explicit retry. */
export function claimIndeterminateMessage(
    db: Database,
    sessionId: string,
    messageId: string
): StoredMessage | null {
    return db.transaction(() => {
        const claimed = db.prepare(`
            UPDATE messages
            SET delivery_state = 'dispatching'
            WHERE session_id = ?
              AND (id = ? OR local_id = ?)
              AND invoked_at IS NULL
              AND delivery_state = 'indeterminate'
        `).run(sessionId, messageId, messageId)
        if (claimed.changes === 0) return null
        const updated = db.prepare(`
            SELECT * FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?)
              AND invoked_at IS NULL
              AND delivery_state = 'dispatching'
            LIMIT 1
        `).get(sessionId, messageId, messageId) as DbMessageRow | undefined
        return updated ? toStoredMessage(updated) : null
    })()
}

export function deleteQueuedMessageById(
    db: Database,
    sessionId: string,
    messageId: string
): boolean {
    return db.transaction(() => {
        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ? AND (id = ? OR local_id = ?) AND invoked_at IS NULL
        `).run(sessionId, messageId, messageId)
        if (deleted.changes > 0) {
            bumpMessageEpoch(db, sessionId)
            return true
        }
        return false
    })()
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
): number {
    if (localIds.length === 0) return 0
    const placeholders = localIds.map(() => '?').join(', ')
    return db.prepare(
        `UPDATE messages
         SET invoked_at = ?, delivery_state = 'queued'
         WHERE session_id = ?
           AND local_id IN (${placeholders})
           AND invoked_at IS NULL`
    ).run(invokedAt, sessionId, ...localIds).changes
}

/** Move an uninvoked steer through its durable delivery states. */
export function setMessagesDeliveryState(
    db: Database,
    sessionId: string,
    localIds: string[],
    state: SteerDeliveryState
): number {
    if (localIds.length === 0) return 0
    const placeholders = localIds.map(() => '?').join(', ')
    const fromStates = state === 'queued'
        ? "'dispatching', 'indeterminate'"
        : state === 'dispatching'
            ? "'queued', 'indeterminate'"
            : "'queued', 'dispatching'"
    return db.prepare(
        `UPDATE messages
         SET delivery_state = ?
         WHERE session_id = ?
           AND local_id IN (${placeholders})
           AND invoked_at IS NULL
           AND delivery_state IN (${fromStates})`
    ).run(state, sessionId, ...localIds).changes
}

/** Hold an ambiguous steer out of automatic replay without claiming delivery. */
export function markMessagesIndeterminate(
    db: Database,
    sessionId: string,
    localIds: string[]
): number {
    return setMessagesDeliveryState(db, sessionId, localIds, 'indeterminate')
}

/** Settle immediate queued rows on an archived clear source without touching
 * scheduled rows, which must remain uninvoked for transfer to the replacement. */
export function markUninvokedImmediateMessages(
    db: Database,
    sessionId: string,
    invokedAt: number
): string[] {
    const rows = db.prepare(`
        SELECT local_id FROM messages
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
          AND delivery_state = 'queued'
        ORDER BY seq ASC
    `).all(sessionId) as Array<{ local_id: string }>
    if (rows.length === 0) return []

    db.prepare(`
        UPDATE messages
        SET invoked_at = ?
        WHERE session_id = ?
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
          AND invoked_at IS NULL
          AND delivery_state = 'queued'
    `).run(invokedAt, sessionId)
    return rows.map((row) => row.local_id)
}

/**
 * Reassign only uninvoked scheduled rows when an archived OpenCode session
 * is replaced by /clear. The transaction preserves ids/localIds so the normal
 * scheduled-message ack path continues on the replacement session.
 */
export function moveUninvokedScheduledMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): number {
    if (fromSessionId === toSessionId) return 0

    const rows = db.prepare(`
        SELECT id FROM messages
        WHERE session_id = ?
          AND scheduled_at IS NOT NULL
          AND invoked_at IS NULL
        ORDER BY seq ASC
    `).all(fromSessionId) as Array<{ id: string }>
    if (rows.length === 0) return 0

    try {
        db.exec('BEGIN')
        let nextSeq = getMaxSeq(db, toSessionId)
        const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) {
            nextSeq += 1
            update.run(toSessionId, nextSeq, row.id)
        }
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        db.exec('COMMIT')
        return rows.length
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Move every still-held prompt to a reserved replacement, preserving FIFO.
 * If both sessions already contain the same non-null localId, the replacement
 * row is authoritative (it represents the retry/new owner) and only the
 * uninvoked source duplicate is discarded.
 */
export function moveUninvokedMessages(db: Database, fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) return 0
    return db.transaction(() => {
        const discarded = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND invoked_at IS NULL
              AND local_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM messages AS target
                  WHERE target.session_id = ?
                    AND target.local_id = messages.local_id
              )
        `).run(fromSessionId, toSessionId).changes
        const rows = db.prepare(`
            SELECT id, session_id FROM messages
            WHERE session_id IN (?, ?) AND invoked_at IS NULL
            -- created_at is millisecond-granularity; rowid is the durable
            -- cross-session insertion order for ties within this database.
            ORDER BY created_at ASC,
                     rowid ASC,
                     seq ASC,
                     id ASC
        `).all(fromSessionId, toSessionId) as Array<{ id: string; session_id: string }>
        const moved = rows.filter((row) => row.session_id === fromSessionId).length
        if (discarded === 0 && moved === 0) return 0
        const invokedMax = db.prepare(`
            SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages
            WHERE session_id = ? AND invoked_at IS NOT NULL
        `).get(toSessionId) as { maxSeq: number }
        let nextSeq = invokedMax.maxSeq
        const update = db.prepare('UPDATE messages SET session_id = ?, seq = ? WHERE id = ?')
        for (const row of rows) update.run(toSessionId, ++nextSeq, row.id)
        bumpMessageEpoch(db, fromSessionId)
        bumpMessageEpoch(db, toSessionId)
        return discarded + moved
    })()
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

        if (result.changes > 0) {
            bumpMessageEpoch(db, fromSessionId)
            bumpMessageEpoch(db, toSessionId)
        }

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}

/**
 * Truncate transcript at/after the message with `localId`, optionally replacing
 * the removed suffix with `replacement` messages. Bumps message epoch so web
 * clients reset their window.
 */
export function truncateMessagesFromLocalId(
    db: Database,
    sessionId: string,
    localId: string,
    replacement: Array<{
        content: unknown
        localId?: string | null
        createdAt?: number
        invokedAt?: number | null
    }> = []
): { deleted: number; inserted: number; epoch: number } {
    return db.transaction(() => {
        const target = db.prepare(`
            SELECT id, seq, COALESCE(invoked_at, created_at) AS position_at
            FROM messages
            WHERE session_id = ? AND local_id = ?
            LIMIT 1
        `).get(sessionId, localId) as { id: string; seq: number; position_at: number } | undefined

        if (!target) {
            throw new Error(`Message not found for localId: ${localId}`)
        }

        const deleted = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND (
                COALESCE(invoked_at, created_at) > ?
                OR (COALESCE(invoked_at, created_at) = ? AND seq >= ?)
              )
        `).run(sessionId, target.position_at, target.position_at, target.seq)

        let inserted = 0
        for (const message of replacement) {
            const now = Date.now()
            const msgSeqRow = db.prepare(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
            ).get(sessionId) as { nextSeq: number }
            const id = randomUUID()
            const createdAt = message.createdAt ?? now
            const invokedAt = message.invokedAt === undefined ? createdAt : message.invokedAt
            const rowLocalId = message.localId ?? null
            db.prepare(`
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
                id,
                sessionId,
                encodeMessageContent(message.content),
                createdAt,
                msgSeqRow.nextSeq,
                rowLocalId,
                invokedAt
            )
            inserted += 1
        }

        const epoch = bumpMessageEpoch(db, sessionId)
        return { deleted: deleted.changes, inserted, epoch }
    })()
}
