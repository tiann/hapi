import type { Database } from 'bun:sqlite'
import { isObject, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol'
import { decodeMessageContent } from './contentCodec'
import { prepareCached } from './statementCache'

export function isUserInputMessage(content: unknown): boolean {
    const message = unwrapRoleWrappedRecordEnvelope(content)
    return message?.role === 'user'
        && !(isObject(message.meta) && message.meta.isTranscriptEcho === true)
}

/** Called in the message insertion transaction, never on delivery ACKs/replays.
 * Agent envelopes (including Claude tool results with an inner user role) are
 * not user input. Keep the original timestamp when importing/copying history. */
export function recordUserMessage(db: Database, sessionId: string, content: unknown, createdAt: number): void {
    if (!isUserInputMessage(content)) return
    prepareCached(db, `
        UPDATE sessions SET last_user_message_at = ?
        WHERE id = ? AND (last_user_message_at IS NULL OR last_user_message_at < ?)
    `).run(createdAt, sessionId, createdAt)
}

/** One-time migration. Message content can be plaintext JSON or compressed;
 * iterate rather than materializing the entire conversation history. */
export function backfillLastUserMessageAt(db: Database): void {
    const latest = new Map<string, number>()
    for (const row of db.prepare('SELECT session_id, content, created_at FROM messages').iterate() as Iterable<{
        session_id: string; content: string | Uint8Array; created_at: number
    }>) {
        if (row.created_at <= (latest.get(row.session_id) ?? -Infinity)) continue
        if (isUserInputMessage(decodeMessageContent(row.content))) {
            latest.set(row.session_id, row.created_at)
        }
    }
    const update = db.prepare('UPDATE sessions SET last_user_message_at = ? WHERE id = ?')
    for (const [id, at] of latest) update.run(at, id)
}
