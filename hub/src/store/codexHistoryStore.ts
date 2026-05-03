import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { safeJsonParse } from './json'

export type CodexHistoryItemKind = 'user' | 'assistant' | 'tool' | 'event' | 'unknown'

export type AddCodexHistoryItemInput = {
    sessionId: string
    codexThreadId: string
    turnId?: string | null
    itemId: string
    itemKind: CodexHistoryItemKind
    messageSeq?: number | null
    rawItem: unknown
}

type CodexHistoryRow = {
    codex_thread_id: string
    turn_id: string | null
    item_id: string
    item_kind: CodexHistoryItemKind
    message_seq: number | null
    raw_item: string
    seq: number
    created_at: number
}

export class CodexHistoryStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addItem(input: AddCodexHistoryItemInput): void {
        // Compute seq atomically inside the INSERT so two concurrent addItem calls cannot read the
        // same MAX(seq) and produce duplicate seq values for one session.
        const result = this.db.prepare(`
            INSERT OR IGNORE INTO codex_history_items (
                id, session_id, codex_thread_id, turn_id, item_id, item_kind, message_seq, raw_item, seq, created_at
            )
            SELECT
                @id, @session_id, @codex_thread_id, @turn_id, @item_id, @item_kind, @message_seq, @raw_item,
                COALESCE((SELECT MAX(seq) FROM codex_history_items WHERE session_id = @session_id), 0) + 1,
                @created_at
        `).run({
            id: randomUUID(),
            session_id: input.sessionId,
            codex_thread_id: input.codexThreadId,
            turn_id: input.turnId ?? null,
            item_id: input.itemId,
            item_kind: input.itemKind,
            message_seq: input.messageSeq ?? null,
            raw_item: JSON.stringify(input.rawItem),
            created_at: Date.now()
        })
        if (result.changes === 0) {
            // INSERT OR IGNORE swallowed the row — most likely a duplicate (session_id, item_id),
            // but any constraint failure lands here. Log enough to disambiguate during a later post-mortem.
            console.warn(`[CodexHistoryStore] addItem inserted 0 rows sessionId=${input.sessionId} itemId=${input.itemId} (duplicate or constraint violation)`)
        }
    }

    getPrefixThroughReplyForUserMessageSeq(sessionId: string, messageSeq: number): unknown[] | null {
        const cut = this.db.prepare(`
            SELECT seq
            FROM codex_history_items
            WHERE session_id = ?
              AND message_seq = ?
              AND item_kind = 'user'
            ORDER BY seq ASC
            LIMIT 1
        `).get(sessionId, messageSeq) as { seq: number } | undefined

        if (!cut) {
            return null
        }

        const nextUser = this.db.prepare(`
            SELECT seq
            FROM codex_history_items
            WHERE session_id = ?
              AND item_kind = 'user'
              AND seq > ?
            ORDER BY seq ASC
            LIMIT 1
        `).get(sessionId, cut.seq) as { seq: number } | undefined

        const beforeClause = nextUser ? 'AND seq < @nextUserSeq' : ''
        const rows = this.db.prepare(`
            SELECT seq, raw_item
            FROM codex_history_items
            WHERE session_id = @sessionId
              ${beforeClause}
            ORDER BY seq ASC
        `).all({
            sessionId,
            nextUserSeq: nextUser?.seq ?? null
        }) as Array<{ seq: number; raw_item: string }>

        return parsePrefixRows(rows, sessionId)
    }

    getPrefixBeforeMessageSeq(sessionId: string, beforeSeq: number): unknown[] | null {
        const cut = this.db.prepare(`
            SELECT seq
            FROM codex_history_items
            WHERE session_id = ?
              AND message_seq = ?
              AND item_kind = 'user'
            ORDER BY seq ASC
            LIMIT 1
        `).get(sessionId, beforeSeq) as { seq: number } | undefined

        if (!cut) {
            return null
        }

        const rows = this.db.prepare(`
            SELECT seq, raw_item
            FROM codex_history_items
            WHERE session_id = ?
              AND seq < ?
            ORDER BY seq ASC
        `).all(sessionId, cut.seq) as Array<{ seq: number; raw_item: string }>

        return parsePrefixRows(rows, sessionId)
    }

    cloneSessionHistory(fromSessionId: string, toSessionId: string, messageSeqOffset: number): number {
        const rows = this.db.prepare(`
            SELECT codex_thread_id, turn_id, item_id, item_kind, message_seq, raw_item, seq, created_at
            FROM codex_history_items
            WHERE session_id = ?
            ORDER BY seq ASC
        `).all(fromSessionId) as CodexHistoryRow[]

        return this.cloneRows(toSessionId, rows, messageSeqOffset)
    }

    clonePrefixThroughReplyForUserMessageSeq(
        fromSessionId: string,
        toSessionId: string,
        messageSeq: number,
        messageSeqOffset: number
    ): number {
        const cut = this.db.prepare(`
            SELECT seq
            FROM codex_history_items
            WHERE session_id = ?
              AND message_seq = ?
              AND item_kind = 'user'
            ORDER BY seq ASC
            LIMIT 1
        `).get(fromSessionId, messageSeq) as { seq: number } | undefined

        if (!cut) return 0

        const nextUser = this.db.prepare(`
            SELECT seq
            FROM codex_history_items
            WHERE session_id = ?
              AND item_kind = 'user'
              AND seq > ?
            ORDER BY seq ASC
            LIMIT 1
        `).get(fromSessionId, cut.seq) as { seq: number } | undefined

        const beforeClause = nextUser ? 'AND seq < @nextUserSeq' : ''
        const rows = this.db.prepare(`
            SELECT codex_thread_id, turn_id, item_id, item_kind, message_seq, raw_item, seq, created_at
            FROM codex_history_items
            WHERE session_id = @fromSessionId
              ${beforeClause}
            ORDER BY seq ASC
        `).all({
            fromSessionId,
            nextUserSeq: nextUser?.seq ?? null
        }) as CodexHistoryRow[]

        return this.cloneRows(toSessionId, rows, messageSeqOffset)
    }

    moveSessionHistory(fromSessionId: string, toSessionId: string, targetMessageSeqOffset: number): number {
        if (fromSessionId === toSessionId) return 0

        const sourceMaxSeq = (this.db.prepare(
            'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM codex_history_items WHERE session_id = ?'
        ).get(fromSessionId) as { maxSeq: number } | undefined)?.maxSeq ?? 0

        try {
            this.db.exec('BEGIN')

            if (sourceMaxSeq > 0) {
                this.db.prepare(`
                    UPDATE codex_history_items
                    SET seq = seq + ?,
                        message_seq = CASE
                            WHEN message_seq IS NULL THEN NULL
                            ELSE message_seq + ?
                        END
                    WHERE session_id = ?
                `).run(sourceMaxSeq, targetMessageSeqOffset, toSessionId)
            }

            const result = this.db.prepare(`
                UPDATE OR IGNORE codex_history_items
                SET session_id = ?
                WHERE session_id = ?
            `).run(toSessionId, fromSessionId)

            this.db.exec('COMMIT')
            return result.changes
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    private cloneRows(toSessionId: string, rows: CodexHistoryRow[], messageSeqOffset: number): number {
        if (rows.length === 0) return 0

        const targetMaxSeq = (this.db.prepare(
            'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM codex_history_items WHERE session_id = ?'
        ).get(toSessionId) as { maxSeq: number } | undefined)?.maxSeq ?? 0

        const insert = this.db.prepare(`
            INSERT OR IGNORE INTO codex_history_items (
                id, session_id, codex_thread_id, turn_id, item_id, item_kind, message_seq, raw_item, seq, created_at
            ) VALUES (
                @id, @session_id, @codex_thread_id, @turn_id, @item_id, @item_kind, @message_seq, @raw_item, @seq, @created_at
            )
        `)

        let cloned = 0
        for (const row of rows) {
            const result = insert.run({
                id: randomUUID(),
                session_id: toSessionId,
                codex_thread_id: row.codex_thread_id,
                turn_id: row.turn_id,
                item_id: row.item_id,
                item_kind: row.item_kind,
                message_seq: row.message_seq == null ? null : row.message_seq + messageSeqOffset,
                raw_item: row.raw_item,
                seq: targetMaxSeq + row.seq,
                created_at: row.created_at
            })
            cloned += result.changes
        }

        return cloned
    }
}

// Throw on unparseable rows — forwarding null into thread/resume(history) would corrupt the prefix.
function parsePrefixRows(rows: Array<{ seq: number; raw_item: string }>, sessionId: string): unknown[] {
    const items: unknown[] = []
    for (const row of rows) {
        const parsed = safeJsonParse(row.raw_item)
        if (parsed === null) {
            const message = `[CodexHistoryStore] Corrupt history row sessionId=${sessionId} seq=${row.seq}`
            console.error(message)
            throw new Error(message)
        }
        items.push(parsed)
    }
    return items
}
