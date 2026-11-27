import { randomUUID } from 'node:crypto'
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type {
    SessionTask,
    SessionTaskErrorCode,
    SessionTaskKind,
    SessionTaskState
} from '@hapi/protocol'
import { prepareCached } from './statementCache'

/**
 * Hub-owned schedules that send prompts into a session unattended:
 * `repeat` (the same prompt on a fixed interval) and `queue` (a list of
 * prompts, each sent `interval_ms` after the agent took the previous one).
 *
 * A task never pre-creates future message rows. When a run is due the
 * scheduler inserts one ordinary user message and records its localId in
 * `pending_local_id`; the task's next step is computed only after the CLI
 * acknowledges taking that message, so a task has at most one prompt
 * outstanding and nothing is sent twice across a hub restart.
 */

export type StoredSessionTask = {
    id: string
    sessionId: string
    kind: SessionTaskKind
    state: SessionTaskState
    /** `repeat`: one entry. `queue`: the prompts in sending order. */
    items: string[]
    intervalMs: number
    /** `repeat`: stop after this many sends. `queue`: null. */
    maxRuns: number | null
    /** Prompts inserted so far. For a `queue` task also the index of the next prompt. */
    runCount: number
    nextRunAt: number | null
    /** localId of the prompt this task inserted and the CLI has not acknowledged. */
    pendingLocalId: string | null
    /** When the task was meant to run first. Resuming a task that has not run yet keeps it. */
    startAt: number
    lastRunAt: number | null
    lastConsumedAt: number | null
    lastError: SessionTaskErrorCode | null
    createdAt: number
    updatedAt: number
}

type DbTaskRow = {
    id: string
    session_id: string
    kind: string
    state: string
    items: string
    interval_ms: number
    max_runs: number | null
    run_count: number
    next_run_at: number | null
    pending_local_id: string | null
    last_run_at: number | null
    last_consumed_at: number | null
    last_error: string | null
    start_at: number
    created_at: number
    updated_at: number
}

const TASK_COLUMNS = `id, session_id, kind, state, items, interval_ms, max_runs, run_count, next_run_at, pending_local_id, last_run_at, last_consumed_at, last_error, start_at, created_at, updated_at`

/**
 * v37 created the table without `start_at`; the v37→v38 step adds the column
 * to such databases (see Store.migrateFromV37ToV38). A fresh database gets
 * the final shape here.
 */
export const SESSION_TASKS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS session_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        items TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        max_runs INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER,
        pending_local_id TEXT,
        last_run_at INTEGER,
        last_consumed_at INTEGER,
        last_error TEXT,
        start_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_tasks_session
        ON session_tasks(session_id, created_at ASC);
    -- The 5s scheduler tick reads the two partial indexes below (one query
    -- each, see findRunnable) instead of walking every task.
    CREATE INDEX IF NOT EXISTS idx_session_tasks_active_due
        ON session_tasks(next_run_at)
        WHERE state = 'active' AND next_run_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_session_tasks_pending
        ON session_tasks(pending_local_id)
        WHERE pending_local_id IS NOT NULL;
