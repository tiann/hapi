import type { Database } from 'bun:sqlite'

export type UsageEventKind = 'delta' | 'cumulative'

export type UsageEvent = {
    sessionId: string
    sourceKey: string
    sourceSeq: number
    createdAt: number
    agent: string
    model: string | null
    kind: UsageEventKind
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    lastInputTokens: number | null
    lastOutputTokens: number | null
    lastCacheReadTokens: number | null
    lastCacheCreationTokens: number | null
}

export type UsageScanState = {
    messageEpoch: number
    lastSeq: number
}

type UsageEventRow = {
    session_id: string
    source_key: string
    source_seq: number
    created_at: number
    agent: string
    model: string | null
    kind: UsageEventKind
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    last_input_tokens: number | null
    last_output_tokens: number | null
    last_cache_read_tokens: number | null
    last_cache_creation_tokens: number | null
}

function toUsageEvent(row: UsageEventRow): UsageEvent {
    return {
        sessionId: row.session_id,
        sourceKey: row.source_key,
        sourceSeq: row.source_seq,
        createdAt: row.created_at,
        agent: row.agent,
        model: row.model,
        kind: row.kind,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        lastInputTokens: row.last_input_tokens,
        lastOutputTokens: row.last_output_tokens,
        lastCacheReadTokens: row.last_cache_read_tokens,
        lastCacheCreationTokens: row.last_cache_creation_tokens
    }
}

export function recordUsageScan(
    db: Database,
    sessionId: string,
    messageEpoch: number,
    lastSeq: number,
    events: UsageEvent[],
    replaceEvents: boolean
): void {
    db.transaction(() => {
        if (replaceEvents) {
            db.prepare('DELETE FROM usage_events WHERE session_id = ?').run(sessionId)
        }

        if (events.length > 0) {
            const statement = db.prepare(`
                INSERT INTO usage_events (
                    session_id,
                    source_key,
                    source_seq,
                    created_at,
                    agent,
                    model,
                    kind,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    last_input_tokens,
                    last_output_tokens,
                    last_cache_read_tokens,
                    last_cache_creation_tokens
                ) VALUES (
                    @session_id,
                    @source_key,
                    @source_seq,
                    @created_at,
                    @agent,
                    @model,
                    @kind,
                    @input_tokens,
                    @output_tokens,
                    @cache_read_tokens,
                    @cache_creation_tokens,
                    @last_input_tokens,
                    @last_output_tokens,
                    @last_cache_read_tokens,
                    @last_cache_creation_tokens
                )
                ON CONFLICT(session_id, source_key)
                DO UPDATE SET
                    source_seq = excluded.source_seq,
                    created_at = excluded.created_at,
                    agent = excluded.agent,
                    model = excluded.model,
                    kind = excluded.kind,
                    input_tokens = excluded.input_tokens,
                    output_tokens = excluded.output_tokens,
                    cache_read_tokens = excluded.cache_read_tokens,
                    cache_creation_tokens = excluded.cache_creation_tokens,
                    last_input_tokens = excluded.last_input_tokens,
                    last_output_tokens = excluded.last_output_tokens,
                    last_cache_read_tokens = excluded.last_cache_read_tokens,
                    last_cache_creation_tokens = excluded.last_cache_creation_tokens
                WHERE usage_events.kind = 'delta'
            `)
            const updateCumulativeModel = db.prepare(`
                UPDATE usage_events
                SET model = ?
                WHERE session_id = ?
                    AND source_key = ?
                    AND kind = 'cumulative'
            `)

            for (const event of events) {
                statement.run({
                    session_id: event.sessionId,
                    source_key: event.sourceKey,
                    source_seq: event.sourceSeq,
                    created_at: event.createdAt,
                    agent: event.agent,
                    model: event.model,
                    kind: event.kind,
                    input_tokens: event.inputTokens,
                    output_tokens: event.outputTokens,
                    cache_read_tokens: event.cacheReadTokens,
                    cache_creation_tokens: event.cacheCreationTokens,
                    last_input_tokens: event.lastInputTokens,
                    last_output_tokens: event.lastOutputTokens,
                    last_cache_read_tokens: event.lastCacheReadTokens,
                    last_cache_creation_tokens: event.lastCacheCreationTokens
                })
                if (event.kind === 'cumulative' && event.model !== null) {
                    updateCumulativeModel.run(event.model, event.sessionId, event.sourceKey)
                }
            }
        }

        db.prepare(`
            INSERT INTO usage_scan_state (session_id, message_epoch, last_seq)
            VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                message_epoch = excluded.message_epoch,
                last_seq = CASE
                    WHEN usage_scan_state.message_epoch = excluded.message_epoch
                        THEN MAX(usage_scan_state.last_seq, excluded.last_seq)
                    ELSE excluded.last_seq
                END
            WHERE excluded.message_epoch >= usage_scan_state.message_epoch
        `).run(sessionId, messageEpoch, lastSeq)
    })()
}

