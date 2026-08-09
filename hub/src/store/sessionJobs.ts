import type { Database } from 'bun:sqlite'
import type { AttachedJob, AttachedJobPatch, AttachedJobStatus, AttachedJobUpsert } from '@hapi/protocol'

import type { StoredSessionJob } from './types'

/**
 * Per-session attached jobs (tiann/hapi#1404).
 *
 * Registration-first long-running work that outlives the agent process.
 * Hub is source of truth; list chrome reads the primary `running` job.
 */

type DbJobRow = {
    session_id: string
    job_key: string
    label: string
    status: string
    done: number | null
    total: number | null
    remaining: number | null
    unit: string | null
    detail: string | null
    heartbeat_at: number
    started_at: number
    updated_at: number
}

const JOB_COLUMNS = `session_id, job_key, label, status, done, total, remaining, unit, detail, heartbeat_at, started_at, updated_at`

function toStored(row: DbJobRow): StoredSessionJob {
    return {
        sessionId: row.session_id,
        key: row.job_key,
        label: row.label,
        status: row.status as AttachedJobStatus,
        done: row.done ?? undefined,
        total: row.total ?? undefined,
        remaining: row.remaining ?? undefined,
        unit: row.unit ?? undefined,
        detail: row.detail ?? undefined,
        heartbeatAt: row.heartbeat_at,
        startedAt: row.started_at,
        updatedAt: row.updated_at
    }
}

export function toAttachedJob(job: StoredSessionJob): AttachedJob {
    return {
        key: job.key,
        label: job.label,
        status: job.status,
        ...(job.done !== undefined ? { done: job.done } : {}),
        ...(job.total !== undefined ? { total: job.total } : {}),
        ...(job.remaining !== undefined ? { remaining: job.remaining } : {}),
        ...(job.unit !== undefined ? { unit: job.unit } : {}),
        ...(job.detail !== undefined ? { detail: job.detail } : {}),
        heartbeatAt: job.heartbeatAt,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt
    }
}

export function listSessionJobs(db: Database, sessionId: string): StoredSessionJob[] {
    const rows = db.prepare(
        `SELECT ${JOB_COLUMNS}
         FROM session_jobs
         WHERE session_id = ?
         ORDER BY updated_at DESC, job_key ASC`
    ).all(sessionId) as DbJobRow[]
    return rows.map(toStored)
}

export function getSessionJob(
    db: Database,
    sessionId: string,
    jobKey: string
): StoredSessionJob | null {
    const row = db.prepare(
        `SELECT ${JOB_COLUMNS}
         FROM session_jobs
         WHERE session_id = ? AND job_key = ?`
    ).get(sessionId, jobKey) as DbJobRow | undefined
    return row ? toStored(row) : null
}

/** Earliest-started `running` job for a session, or null (stable list chrome). */
export function getPrimaryRunningJob(db: Database, sessionId: string): StoredSessionJob | null {
    const row = db.prepare(
        `SELECT ${JOB_COLUMNS}
         FROM session_jobs
         WHERE session_id = ? AND status = 'running'
         ORDER BY started_at ASC, job_key ASC
         LIMIT 1`
    ).get(sessionId) as DbJobRow | undefined
    return row ? toStored(row) : null
}

/**
 * Batch primary running jobs for session list enrichment.
 * Returns Map sessionId → AttachedJob.
 */
export function getPrimaryRunningJobsBySessionIds(
    db: Database,
    sessionIds: string[]
): Map<string, AttachedJob> {
    const result = new Map<string, AttachedJob>()
    if (sessionIds.length === 0) return result

    const placeholders = sessionIds.map(() => '?').join(', ')
    const rows = db.prepare(
        `SELECT ${JOB_COLUMNS}
         FROM session_jobs
         WHERE status = 'running' AND session_id IN (${placeholders})
         ORDER BY started_at ASC, job_key ASC`
    ).all(...sessionIds) as DbJobRow[]

    for (const row of rows) {
        // First row per session wins — earliest started_at (stable primary).
        if (result.has(row.session_id)) continue
        result.set(row.session_id, toAttachedJob(toStored(row)))
    }
    return result
}

export type UpsertSessionJobResult =
    | { outcome: 'upserted'; job: StoredSessionJob }
    | { outcome: 'session-not-found' }

export function upsertSessionJob(
    db: Database,
    sessionId: string,
    jobKey: string,
    body: AttachedJobUpsert,
    now: number = Date.now()
): UpsertSessionJobResult {
    const existing = getSessionJob(db, sessionId, jobKey)
    const heartbeatAt = body.heartbeatAt ?? now
    // Explicit startedAt wins (late-attach correction). Omitted → keep existing clock,
    // else stamp now. PATCH never accepts startedAt — use PUT or clear+PUT.
    const startedAt = body.startedAt !== undefined
        ? body.startedAt
        : (existing?.startedAt ?? now)
    const status = body.status ?? 'running'

    try {
        db.prepare(
            `INSERT INTO session_jobs (
                session_id, job_key, label, status, done, total, remaining, unit, detail,
                heartbeat_at, started_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, job_key) DO UPDATE SET
                label = excluded.label,
                status = excluded.status,
                done = excluded.done,
                total = excluded.total,
                remaining = excluded.remaining,
                unit = excluded.unit,
                detail = excluded.detail,
                heartbeat_at = excluded.heartbeat_at,
                started_at = excluded.started_at,
                updated_at = excluded.updated_at`
        ).run(
            sessionId,
            jobKey,
            body.label,
            status,
            body.done ?? null,
            body.total ?? null,
            body.remaining ?? null,
            body.unit ?? null,
            body.detail ?? null,
            heartbeatAt,
            startedAt,
            now
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('FOREIGN KEY') || message.includes('foreign key')) {
            return { outcome: 'session-not-found' }
        }
        throw error
    }

    const job = getSessionJob(db, sessionId, jobKey)
    if (!job) {
        return { outcome: 'session-not-found' }
    }
    return { outcome: 'upserted', job }
}