`

function parseItems(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item): item is string => typeof item === 'string')
    } catch {
        return []
    }
}

function toStored(row: DbTaskRow): StoredSessionTask {
    return {
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind as SessionTaskKind,
        state: row.state as SessionTaskState,
        items: parseItems(row.items),
        intervalMs: row.interval_ms,
        maxRuns: row.max_runs,
        runCount: row.run_count,
        nextRunAt: row.next_run_at,
        pendingLocalId: row.pending_local_id,
        startAt: row.start_at,
        lastRunAt: row.last_run_at,
        lastConsumedAt: row.last_consumed_at,
        lastError: row.last_error as SessionTaskErrorCode | null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

/** Wire projection. Omits the scheduler's bookkeeping (`pendingLocalId`, `lastConsumedAt`). */
export function toSessionTask(task: StoredSessionTask): SessionTask {
    return {
        id: task.id,
        sessionId: task.sessionId,
        kind: task.kind,
        state: task.state,
        items: task.items.map((text) => ({ text })),
        intervalMs: task.intervalMs,
        maxRuns: task.maxRuns,
        runCount: task.runCount,
        totalRuns: task.kind === 'queue' ? task.items.length : task.maxRuns,
        nextRunAt: task.nextRunAt,
        pending: task.pendingLocalId !== null,
        startAt: task.startAt,
        lastRunAt: task.lastRunAt,
        lastError: task.lastError,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
    }
}

export class SessionTaskStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    list(sessionId: string): StoredSessionTask[] {
        const rows = prepareCached(this.db,
            `SELECT ${TASK_COLUMNS} FROM session_tasks WHERE session_id = ? ORDER BY created_at ASC, id ASC`
        ).all(sessionId) as DbTaskRow[]
        return rows.map(toStored)
    }

    /** Scoped read: a task id only resolves inside its own session. */
    get(sessionId: string, taskId: string): StoredSessionTask | null {
        const row = prepareCached(this.db,
            `SELECT ${TASK_COLUMNS} FROM session_tasks WHERE session_id = ? AND id = ?`
        ).get(sessionId, taskId) as DbTaskRow | undefined
        return row ? toStored(row) : null
    }

    getById(taskId: string): StoredSessionTask | null {
        const row = prepareCached(this.db,
            `SELECT ${TASK_COLUMNS} FROM session_tasks WHERE id = ?`
        ).get(taskId) as DbTaskRow | undefined
        return row ? toStored(row) : null
    }

    /** Active (not paused) tasks of a session; the create cap is checked against this. */
    countActive(sessionId: string): number {
        const row = prepareCached(this.db,
            `SELECT COUNT(*) AS count FROM session_tasks WHERE session_id = ? AND state = 'active'`
        ).get(sessionId) as { count: number }
        return row.count
    }

    /**
     * Tasks the scheduler must look at on a tick: one whose prompt is still
     * waiting to be taken, or an active task whose next run is due. Each half
     * is one query over its partial index (a single OR would scan the whole
     * table); the merge is ordered by next run (a task with nothing scheduled
     * sorts last), then by age and id, so the order never depends on SQLite.
     */
    findRunnable(now: number): StoredSessionTask[] {
        const pending = prepareCached(this.db,
            `SELECT ${TASK_COLUMNS} FROM session_tasks
             WHERE pending_local_id IS NOT NULL`
        ).all() as DbTaskRow[]
        const due = prepareCached(this.db,
            `SELECT ${TASK_COLUMNS} FROM session_tasks
             WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?`
        ).all(now) as DbTaskRow[]
        const seen = new Set<string>()
        const merged: StoredSessionTask[] = []
        // A task with a prompt pending that is also due is in both halves: keep the pending row.
        for (const row of [...pending, ...due]) {
            if (seen.has(row.id)) continue
            seen.add(row.id)
            merged.push(toStored(row))
        }
        return merged.sort((a, b) => {
            const aAt = a.nextRunAt ?? Number.MAX_SAFE_INTEGER
            const bAt = b.nextRunAt ?? Number.MAX_SAFE_INTEGER
            return (aAt - bAt) || (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        })
    }

    create(input: {
        sessionId: string
        kind: SessionTaskKind
        items: string[]
        intervalMs: number
        maxRuns: number | null
        startAt: number
        nextRunAt: number
        now?: number
    }): StoredSessionTask {
        if (input.items.length === 0) {
            throw new Error('createSessionTask: items must not be empty')
        }
        const now = input.now ?? Date.now()
        const id = randomUUID()
        prepareCached(this.db,
            `INSERT INTO session_tasks
                (id, session_id, kind, state, items, interval_ms, max_runs, run_count,
                 next_run_at, pending_local_id, last_run_at, last_consumed_at, last_error, start_at, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
        ).run(
            id,
            input.sessionId,
            input.kind,
            JSON.stringify(input.items),
            input.intervalMs,
            input.maxRuns,
            input.nextRunAt,
            input.startAt,
            now,
            now
        )
        const created = this.getById(id)
        if (!created) throw new Error('createSessionTask: row missing after insert')
        return created
    }

    /**
     * Apply an edit. `state` carries the pause or resume (the caller computes
     * the next run); the other fields replace what is stored.
     */
    update(taskId: string, changes: {
        items?: string[]
        intervalMs?: number
        maxRuns?: number | null
        state?: { paused: boolean; nextRunAt: number | null }
    }, now: number): StoredSessionTask | null {
        const sets: string[] = ['updated_at = ?']
        const values: SQLQueryBindings[] = [now]
        if (changes.items !== undefined) {
            sets.push('items = ?')
            values.push(JSON.stringify(changes.items))
        }
        if (changes.intervalMs !== undefined) {
            sets.push('interval_ms = ?')
            values.push(changes.intervalMs)
        }
        if (changes.maxRuns !== undefined) {
            sets.push('max_runs = ?')
            values.push(changes.maxRuns)
        }
        if (changes.state !== undefined) {
            sets.push('state = ?', 'next_run_at = ?', 'last_error = NULL')
            values.push(changes.state.paused ? 'paused' : 'active', changes.state.nextRunAt)
        }
        values.push(taskId)
        prepareCached(this.db, `UPDATE session_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
        return this.getById(taskId)
    }

    /**
     * Record that the task's next prompt was inserted. Compare-and-set on
     * `pending_local_id IS NULL`, so two overlapping runs cannot both count a
     * send. `nextRunAt` is ignored while the task is paused.
     */
    markSent(taskId: string, params: { localId: string; nextRunAt: number | null; now: number }): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_tasks
             SET pending_local_id = ?,
                 run_count = run_count + 1,
                 last_run_at = ?,
                 next_run_at = CASE WHEN state = 'active' THEN ? ELSE NULL END,
                 last_error = NULL,
                 updated_at = ?
             WHERE id = ? AND pending_local_id IS NULL`
        ).run(params.localId, params.now, params.nextRunAt, params.now, taskId)
        return result.changes > 0
    }

    /**
     * The CLI took (or the user cancelled) the pending prompt. `nextRunAt`
     * replaces the stored next run; leave it undefined to keep the current
     * one (a `repeat` task stays on its grid).
     */
    settlePending(taskId: string, params: { consumedAt: number; nextRunAt?: number | null; now: number }): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_tasks
             SET pending_local_id = NULL,
                 last_consumed_at = ?,
                 next_run_at = COALESCE(?, next_run_at),
                 last_error = NULL,
                 updated_at = ?
             WHERE id = ? AND pending_local_id IS NOT NULL`
        ).run(params.consumedAt, params.nextRunAt ?? null, params.now, taskId)
        return result.changes > 0
    }

    /**
     * A `repeat` task was due while its previous prompt is still waiting to
     * be taken. Move to the next slot on its grid instead of stacking a
     * second prompt on a busy agent.
     */
    skipDueSlot(taskId: string, nextRunAt: number, now: number): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_tasks
             SET next_run_at = ?, updated_at = ?
             WHERE id = ? AND pending_local_id IS NOT NULL AND state = 'active'`
        ).run(nextRunAt, now, taskId)
        return result.changes > 0
    }

    /** True when the stored error changed (callers use it to avoid redundant events). */
    setError(taskId: string, error: SessionTaskErrorCode | null, now: number): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_tasks SET last_error = ?, updated_at = ? WHERE id = ? AND last_error IS NOT ?`
        ).run(error, now, taskId, error)
        return result.changes > 0
    }

    delete(taskId: string): boolean {
        const result = prepareCached(this.db, `DELETE FROM session_tasks WHERE id = ?`).run(taskId)
        return result.changes > 0
    }

    /** A merged-away session's tasks follow it to the surviving row. */
    transfer(fromSessionId: string, toSessionId: string): number {
        const result = prepareCached(this.db,
            `UPDATE session_tasks SET session_id = ? WHERE session_id = ?`
        ).run(toSessionId, fromSessionId)
        return result.changes
    }
}
