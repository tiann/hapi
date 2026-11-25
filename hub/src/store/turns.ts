import type { Database } from 'bun:sqlite'

/** Why a turn stopped: the agent went idle, the session ended, its keepalives
 *  stopped, or the hub restarted while it was open. */
export type SessionTurnEndReason = 'idle' | 'session_end' | 'expired' | 'hub_restart'

/** What started a turn: a prompt sent through the hub, the agent reporting
 *  that it is thinking (e.g. a prompt typed in a local terminal), or a
 *  session patch. */
export type SessionTurnTrigger = 'hub_prompt' | 'agent' | 'patch'

export type SessionTurn = {
    id: number
    sessionId: string
    namespace: string
    startedAt: number
    endedAt: number | null
    endReason: SessionTurnEndReason | null
    trigger: SessionTurnTrigger
}

type SessionTurnRow = {
    id: number
    session_id: string
    namespace: string
    started_at: number
    ended_at: number | null
    end_reason: SessionTurnEndReason | null
    started_by: SessionTurnTrigger
}

function toSessionTurn(row: SessionTurnRow): SessionTurn {
    return {
        id: row.id,
        sessionId: row.session_id,
        namespace: row.namespace,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        endReason: row.end_reason,
        trigger: row.started_by
    }
}

/** Opens a turn unless one is already open for the session. */
export function openSessionTurn(
    db: Database,
    sessionId: string,
    namespace: string,
    startedAt: number,
    trigger: SessionTurnTrigger
): boolean {
    const result = db.prepare(`
        INSERT OR IGNORE INTO session_turns (session_id, namespace, started_at, started_by)
        VALUES (?, ?, ?, ?)
    `).run(sessionId, namespace, startedAt, trigger)
    return result.changes > 0
}

/** Closes the session's open turn, never before it started. */
export function closeSessionTurn(db: Database, sessionId: string, endedAt: number, reason: SessionTurnEndReason): boolean {
    const result = db.prepare(`
        UPDATE session_turns
        SET ended_at = MAX(started_at, ?), end_reason = ?
        WHERE session_id = ? AND ended_at IS NULL
    `).run(endedAt, reason, sessionId)
    return result.changes > 0
}

/**
 * Closes turns left open by a previous hub process. Nobody knows when they
 * really ended, so each ends at its session's newest message, which is the
 * last sign of the agent working that survived the restart. Until
 * `now + recoveryWindowMs` the agent can still continue the turn (see
 * `resumeInterruptedSessionTurn`); that deadline counts from the restart, not
 * from the newest message, which may be long before it.
 *
 * @returns the ids of the sessions whose turns were closed.
 */
export function closeDanglingSessionTurns(db: Database, now: number, recoveryWindowMs: number): string[] {
    const rows = db.prepare(`
        UPDATE session_turns
        SET ended_at = MAX(started_at, MIN(?, COALESCE((
                SELECT MAX(COALESCE(m.invoked_at, m.created_at))
                FROM messages m
                WHERE m.session_id = session_turns.session_id
            ), started_at))),
            end_reason = 'hub_restart',
            recover_until = ?
        WHERE ended_at IS NULL
        RETURNING session_id
    `).all(now, now + recoveryWindowMs) as Array<{ session_id: string }>
    return rows.map((row) => row.session_id)
}

/**
 * Reopens the session's turn a restart interrupted, so the agent carrying on
 * with it doesn't split it in two. Only before its recovery deadline, and
 * only while it is still the session's latest turn.
 */
export function resumeInterruptedSessionTurn(db: Database, sessionId: string, now: number): boolean {
    const result = db.prepare(`
        UPDATE session_turns
        SET ended_at = NULL, end_reason = NULL, recover_until = NULL
        WHERE id = (
                SELECT id FROM session_turns
                WHERE session_id = ?
                ORDER BY started_at DESC, id DESC
                LIMIT 1
            )
            AND recover_until >= ?
    `).run(sessionId, now)
    return result.changes > 0
}

/** The agent was seen idle or got a new prompt: the interrupted turn is over for good. */
export function abandonSessionTurnRecovery(db: Database, sessionId: string): void {
    db.prepare('UPDATE session_turns SET recover_until = NULL WHERE session_id = ? AND recover_until IS NOT NULL').run(sessionId)
}

/** Turns in `namespace` that overlap [since, until), oldest first. */
export function listSessionTurns(db: Database, namespace: string, since: number, until: number): SessionTurn[] {
    const rows = db.prepare(`
        SELECT id, session_id, namespace, started_at, ended_at, end_reason, started_by
        FROM session_turns
        WHERE namespace = ?
          AND started_at < ?
          AND (ended_at IS NULL OR ended_at > ?)
        ORDER BY started_at, id
    `).all(namespace, until, since) as SessionTurnRow[]
    return rows.map(toSessionTurn)
}

/** Moves a merged session's turns to the session that replaces it. */
export function transferSessionTurns(db: Database, fromSessionId: string, toSessionId: string, now: number): void {
    if (fromSessionId === toSessionId) return

    db.transaction(() => {
        // Only one turn per session may be open; the destination's wins.
        db.prepare(`
            UPDATE session_turns
            SET ended_at = MAX(started_at, ?), end_reason = 'session_end'
            WHERE session_id = ? AND ended_at IS NULL
              AND EXISTS (SELECT 1 FROM session_turns WHERE session_id = ? AND ended_at IS NULL)
        `).run(now, fromSessionId, toSessionId)
        db.prepare('UPDATE session_turns SET session_id = ? WHERE session_id = ?').run(toSessionId, fromSessionId)
    })()
}
