/** Missing supervisor heartbeats make progress unconfirmed, not proof of process exit. */
export const ATTACHED_JOB_STALE_MS = 15 * 60 * 1000

export function isAttachedJobStale(job: { heartbeatAt: number }, now: number = Date.now()): boolean {
    return now - job.heartbeatAt > ATTACHED_JOB_STALE_MS
}
