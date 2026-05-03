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
