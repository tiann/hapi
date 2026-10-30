import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

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

function createActiveSession(cache: SessionCache, id: string, thinking: boolean): string {
    const session = cache.getOrCreateSession(
        id,
        { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        null,
        'default'
    )
    cache.handleSessionAlive({
        sid: session.id,
        time: baseTime,
        thinking
    })
    return session.id
}

describe('expireInactive thinking grace', () => {
    it('keeps a thinking session active past the plain keepalive timeout', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-thinking-grace-hold', true)
            events.length = 0

            const expired = cache.expireInactive(baseTime + 60_000)

            expect(expired).toEqual([])
            expect(cache.getSession(sessionId)?.active).toBe(true)
            expect(cache.getSession(sessionId)?.thinking).toBe(true)
            expect(events).toEqual([])
        })
    })

    it('expires a thinking session once the extended grace elapses', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-thinking-grace-expire', true)
            events.length = 0

            const expired = cache.expireInactive(baseTime + 300_001)

            expect(expired).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
            expect(cache.getSession(sessionId)?.thinking).toBe(false)
            expect(events.some((event) => event.type === 'session-updated')).toBe(true)
        })
    })

    it('still expires an idle session on the plain keepalive timeout', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-idle-timeout', false)

            expect(cache.expireInactive(baseTime + 29_999)).toEqual([])
            expect(cache.expireInactive(baseTime + 30_001)).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
        })
    })

    it('falls back to the plain timeout once a session stops thinking', () => {
        withMockedClock(() => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = createActiveSession(cache, 'session-thinking-then-idle', true)

            cache.handleSessionAlive({
                sid: sessionId,
                time: baseTime + 120_000,
                thinking: false
            })

            expect(cache.expireInactive(baseTime + 150_001)).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
        })
    })
})
