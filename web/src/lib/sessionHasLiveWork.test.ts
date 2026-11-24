import { describe, expect, it } from 'vitest'
import { sessionHasLiveWork } from './sessionHasLiveWork'

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
