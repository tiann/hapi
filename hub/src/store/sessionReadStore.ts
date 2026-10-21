import type { Database } from 'bun:sqlite'
import { emptySessionReadState, type SessionReadMutation, type SessionReadState } from '@hapi/protocol'

export class SessionReadStore {
    constructor(private readonly db: Database) {}

    list(namespace: string): SessionReadState[] {
        return this.db.query<SessionReadState, [string]>(`
            SELECT r.session_id AS sessionId, r.last_seen_at AS lastSeenAt,
                   r.manual_unread_at AS manualUnreadAt, r.version
            FROM session_read_states r JOIN sessions s ON s.id = r.session_id
            WHERE s.namespace = ?
        `).all(namespace)
    }

    /** Validate every target before writing; namespace failures roll back the entire batch. */
    update(namespace: string, mutations: SessionReadMutation[]) {
        return this.db.transaction(() => {
            const targets = mutations.map(mutation => {
                const session = this.db.query<{ updated_at: number }, [string, string]>(
                    'SELECT updated_at FROM sessions WHERE id = ? AND namespace = ?'
                ).get(mutation.sessionId, namespace)
                if (!session) throw new Error('session-not-found')
                if (mutation.activityAt > session.updated_at) throw new Error('future-activity')
                return mutation
            })
            const result = new Map<string, SessionReadState>()
            const acceptedSessionIds: string[] = []
            for (const mutation of targets) {
                const stored = this.db.query<SessionReadState & { mutationId: string }, [string]>(`
                    SELECT session_id AS sessionId, last_seen_at AS lastSeenAt,
                           manual_unread_at AS manualUnreadAt, version, last_mutation_id AS mutationId
                    FROM session_read_states WHERE session_id = ?
                `).get(mutation.sessionId)
                const current = stored ? {
                    sessionId: stored.sessionId, lastSeenAt: stored.lastSeenAt,
                    manualUnreadAt: stored.manualUnreadAt, version: stored.version
                } : emptySessionReadState(mutation.sessionId)
                if (stored?.mutationId === mutation.mutationId) {
                    result.set(current.sessionId, current)
                    acceptedSessionIds.push(current.sessionId)
                    continue
                }
                // Compare-and-swap also makes retries after a lost response idempotent.
                if (current.version !== mutation.expectedVersion
                    || (mutation.kind === 'import-unread' && current.version !== 0)) {
                    if (current.version > 0) result.set(current.sessionId, current)
                    continue
                }
                const seen = mutation.kind === 'seen'
                const next: SessionReadState = {
                    sessionId: mutation.sessionId,
                    lastSeenAt: seen
                        ? Math.max(current.lastSeenAt, mutation.activityAt)
                        : Math.min(current.lastSeenAt, Math.max(0, mutation.activityAt - 1)),
                    manualUnreadAt: seen
                        ? (mutation.activityAt >= (current.manualUnreadAt ?? 0) ? null : current.manualUnreadAt)
                        : mutation.activityAt,
                    version: current.version + 1
                }
                this.db.query(`
                    INSERT INTO session_read_states(session_id, last_seen_at, manual_unread_at, version, last_mutation_id)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        last_seen_at = excluded.last_seen_at,
                        manual_unread_at = excluded.manual_unread_at, version = excluded.version,
                        last_mutation_id = excluded.last_mutation_id
                `).run(next.sessionId, next.lastSeenAt, next.manualUnreadAt, next.version, mutation.mutationId)
                result.set(next.sessionId, next)
                acceptedSessionIds.push(next.sessionId)
            }
            return { states: [...result.values()], acceptedSessionIds }
        }).immediate()
    }
}
