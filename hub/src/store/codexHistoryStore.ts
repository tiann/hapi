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

export class CodexHistoryStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addItem(input: AddCodexHistoryItemInput): void {
        const now = Date.now()
        const row = this.db.prepare(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM codex_history_items WHERE session_id = ?'
        ).get(input.sessionId) as { nextSeq: number }

        this.db.prepare(`
            INSERT OR IGNORE INTO codex_history_items (
                id, session_id, codex_thread_id, turn_id, item_id, item_kind, message_seq, raw_item, seq, created_at
            ) VALUES (
                @id, @session_id, @codex_thread_id, @turn_id, @item_id, @item_kind, @message_seq, @raw_item, @seq, @created_at
            )
        `).run({
            id: randomUUID(),
            session_id: input.sessionId,
            codex_thread_id: input.codexThreadId,
            turn_id: input.turnId ?? null,
            item_id: input.itemId,
            item_kind: input.itemKind,
            message_seq: input.messageSeq ?? null,
            raw_item: JSON.stringify(input.rawItem),
            seq: row.nextSeq,
            created_at: now
        })
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
            SELECT raw_item
            FROM codex_history_items
            WHERE session_id = @sessionId
              ${beforeClause}
            ORDER BY seq ASC
        `).all({
            sessionId,
            nextUserSeq: nextUser?.seq ?? null
        }) as Array<{ raw_item: string }>

        return rows.map((row) => safeJsonParse(row.raw_item))
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
            SELECT raw_item
            FROM codex_history_items
            WHERE session_id = ?
              AND seq < ?
            ORDER BY seq ASC
        `).all(sessionId, cut.seq) as Array<{ raw_item: string }>

        return rows.map((row) => safeJsonParse(row.raw_item))
    }
}
