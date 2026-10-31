import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { RUNNER_DECLARED_ALIVE_TTL_MS, SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

const baseTime = 1_780_000_000_000

function withMockedClock(run: () => void): void {
    const originalDateNow = Date.now
    Date.now = () => baseTime
    try {
        run()
    } finally {
        Date.now = originalDateNow
    }
}

function createActiveSession(cache: SessionCache, id: string): string {
    const session = cache.getOrCreateSession(
        id,
        { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        null,
        'default'
    )
    cache.handleSessionAlive({
        sid: session.id,
        time: baseTime,
        thinking: false
    })
    return session.id
}

describe('runner-declared session liveness', () => {
    it('keeps a declared session active past the keepalive timeout', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-runner-held')
            events.length = 0

            cache.noteRunnerDeclaredSessions('machine-1', [sessionId], baseTime + 5_000)

            expect(cache.expireInactive(baseTime + 30_001)).toEqual([])
            expect(cache.getSession(sessionId)?.active).toBe(true)
            expect(events).toEqual([])
        })
    })

    it('expires a declared session once the declaration TTL elapses', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-runner-ttl')

            cache.noteRunnerDeclaredSessions('machine-1', [sessionId], baseTime)

            expect(cache.expireInactive(baseTime + 30_001)).toEqual([])
            const expired = cache.expireInactive(baseTime + RUNNER_DECLARED_ALIVE_TTL_MS + 1)
            expect(expired).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
        })
    })

    it('revives an expired session when a declaration arrives', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-runner-revive')

            expect(cache.expireInactive(baseTime + 30_001)).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
            events.length = 0

            cache.noteRunnerDeclaredSessions('machine-1', [sessionId], baseTime + 60_000)

            const session = cache.getSession(sessionId)
            expect(session?.active).toBe(true)
            expect(session?.activeAt).toBe(baseTime + 60_000)
            expect(store.sessions.getSession(sessionId)?.active).toBe(true)
            const revived = events.find((event) => event.type === 'session-updated')
            expect(revived && revived.type === 'session-updated' && revived.data && 'active' in revived.data
                ? revived.data.active
                : undefined).toBe(true)
        })
    })

    it('drops a session declaration when the machine replaces its set', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const endedId = createActiveSession(cache, 'session-runner-ended')
            const keptId = createActiveSession(cache, 'session-runner-kept')

            cache.noteRunnerDeclaredSessions('machine-1', [endedId, keptId], baseTime + 5_000)
            // Next heartbeat no longer reports the ended session.
            cache.noteRunnerDeclaredSessions('machine-1', [keptId], baseTime + 25_000)

            const expired = cache.expireInactive(baseTime + 30_001)
            expect(expired).toEqual([endedId])
            expect(cache.getSession(keptId)?.active).toBe(true)
            expect(cache.getSession(endedId)?.active).toBe(false)
        })
    })

    it('keeps declarations machine-scoped', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-runner-scoped')

            cache.noteRunnerDeclaredSessions('machine-1', [sessionId], baseTime + 5_000)
            // A different machine replacing ITS set must not touch machine-1's.
            cache.noteRunnerDeclaredSessions('machine-2', ['other-session'], baseTime + 10_000)

            expect(cache.expireInactive(baseTime + 30_001)).toEqual([])
            expect(cache.getSession(sessionId)?.active).toBe(true)
        })
    })

    it('ignores declarations for unknown sessions without creating them', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            cache.noteRunnerDeclaredSessions('machine-1', ['never-seen'], baseTime)

            expect(cache.getSession('never-seen')).toBeUndefined()
            expect(events).toEqual([])
            // The stray declaration ages out without side effects.
            cache.expireInactive(baseTime + RUNNER_DECLARED_ALIVE_TTL_MS + 1)
            expect(cache.getSession('never-seen')).toBeUndefined()
        })
    })

    it('expires a revived session again once the runner stops declaring it', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-runner-revive-then-die')

            cache.expireInactive(baseTime + 30_001)
            cache.noteRunnerDeclaredSessions('machine-1', [sessionId], baseTime + 60_000)
            expect(cache.getSession(sessionId)?.active).toBe(true)

            // Runner goes silent: declaration is only refreshed at +60s, so
            // past the TTL the normal expiry applies again.
            expect(cache.expireInactive(baseTime + 60_000 + RUNNER_DECLARED_ALIVE_TTL_MS + 1)).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
        })
    })
})
