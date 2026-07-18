import type { Database } from 'bun:sqlite'

type UnreadRow = {
    session_id: string
    unread_count: number
}

export class SessionNotificationStateStore {
    constructor(private readonly db: Database) {}

    incrementUnread(sessionId: string, namespace: string): number {
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO session_notification_state (
                namespace, session_id, unread_count, updated_at
            ) VALUES (
                ?, ?, 1, ?
            )
            ON CONFLICT(namespace, session_id) DO UPDATE SET
                unread_count = unread_count + 1,
                updated_at = excluded.updated_at
        `).run(namespace, sessionId, now)

        return this.getUnreadCount(sessionId, namespace)
    }

    clearUnread(sessionId: string, namespace: string): void {
        this.db.prepare(`
            INSERT INTO session_notification_state (
                namespace, session_id, unread_count, updated_at
            ) VALUES (
                ?, ?, 0, ?
            )
            ON CONFLICT(namespace, session_id) DO UPDATE SET
                unread_count = 0,
                updated_at = excluded.updated_at
        `).run(namespace, sessionId, Date.now())
    }

    getUnreadCount(sessionId: string, namespace: string): number {
        const row = this.db.prepare(`
            SELECT unread_count
            FROM session_notification_state
            WHERE namespace = ? AND session_id = ?
            LIMIT 1
        `).get(namespace, sessionId) as { unread_count: number } | undefined

        return row?.unread_count ?? 0
    }

    getUnreadCountsByNamespace(namespace: string): Map<string, number> {
        const rows = this.db.prepare(`
            SELECT session_id, unread_count
            FROM session_notification_state
            WHERE namespace = ? AND unread_count > 0
        `).all(namespace) as UnreadRow[]

        return new Map(rows.map((row) => [row.session_id, row.unread_count]))
    }

    getTotalUnreadCountByNamespace(namespace: string): number {
        const row = this.db.prepare(`
            SELECT COALESCE(SUM(unread_count), 0) AS total
            FROM session_notification_state
            WHERE namespace = ? AND unread_count > 0
        `).get(namespace) as { total: number } | undefined

        return row?.total ?? 0
    }
}
