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
    toAttachedJob,
    transferSessionJobs,
    upsertSessionJob,
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
    ): StoredSessionJob | null {
        return patchSessionJob(this.db, sessionId, jobKey, patch, now)
    }

    delete(sessionId: string, jobKey: string): boolean {
        return deleteSessionJob(this.db, sessionId, jobKey)
    }

    transfer(fromSessionId: string, toSessionId: string): { moved: number; collided: number } {
        return transferSessionJobs(this.db, fromSessionId, toSessionId)
    }
}
