import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@hapi/protocol'
import {
    hasAgentForegroundWork,
    hasRunningAttachedJob,
    isAgentForegroundThinking,
} from './sessionInProgress'

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
    return {
        id: 'session-1',
        active: false,
        thinking: false,
        activeAt: 0,
        thinkingAt: 0,
        updatedAt: 0,
        createdAt: 0,
        pinned: false,
        globalPinned: false,
        metadata: null,
        backgroundTaskCount: 0,
        pendingRequestsCount: 0,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        ...overrides,
    } as SessionSummary
}

const runningJob = {
    key: 'batch',
    label: 'Batch',
    status: 'running' as const,
    heartbeatAt: 1,
    startedAt: 1,
    updatedAt: 1,
}

describe('sessionInProgress', () => {
    it('detects running attached jobs', () => {
        expect(hasRunningAttachedJob(makeSession({ attachedJob: runningJob }))).toBe(true)
        expect(hasRunningAttachedJob(makeSession({ attachedJob: { ...runningJob, status: 'completed' } }))).toBe(false)
    })

    it('keeps real foreground thinking when a job is also attached (#1553)', () => {
        const session = makeSession({
            active: true,
            thinking: true,
            attachedJob: runningJob,
        })
        expect(isAgentForegroundThinking(session)).toBe(true)
        expect(hasAgentForegroundWork(session)).toBe(true)
    })

    it('defers to pending chrome instead of the thinking spinner', () => {
        const session = makeSession({
            active: true,
            thinking: true,
            pendingRequestsCount: 1,
            attachedJob: runningJob,
        })
        expect(isAgentForegroundThinking(session)).toBe(false)
        expect(hasAgentForegroundWork(session)).toBe(false)
    })

    it('still treats background tasks as foreground work', () => {
        expect(hasAgentForegroundWork(makeSession({
            active: true,
            backgroundTaskCount: 2,
            attachedJob: runningJob,
        }))).toBe(true)
    })
})
