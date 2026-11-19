import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

// Clients order stopped sessions by when they stopped (activeAt), so every stop
// transition must carry it in the cache and in its session-updated patch.

const baseTime = 1_780_000_000_000

function setup(id: string) {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const publisher = { emit: (event: SyncEvent) => { events.push(event) } } as unknown as EventPublisher
    const cache = new SessionCache(store, publisher)
    const session = cache.getOrCreateSession(id, { path: '/tmp/project', host: 'localhost', flavor: 'claude' }, null, 'default')
    cache.handleSessionAlive({ sid: session.id, time: baseTime, thinking: false })
    events.length = 0
    const inactivePatch = () => events
        .filter((event): event is Extract<SyncEvent, { type: 'session-updated' }> => event.type === 'session-updated')
        .map((event) => event.data as { active?: boolean; activeAt?: number })
        .find((data) => data.active === false)
    return { cache, sessionId: session.id, inactivePatch }
}

function withClock(now: number, run: () => void): void {
    const original = Date.now
    Date.now = () => now
    try { run() } finally { Date.now = original }
}

describe('stop time on session stop transitions', () => {
    it('records and sends the session end time', () => {
        withClock(baseTime + 10_000, () => {
            const { cache, sessionId, inactivePatch } = setup('session-stop-end')
            cache.handleSessionEnd({ sid: sessionId, time: baseTime + 10_000 })

            expect(cache.getSession(sessionId)?.activeAt).toBe(baseTime + 10_000)
            expect(inactivePatch()?.activeAt).toBe(baseTime + 10_000)
        })
    })

    it('sends the last keepalive when a session expires', () => {
        withClock(baseTime, () => {
            const { cache, sessionId, inactivePatch } = setup('session-stop-expire')
            expect(cache.expireInactive(baseTime + 31_000)).toEqual([sessionId])

            expect(cache.getSession(sessionId)?.activeAt).toBe(baseTime)
            expect(inactivePatch()?.activeAt).toBe(baseTime)
        })
    })
})