export function patchSessionJob(
    db: Database,
    sessionId: string,
    jobKey: string,
    patch: AttachedJobPatch,
    now: number = Date.now()
): StoredSessionJob | null {
    const existing = getSessionJob(db, sessionId, jobKey)
    if (!existing) return null

    const next: StoredSessionJob = {
        ...existing,
        label: patch.label ?? existing.label,
        status: patch.status ?? existing.status,
        done: patch.done === null ? undefined : (patch.done ?? existing.done),
        total: patch.total === null ? undefined : (patch.total ?? existing.total),
        remaining: patch.remaining === null ? undefined : (patch.remaining ?? existing.remaining),
        unit: patch.unit === null ? undefined : (patch.unit ?? existing.unit),
        detail: patch.detail === null ? undefined : (patch.detail ?? existing.detail),
        heartbeatAt: patch.heartbeatAt ?? now,
        updatedAt: now
    }

    db.prepare(
        `UPDATE session_jobs SET
            label = ?, status = ?, done = ?, total = ?, remaining = ?, unit = ?, detail = ?,
            heartbeat_at = ?, updated_at = ?
         WHERE session_id = ? AND job_key = ?`
    ).run(
        next.label,
        next.status,
        next.done ?? null,
        next.total ?? null,
        next.remaining ?? null,
        next.unit ?? null,
        next.detail ?? null,
        next.heartbeatAt,
        next.updatedAt,
        sessionId,
        jobKey
    )

    return getSessionJob(db, sessionId, jobKey)
}

export function deleteSessionJob(db: Database, sessionId: string, jobKey: string): boolean {
    const result = db.prepare(
        'DELETE FROM session_jobs WHERE session_id = ? AND job_key = ?'
    ).run(sessionId, jobKey)
    return result.changes > 0
}

export type SessionJobKeyRedirect = {
    fromKey: string
    toKey: string
}

export type TransferSessionJobsResult = {
    moved: number
    collided: number
    /** Source keys remapped on the target so two live supervisors stay isolated. */
    keyRedirects: SessionJobKeyRedirect[]
}

const JOB_KEY_MAX = 128

/** Allocate `base.<fromShort>` (then `.N`) that fits JOB_KEY_MAX and is free on target. */
export function allocateRemappedJobKey(
    db: Database,
    toSessionId: string,
    fromSessionId: string,
    fromKey: string
): string {
    const short = fromSessionId.replace(/-/g, '').slice(0, 8) || 'src'
    const suffix0 = `.${short}`
    const base = fromKey.slice(0, Math.max(1, JOB_KEY_MAX - suffix0.length))
    let candidate = `${base}${suffix0}`
    let n = 0
    while (getSessionJob(db, toSessionId, candidate)) {
        n += 1
        const suffix = `.${short}.${n}`
        candidate = `${fromKey.slice(0, Math.max(1, JOB_KEY_MAX - suffix.length))}${suffix}`
    }
    return candidate
}

/**
 * Re-point jobs during session merge (same contract as scratchlist transfer).
 * Call BEFORE deleteSession so CASCADE does not race the move.
 */
export function transferSessionJobs(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): TransferSessionJobsResult {
    if (fromSessionId === toSessionId) {
        return { moved: 0, collided: 0, keyRedirects: [] }
    }
    const rows = listSessionJobs(db, fromSessionId)
    let moved = 0
    let collided = 0
    const keyRedirects: SessionJobKeyRedirect[] = []

    for (const job of rows) {
        const existing = getSessionJob(db, toSessionId, job.key)
        if (existing) {
            const sourceRunning = job.status === 'running'
            const targetRunning = existing.status === 'running'
            // Two live supervisors still PATCH the pre-merge key via session
            // redirect. Collapsing them would let the loser terminal-mark the
            // winner — keep both under distinct keys and record a key remap.
            if (sourceRunning && targetRunning) {
                const toKey = allocateRemappedJobKey(db, toSessionId, fromSessionId, job.key)
                db.prepare(
                    `UPDATE session_jobs SET session_id = ?, job_key = ?
                     WHERE session_id = ? AND job_key = ?`
                ).run(toSessionId, toKey, fromSessionId, job.key)
                keyRedirects.push({ fromKey: job.key, toKey })
                moved += 1
                collided += 1
                continue
            }
            // Prefer a live source over a terminal target. When both are
            // terminal (incl. completed vs failed), prefer the newer updatedAt.
            const sourceWins =
                (sourceRunning && !targetRunning)
                || (!sourceRunning && !targetRunning && job.updatedAt > existing.updatedAt)
            if (sourceWins) {
                db.prepare('DELETE FROM session_jobs WHERE session_id = ? AND job_key = ?')
                    .run(toSessionId, job.key)
                db.prepare(
                    `UPDATE session_jobs SET session_id = ?
                     WHERE session_id = ? AND job_key = ?`
                ).run(toSessionId, fromSessionId, job.key)
                moved += 1
            } else {
                db.prepare('DELETE FROM session_jobs WHERE session_id = ? AND job_key = ?')
                    .run(fromSessionId, job.key)
            }
            collided += 1
            continue
        }
        db.prepare(
            `UPDATE session_jobs SET session_id = ?
             WHERE session_id = ? AND job_key = ?`
        ).run(toSessionId, fromSessionId, job.key)
        moved += 1
    }

    return { moved, collided, keyRedirects }
}
