import { describe, expect, it } from 'vitest'
import { hasLiveWork, isKeepaliveIdle, isLiveSession, sessionLivenessRank } from './sessionLiveness'

const idle = { active: true, thinking: false, metadata: { lifecycleState: 'idle' } }

describe('sessionLiveness', () => {
    it('reads a keepalive-idle session as connected but not live', () => {
        expect(isKeepaliveIdle(idle)).toBe(true)
        expect(isLiveSession(idle)).toBe(false)
        expect(sessionLivenessRank(idle)).toBe(1)

        expect(isKeepaliveIdle({ ...idle, active: false })).toBe(false)
        expect(sessionLivenessRank({ ...idle, active: false })).toBe(2)
        expect(isLiveSession({ active: true, metadata: { lifecycleState: 'running' } })).toBe(true)
    })

    it('lets live work outrank the idle mark, like the pinned buckets do', () => {
        // The hub does not lift an idle mark on `thinking` alone
        // (tiann/hapi#1553), so idle + thinking is a real state. It has to
        // read as working everywhere, not only in bucketRunningSessions.
        for (const work of [{ thinking: true }, { backgroundTaskCount: 1 }, { pendingRequestsCount: 1 }]) {
            const session = { ...idle, ...work }
            expect(hasLiveWork(session)).toBe(true)
            expect(isKeepaliveIdle(session)).toBe(false)
            expect(isLiveSession(session)).toBe(true)
            expect(sessionLivenessRank(session)).toBe(0)
        }
        expect(hasLiveWork(idle)).toBe(false)
    })
})
