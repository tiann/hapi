import { describe, expect, it } from 'vitest'
import type { SessionSummary, SessionsResponse } from '@/types/api'
import { reconcileAttachedJobsFromCache } from './reconcileAttachedJobs'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides,
    }
}

describe('reconcileAttachedJobsFromCache', () => {
    it('keeps a newer cached clear over a stale REST snapshot that still has the job', () => {
        const id = 'sess-1'
        const cached: SessionsResponse = {
            sessions: [
                makeSummary({
                    id,
                    attachedJob: null,
                    attachedJobUpdatedAt: 20,
                }),
            ],
        }
        const fetched: SessionsResponse = {
            sessions: [
                makeSummary({
                    id,
                    attachedJob: {
                        key: 'batch',
                        label: 'batch',
                        status: 'running',
                        startedAt: 1,
                        heartbeatAt: 1,
                        updatedAt: 10,
                    },
                    attachedJobUpdatedAt: 10,
                }),
            ],
        }
        const next = reconcileAttachedJobsFromCache(fetched, cached)
        expect(next.sessions[0]?.attachedJob).toBeNull()
        expect(next.sessions[0]?.attachedJobUpdatedAt).toBe(20)
    })

    it('accepts a fresher REST snapshot', () => {
        const id = 'sess-1'
        const cached: SessionsResponse = {
            sessions: [
                makeSummary({
                    id,
                    attachedJob: {
                        key: 'batch',
                        label: 'batch',
                        status: 'running',
                        startedAt: 1,
                        heartbeatAt: 1,
                        updatedAt: 10,
                    },
                    attachedJobUpdatedAt: 10,
                }),
            ],
        }
        const fetched: SessionsResponse = {
            sessions: [
                makeSummary({
                    id,
                    attachedJob: null,
                    attachedJobUpdatedAt: 30,
                }),
            ],
        }
        const next = reconcileAttachedJobsFromCache(fetched, cached)
        expect(next.sessions[0]?.attachedJob).toBeNull()
        expect(next.sessions[0]?.attachedJobUpdatedAt).toBe(30)
    })

    it('passes through when there is no cache', () => {
        const fetched: SessionsResponse = {
            sessions: [makeSummary({ id: 'a', attachedJobUpdatedAt: 1 })],
        }
        expect(reconcileAttachedJobsFromCache(fetched, undefined)).toBe(fetched)
    })
})
