import { randomUUID } from 'node:crypto'
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import {
    SESSION_TASK_RUN_PREVIEW_LENGTH,
    type SessionTask,
    type SessionTaskErrorCode,
    type SessionTaskKind,
    type SessionTaskRun,
    type SessionTaskRunOutcome,
    type SessionTaskState
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
 *
 * `session_task_runs` is the history of what the tasks did (sent, skipped,
 * failed, cancelled). A run outlives its task: finished tasks delete
 * themselves, their runs stay until the retention below drops them.
 */

/** Run-history rows kept per session; the oldest go first when a new one exceeds this. */
export const SESSION_TASK_RUNS_MAX_PER_SESSION = 500
/** Run-history rows older than this are deleted (the scheduler checks at most once an hour). */
export const SESSION_TASK_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Active tasks of one session, for the session-list summary. */
export type SessionTaskSummary = {
    activeTaskCount: number
    nextTaskRunAt: number | null
}

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

export type StoredSessionTaskRun = {
    id: string
    sessionId: string
    taskId: string
    taskKind: SessionTaskKind
    /** 1-based number of the prompt, or null when no prompt was sent. */
    runNumber: number | null
    localId: string | null
    outcome: SessionTaskRunOutcome
    scheduledFor: number | null
    recordedAt: number
    /** For `sent`: when the agent took the prompt, or null while it is still waiting. */
    takenAt: number | null
    detail: string | null
    preview: string | null
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

type DbRunRow = {
    id: string
    session_id: string
    task_id: string
    task_kind: string
    run_number: number | null
    local_id: string | null
    outcome: string
    scheduled_for: number | null
    recorded_at: number
    taken_at: number | null
    detail: string | null
    preview: string | null
}

const TASK_COLUMNS = `id, session_id, kind, state, items, interval_ms, max_runs, run_count, next_run_at, pending_local_id, last_run_at, last_consumed_at, last_error, start_at, created_at, updated_at`
const RUN_COLUMNS = `id, session_id, task_id, task_kind, run_number, local_id, outcome, scheduled_for, recorded_at, taken_at, detail, preview`

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

export const SESSION_TASK_RUNS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS session_task_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        run_number INTEGER,
        local_id TEXT,
        outcome TEXT NOT NULL,
        scheduled_for INTEGER,
        recorded_at INTEGER NOT NULL,
        taken_at INTEGER,
        detail TEXT,
        preview TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_task_runs_session
        ON session_task_runs(session_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_task_runs_recorded
        ON session_task_runs(recorded_at);
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

function toStoredRun(row: DbRunRow): StoredSessionTaskRun {
    return {
        id: row.id,
        sessionId: row.session_id,
        taskId: row.task_id,
        taskKind: row.task_kind as SessionTaskKind,
        runNumber: row.run_number,
        localId: row.local_id,
        outcome: row.outcome as SessionTaskRunOutcome,
        scheduledFor: row.scheduled_for,
        recordedAt: row.recorded_at,
        takenAt: row.taken_at,
        detail: row.detail,
        preview: row.preview
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

export function toSessionTaskRun(run: StoredSessionTaskRun): SessionTaskRun {
    return {
        id: run.id,
        sessionId: run.sessionId,
        taskId: run.taskId,
        taskKind: run.taskKind,
        runNumber: run.runNumber,
        outcome: run.outcome,
        scheduledFor: run.scheduledFor,
        recordedAt: run.recordedAt,
        takenAt: run.takenAt,
        detail: run.detail,
        preview: run.preview
    }
}

/** The start of a prompt, as a run-history row carries it. */
export function sessionTaskRunPreview(text: string): string {
    return Array.from(text).slice(0, SESSION_TASK_RUN_PREVIEW_LENGTH).join('')
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

    /** Active tasks and their earliest next run, per session (sessions without active tasks are absent). */
    summarizeActiveBySessionIds(sessionIds: string[]): Map<string, SessionTaskSummary> {
        const summaries = new Map<string, SessionTaskSummary>()
        if (sessionIds.length === 0) return summaries
        const placeholders = sessionIds.map(() => '?').join(',')
        const rows = prepareCached(this.db,
            `SELECT session_id, COUNT(*) AS active_task_count, MIN(next_run_at) AS next_task_run_at
             FROM session_tasks
             WHERE state = 'active' AND session_id IN (${placeholders})
             GROUP BY session_id`
        ).all(...sessionIds) as Array<{ session_id: string; active_task_count: number; next_task_run_at: number | null }>
        for (const row of rows) {
            summaries.set(row.session_id, {
                activeTaskCount: row.active_task_count,
                nextTaskRunAt: row.next_task_run_at
            })
        }
        return summaries
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

    /** A merged-away session's tasks and runs follow it to the surviving row. */
    transfer(fromSessionId: string, toSessionId: string): number {
        const result = prepareCached(this.db,
            `UPDATE session_tasks SET session_id = ? WHERE session_id = ?`
        ).run(toSessionId, fromSessionId)
        prepareCached(this.db, `UPDATE session_task_runs SET session_id = ? WHERE session_id = ?`)
            .run(toSessionId, fromSessionId)
        return result.changes
    }

    // ---- Run history -------------------------------------------------------------

    /** Write one line of history, then keep the session within the per-session cap. */
    recordRun(input: {
        sessionId: string
        taskId: string
        taskKind: SessionTaskKind
        runNumber: number | null
        localId?: string | null
        outcome: SessionTaskRunOutcome
        scheduledFor: number | null
        detail?: string | null
        preview?: string | null
    }, now: number): StoredSessionTaskRun {
        const id = randomUUID()
        prepareCached(this.db,
            `INSERT INTO session_task_runs
                (id, session_id, task_id, task_kind, run_number, local_id, outcome, scheduled_for, recorded_at, taken_at, detail, preview)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        ).run(
            id,
            input.sessionId,
            input.taskId,
            input.taskKind,
            input.runNumber,
            input.localId ?? null,
            input.outcome,
            input.scheduledFor,
            now,
            input.detail ?? null,
            input.preview ?? null
        )
        prepareCached(this.db,
            `DELETE FROM session_task_runs
             WHERE session_id = ? AND id NOT IN (
                 SELECT id FROM session_task_runs WHERE session_id = ?
                 ORDER BY recorded_at DESC, rowid DESC LIMIT ${SESSION_TASK_RUNS_MAX_PER_SESSION}
             )`
        ).run(input.sessionId, input.sessionId)
        const row = prepareCached(this.db, `SELECT ${RUN_COLUMNS} FROM session_task_runs WHERE id = ?`)
            .get(id) as DbRunRow | undefined
        if (!row) throw new Error('recordRun: row missing after insert')
        return toStoredRun(row)
    }

    /** The agent took a prompt the task sent: stamp when. */
    markRunTaken(sessionId: string, localId: string, takenAt: number): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_task_runs SET taken_at = ?
             WHERE session_id = ? AND local_id = ? AND outcome = 'sent' AND taken_at IS NULL`
        ).run(takenAt, sessionId, localId)
        return result.changes > 0
    }

    /** A prompt the task sent was cancelled before the agent took it. */
    markRunCancelled(sessionId: string, localId: string): boolean {
        const result = prepareCached(this.db,
            `UPDATE session_task_runs SET outcome = 'cancelled'
             WHERE session_id = ? AND local_id = ? AND outcome = 'sent' AND taken_at IS NULL`
        ).run(sessionId, localId)
        return result.changes > 0
    }

    /** Newest first. */
    listRuns(sessionId: string, limit: number): StoredSessionTaskRun[] {
        const rows = prepareCached(this.db,
            `SELECT ${RUN_COLUMNS} FROM session_task_runs WHERE session_id = ?
             ORDER BY recorded_at DESC, rowid DESC LIMIT ?`
        ).all(sessionId, limit) as DbRunRow[]
        return rows.map(toStoredRun)
    }

    /** Drop history older than `olderThan`; returns the number of rows deleted. */
    pruneRuns(olderThan: number): number {
        const result = prepareCached(this.db, `DELETE FROM session_task_runs WHERE recorded_at < ?`).run(olderThan)
        return result.changes
    }
}
