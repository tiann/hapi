import type { AttachedJob } from '@hapi/protocol'

/** Stale if no heartbeat for 15 minutes — UI amber, still shows progress. */
export const ATTACHED_JOB_STALE_MS = 15 * 60 * 1000

export function formatAttachedJobProgress(job: AttachedJob): string {
    if (job.remaining !== undefined) {
        const unit = job.unit ? ` ${job.unit}` : ''
        return `${job.remaining}${unit} left`
    }
    if (job.done !== undefined && job.total !== undefined && job.total > 0) {
        const pct = Math.min(100, Math.round((job.done / job.total) * 100))
        return `${pct}% · ${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ''}`
    }
    return 'running'
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
