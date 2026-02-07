import type { Database } from 'bun:sqlite'

type DraftRow = {
    session_id: string
    namespace: string
    draft_text: string
    draft_timestamp: number
}

export type DraftData = {
    text: string
    timestamp: number
}

/**
 * Get draft for a session
 */
export function getDraft(db: Database, sessionId: string, namespace: string): DraftData | null {
    const row = db.prepare(`
        SELECT draft_text, draft_timestamp
        FROM session_drafts
        WHERE session_id = ? AND namespace = ?
    `).get(sessionId, namespace) as Pick<DraftRow, 'draft_text' | 'draft_timestamp'> | undefined

    if (!row) return null

    return {
        text: row.draft_text,
        timestamp: row.draft_timestamp
    }
}

/**
 * Save draft for a session using Last-Write-Wins (LWW) strategy.
 * Returns the actual draft stored (may differ from request if LWW rejected the update).
 */
export function setDraft(
    db: Database,
    sessionId: string,
    namespace: string,
    text: string,
    timestamp: number
): DraftData {
    // Last-Write-Wins logic: Check if existing draft is newer
    const existing = getDraft(db, sessionId, namespace)
    if (existing && existing.timestamp > timestamp) {
        // Reject older update, return current draft
        console.log('[Drafts] Rejected older draft update', {
            sessionId,
            incoming: timestamp,
            existing: existing.timestamp
        })
        return existing
    }

    // Accept newer update
    db.prepare(`
        INSERT OR REPLACE INTO session_drafts (session_id, namespace, draft_text, draft_timestamp)
        VALUES (?, ?, ?, ?)
    `).run(sessionId, namespace, text, timestamp)

    console.log('[Drafts] Saved draft', { sessionId, timestamp, length: text.length })

    return { text, timestamp }
}

/**
 * Clear draft for a session
 */
export function clearDraft(db: Database, sessionId: string, namespace: string): void {
    db.prepare(`
        DELETE FROM session_drafts
        WHERE session_id = ? AND namespace = ?
    `).run(sessionId, namespace)

    console.log('[Drafts] Cleared draft', { sessionId })
}
