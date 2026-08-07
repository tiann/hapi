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

/**
 * Progress label for the session row.
 * Always appends elapsed from startedAt — honest wall time, not an ETA.
 */
export function formatAttachedJobProgress(job: AttachedJob, now: number = Date.now()): string {
    const elapsed = formatAttachedJobElapsed(job, now)
    if (job.remaining !== undefined) {
        const unit = job.unit ? ` ${job.unit}` : ''
        return `${job.remaining}${unit} left · ${elapsed}`
    }
    if (job.done !== undefined && job.total !== undefined && job.total > 0) {
        const pct = Math.min(100, Math.round((job.done / job.total) * 100))
        return `${pct}% · ${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ''} · ${elapsed}`
    }
    return `running · ${elapsed}`
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
