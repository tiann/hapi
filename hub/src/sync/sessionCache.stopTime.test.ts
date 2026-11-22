import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

// Clients order stopped sessions by when they stopped (activeAt), so every stop
// transition must carry it in the cache and in its session-updated patch, and
// persist the same value so a restarted hub keeps the order.

const baseTime = 1_780_000_000_000

function withClock<T>(now: number, run: () => T): T {
    const original = Date.now
    Date.now = () => now
    try { return run() } finally { Date.now = original }
}

function setup(id: string) {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const publisher = { emit: (event: SyncEvent) => { events.push(event) } } as unknown as EventPublisher
    const cache = new SessionCache(store, publisher)
    // Created a minute earlier; the last keepalive lands at baseTime. The hub
    // stamps keepalives with its own clock and keeps them in the cache only.
    const sessionId = withClock(baseTime - 60_000, () =>
        cache.getOrCreateSession(id, { path: '/tmp/project', host: 'localhost', flavor: 'claude' }, null, 'default').id
    )
    withClock(baseTime, () => cache.handleSessionAlive({ sid: sessionId, time: baseTime, thinking: false }))
    events.length = 0
    const inactivePatch = () => events
        .filter((event): event is Extract<SyncEvent, { type: 'session-updated' }> => event.type === 'session-updated')
        .map((event) => event.data as { active?: boolean; activeAt?: number })
        .find((data) => data.active === false)
    const reloadedActiveAt = () => new SessionCache(store, publisher).refreshSession(sessionId)?.activeAt
    return { cache, sessionId, inactivePatch, reloadedActiveAt }
}

describe('stop time on session stop transitions', () => {
    it('records, sends and persists the session end time', () => {
        const { cache, sessionId, inactivePatch, reloadedActiveAt } = setup('session-stop-end')
        expect(cache.getSession(sessionId)?.activeAt).toBe(baseTime)

        withClock(baseTime + 10_000, () => cache.handleSessionEnd({ sid: sessionId, time: baseTime + 10_000 }))

        expect(cache.getSession(sessionId)?.activeAt).toBe(baseTime + 10_000)
        expect(inactivePatch()?.activeAt).toBe(baseTime + 10_000)
        expect(reloadedActiveAt()).toBe(baseTime + 10_000)
    })

    it('keeps the later keepalive when the end time from a trailing CLI clock is earlier', () => {
        const { cache, sessionId, inactivePatch, reloadedActiveAt } = setup('session-stop-end-skew')

        withClock(baseTime + 10_000, () => cache.handleSessionEnd({ sid: sessionId, time: baseTime - 2_000 }))

        expect(cache.getSession(sessionId)?.activeAt).toBe(baseTime)
        expect(inactivePatch()?.activeAt).toBe(baseTime)
        expect(reloadedActiveAt()).toBe(baseTime)
    })

    it('sends and persists the last keepalive, not the sweep time, when a session expires', () => {
        const { cache, sessionId, inactivePatch, reloadedActiveAt } = setup('session-stop-expire')

        withClock(baseTime + 31_000, () => expect(cache.expireInactive(baseTime + 31_000)).toEqual([sessionId]))

        expect(cache.getSession(sessionId)?.activeAt).toBe(baseTime)
        expect(inactivePatch()?.activeAt).toBe(baseTime)
        // A restarted hub reloads the same stop time, so the order is unchanged.
        expect(reloadedActiveAt()).toBe(baseTime)
    })
})