export function getUsageEvents(db: Database, sessionIds: string[]): UsageEvent[] {
    if (sessionIds.length === 0) return []

    const placeholders = sessionIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        SELECT
            session_id,
            source_key,
            source_seq,
            created_at,
            agent,
            model,
            kind,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            last_input_tokens,
            last_output_tokens,
            last_cache_read_tokens,
            last_cache_creation_tokens
        FROM usage_events
        WHERE session_id IN (${placeholders})
        ORDER BY created_at ASC, source_seq ASC
    `).all(...sessionIds) as UsageEventRow[]

    return rows.map(toUsageEvent)
}

/**
 * `source_key -> model` for one session's indexed events.
 *
 * The scan uses this to recover a model for events whose payload omits it. It
 * only needs two columns, so it must not go through {@link getUsageEvents},
 * which materializes every field of every event of the session.
 */
export function getUsageIndexedModels(db: Database, sessionId: string): Map<string, string> {
    const rows = db.prepare(`
        SELECT source_key, model
        FROM usage_events
        WHERE session_id = ? AND model IS NOT NULL
    `).all(sessionId) as Array<{ source_key: string; model: string }>

    return new Map(rows.map((row) => [row.source_key, row.model]))
}

/** Keyset cursor over the `(created_at, source_seq, rowid)` ordering below. */
export type UsageEventCursor = {
    createdAt: number
    sourceSeq: number
    rowId: number
}

export type PagedUsageEvent = UsageEvent & { rowId: number }

/**
 * Paged variant of {@link getUsageEvents} for the dashboard aggregate, which
 * otherwise materializes every event of the namespace at once — hundreds of
 * thousands of JS objects on a hub with real history.
 *
 * The ordering is the same as {@link getUsageEvents} plus `rowid` as a unique
 * tiebreaker, so callers observe exactly the same sequence; `rowid` only makes
 * the order of otherwise-tied rows deterministic, and cross-stream order does
 * not affect the aggregate. Callers advance the cursor to the last row of each
 * page until a page comes back short.
 */
export function getUsageEventsPage(
    db: Database,
    sessionIds: string[],
    cursor: UsageEventCursor | null,
    limit: number
): PagedUsageEvent[] {
    if (sessionIds.length === 0) return []

    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 5000
    const placeholders = sessionIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        SELECT
            rowid AS row_id,
            session_id,
            source_key,
            source_seq,
            created_at,
            agent,
            model,
            kind,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            last_input_tokens,
            last_output_tokens,
            last_cache_read_tokens,
            last_cache_creation_tokens
        FROM usage_events
        WHERE session_id IN (${placeholders})
          AND (created_at, source_seq, rowid) > (?, ?, ?)
        ORDER BY created_at ASC, source_seq ASC, rowid ASC
        LIMIT ?
    `).all(
        ...sessionIds,
        cursor?.createdAt ?? -1,
        cursor?.sourceSeq ?? -1,
        cursor?.rowId ?? -1,
        safeLimit
    ) as Array<UsageEventRow & { row_id: number }>

    return rows.map((row) => ({ ...toUsageEvent(row), rowId: row.row_id }))
}

export function getUsageScanStates(db: Database, sessionIds: string[]): Map<string, UsageScanState> {
    if (sessionIds.length === 0) return new Map()

    const placeholders = sessionIds.map(() => '?').join(', ')
    const rows = db.prepare(`
        SELECT session_id, message_epoch, last_seq
        FROM usage_scan_state
        WHERE session_id IN (${placeholders})
    `).all(...sessionIds) as Array<{ session_id: string; message_epoch: number; last_seq: number }>

    return new Map(rows.map((row) => [row.session_id, {
        messageEpoch: row.message_epoch,
        lastSeq: row.last_seq
    }]))
}

export function transferUsageSession(db: Database, fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return

    db.transaction(() => {
        db.prepare(`
            INSERT OR IGNORE INTO usage_events (
                session_id,
                source_key,
                source_seq,
                created_at,
                agent,
                model,
                kind,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                last_input_tokens,
                last_output_tokens,
                last_cache_read_tokens,
                last_cache_creation_tokens
            )
            SELECT
                ?,
                source_key,
                source_seq,
                created_at,
                agent,
                model,
                kind,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                last_input_tokens,
                last_output_tokens,
                last_cache_read_tokens,
                last_cache_creation_tokens
            FROM usage_events
            WHERE session_id = ?
        `).run(toSessionId, fromSessionId)
        db.prepare('DELETE FROM usage_events WHERE session_id = ?').run(fromSessionId)
        db.prepare('DELETE FROM usage_scan_state WHERE session_id IN (?, ?)').run(fromSessionId, toSessionId)
    })()
}
