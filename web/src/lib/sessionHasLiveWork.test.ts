import { describe, expect, it } from 'vitest'
import { sessionBlocksHardArchive, sessionHasLiveWork } from './sessionHasLiveWork'

describe('sessionHasLiveWork', () => {
    it('is false for an idle connected session', () => {
        expect(sessionHasLiveWork({ thinking: false, backgroundTaskCount: 0, pendingRequestsCount: 0 })).toBe(false)
    })

    it('detects thinking, derived tool work, background tasks, and pending requests', () => {
        expect(sessionHasLiveWork({ thinking: true, backgroundTaskCount: 0 })).toBe(true)
        expect(sessionHasLiveWork({ thinking: false, derivedToolWork: true, backgroundTaskCount: 0 })).toBe(true)
        expect(sessionHasLiveWork({ thinking: false, backgroundTaskCount: 2 })).toBe(true)
        expect(sessionHasLiveWork({ thinking: false, backgroundTaskCount: 0, pendingRequestsCount: 1 })).toBe(true)
        expect(sessionHasLiveWork({
            thinking: false,
            backgroundTaskCount: 0,
            agentState: { requests: { r1: {} } },
        })).toBe(true)
    })
})

describe('sessionBlocksHardArchive', () => {
    it('blocks idleReconcileExempt and waiting even when hasLiveWork is false (#2020)', () => {
        expect(sessionBlocksHardArchive({
            thinking: false,
            backgroundTaskCount: 0,
            metadata: { idleReconcileExempt: true },
        })).toBe(true)
        expect(sessionBlocksHardArchive({
            thinking: false,
            backgroundTaskCount: 0,
            metadata: { waiting: { since: 1, reason: 'watch CI on tip' } },
        })).toBe(true)
        expect(sessionBlocksHardArchive({
            thinking: false,
            backgroundTaskCount: 0,
            pendingRequestsCount: 0,
        })).toBe(false)
    })
})
