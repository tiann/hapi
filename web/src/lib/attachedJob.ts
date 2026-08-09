import type { AttachedJob } from '@hapi/protocol'

/** Stale if no heartbeat for 15 minutes — UI amber, still shows progress. */
export const ATTACHED_JOB_STALE_MS = 15 * 60 * 1000

/**
 * Compact lettered elapsed duration for list chrome.
 * Max two units; never an ETA / time-remaining estimate.
 */
export function formatCompactElapsed(elapsedMs: number): string {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '0s'
    const totalSec = Math.floor(elapsedMs / 1000)
    if (totalSec < 60) return `${totalSec}s`
    const totalMin = Math.floor(totalSec / 60)
    if (totalMin < 60) return `${totalMin}m`
    const totalHr = Math.floor(totalMin / 60)
    const remMin = totalMin % 60
    if (totalHr < 24) {
        return remMin > 0 ? `${totalHr}h ${remMin}m` : `${totalHr}h`
    }
    const days = Math.floor(totalHr / 24)
    const remHr = totalHr % 24
    return remHr > 0 ? `${days}d ${remHr}h` : `${days}d`
}

/** Elapsed since job.startedAt (hub clock). */
export function formatAttachedJobElapsed(job: AttachedJob, now: number = Date.now()): string {
    return formatCompactElapsed(now - job.startedAt)
}

/** How long since the last heartbeat (for stale chrome). */
export function formatAttachedJobHeartbeatAge(job: AttachedJob, now: number = Date.now()): string {
    return formatCompactElapsed(Math.max(0, now - job.heartbeatAt))
}

/** Optional locale fragments; defaults keep unit tests / English callers working. */
export type AttachedJobProgressLabels = {
    left: string
    running: string
    noHeartbeat: string
}

const DEFAULT_ATTACHED_JOB_PROGRESS_LABELS: AttachedJobProgressLabels = {
    left: 'left',
    running: 'running',
    noHeartbeat: 'no heartbeat',
}

/**
 * Progress label for the session row.
 * Always appends elapsed from startedAt — honest wall time, not an ETA.
 * When stale, appends an explicit "no heartbeat · Xm" so a frozen done/total
 * is not mistaken for a healthy live job (wardrobe dogfood).
 */
export function formatAttachedJobProgress(
    job: AttachedJob,
    now: number = Date.now(),
    labels: AttachedJobProgressLabels = DEFAULT_ATTACHED_JOB_PROGRESS_LABELS
): string {
    const elapsed = formatAttachedJobElapsed(job, now)
    let base: string
    if (job.remaining !== undefined) {
        const unit = job.unit ? ` ${job.unit}` : ''
        base = `${job.remaining}${unit} ${labels.left} · ${elapsed}`
    } else if (job.done !== undefined && job.total !== undefined && job.total > 0) {
        const pct = Math.min(100, Math.round((job.done / job.total) * 100))
        base = `${pct}% · ${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ''} · ${elapsed}`
    } else {
        base = `${labels.running} · ${elapsed}`
    }
    if (isAttachedJobStale(job, now)) {
        return `${base} · ${labels.noHeartbeat} · ${formatAttachedJobHeartbeatAge(job, now)}`
    }
    return base
}

export function attachedJobFraction(job: AttachedJob): number | null {
    if (job.done !== undefined && job.total !== undefined && job.total > 0) {
        return Math.max(0, Math.min(1, job.done / job.total))
    }
    if (job.remaining !== undefined && job.total !== undefined && job.total > 0) {
        const done = Math.max(0, job.total - job.remaining)
        return Math.max(0, Math.min(1, done / job.total))
    }
    return null
}

export function isAttachedJobStale(job: AttachedJob, now: number = Date.now()): boolean {
    return now - job.heartbeatAt > ATTACHED_JOB_STALE_MS
}
