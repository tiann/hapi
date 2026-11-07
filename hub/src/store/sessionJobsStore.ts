import type { Database } from 'bun:sqlite'
import type { AttachedJob, AttachedJobPatch, AttachedJobUpsert } from '@hapi/protocol'

import type { StoredSessionJob } from './types'
import {
    deleteSessionJob,
    getPrimaryRunningJob,
    getPrimaryRunningJobsBySessionIds,
    getSessionJob,
    listSessionJobs,
    patchSessionJob,
    claimSessionJobTerminalWake,
    releaseSessionJobTerminalWake,
    markSessionJobTerminalWakeDelivered,
    clearAbandonedProvisionalWakeClaims,
    listPendingTerminalWakes,
    toAttachedJob,
    transferSessionJobs,
    upsertSessionJob,
    allocateRemappedJobKey,
    type PatchSessionJobResult,
    type TransferSessionJobsResult,
    type UpsertSessionJobResult
} from './sessionJobs'

export class SessionJobsStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    list(sessionId: string): StoredSessionJob[] {
        return listSessionJobs(this.db, sessionId)
    }

    get(sessionId: string, jobKey: string): StoredSessionJob | null {
        return getSessionJob(this.db, sessionId, jobKey)
    }

    getPrimaryRunning(sessionId: string): AttachedJob | null {
        const job = getPrimaryRunningJob(this.db, sessionId)
        return job ? toAttachedJob(job) : null
    }

    getPrimaryRunningBySessionIds(sessionIds: string[]): Map<string, AttachedJob> {
        return getPrimaryRunningJobsBySessionIds(this.db, sessionIds)
    }

    upsert(
        sessionId: string,
        jobKey: string,
        body: AttachedJobUpsert,
        now?: number
    ): UpsertSessionJobResult {
        return upsertSessionJob(this.db, sessionId, jobKey, body, now)
    }

    patch(
        sessionId: string,
        jobKey: string,
        patch: AttachedJobPatch,
        now?: number
    ): PatchSessionJobResult {
        return patchSessionJob(this.db, sessionId, jobKey, patch, now)
    }

    /** One-shot provisional claim for #1489 terminal wake. */
    claimTerminalWake(sessionId: string, jobKey: string): StoredSessionJob | null {
        return claimSessionJobTerminalWake(this.db, sessionId, jobKey)
    }

    /** Release a provisional wake claim after a recoverable delivery failure. */
    releaseTerminalWake(sessionId: string, jobKey: string, expectedClaimId: string): boolean {
        return releaseSessionJobTerminalWake(this.db, sessionId, jobKey, expectedClaimId)
    }

    /** Persist durable wake delivery after the prompt is stored. */
    markTerminalWakeDelivered(sessionId: string, jobKey: string, claimId: string): boolean {
        return markSessionJobTerminalWakeDelivered(this.db, sessionId, jobKey, claimId)
    }

    /** Clear abandoned `pending:*` markers after hub restart. */
    clearAbandonedProvisionalWakeClaims(): number {
        return clearAbandonedProvisionalWakeClaims(this.db)
    }

    /** Terminal + opt-in jobs still awaiting wake delivery for their current run. */
    listPendingTerminalWakes(): StoredSessionJob[] {
        return listPendingTerminalWakes(this.db)
    }

    delete(
        sessionId: string,
        jobKey: string,
        expectedRunId?: string
    ): import('./sessionJobs').DeleteSessionJobResult {
        return deleteSessionJob(this.db, sessionId, jobKey, expectedRunId)
    }

    transfer(fromSessionId: string, toSessionId: string): TransferSessionJobsResult {
        return transferSessionJobs(this.db, fromSessionId, toSessionId)
    }

    allocateRemappedKey(
        toSessionId: string,
        fromSessionId: string,
        fromKey: string
    ): string {
        return allocateRemappedJobKey(this.db, toSessionId, fromSessionId, fromKey)
    }
}
