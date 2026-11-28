import { describe, expect, it } from 'bun:test'
import { toSessionSummary } from '@hapi/protocol'
import type { SyncEvent, SessionPatch } from '@hapi/protocol/types'
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

function derivedWorkPatches(events: SyncEvent[], sessionId: string): Array<boolean | undefined> {
    return events
        .filter((event): event is Extract<SyncEvent, { type: 'session-updated' }> =>
            event.type === 'session-updated' && event.sessionId === sessionId)
        .map((event) => (event.data as SessionPatch | undefined)?.derivedToolWork)
        .filter((value) => value !== undefined)
}

const baseTime = 1_780_000_000_000

describe('derived tool work flag', () => {
    it('noteDerivedWork broadcasts only on change and surfaces in the summary', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'derived-work-broadcast',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )

        expect(session.derivedToolWork ?? false).toBe(false)
        expect(toSessionSummary(cache.getSession(session.id)!).derivedToolWork).toBe(false)

        cache.noteDerivedWork(session.id, true)
        expect(cache.getSession(session.id)?.derivedToolWork).toBe(true)
        expect(toSessionSummary(cache.getSession(session.id)!).derivedToolWork).toBe(true)
        expect(derivedWorkPatches(events, session.id)).toEqual([true])

        // Repeat call with the same value stays quiet (the sweep ticks every 5s).
        events.length = 0
        cache.noteDerivedWork(session.id, true)
        expect(events).toEqual([])

        cache.noteDerivedWork(session.id, false)
        expect(cache.getSession(session.id)?.derivedToolWork).toBe(false)
        expect(derivedWorkPatches(events, session.id)).toEqual([false])

        // Unknown sessions are a no-op, not a broadcast.
        events.length = 0
        cache.noteDerivedWork('never-seen', true)
        expect(events).toEqual([])
        store.close()
    })

    it('survives a cache refresh (transient, never persisted)', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'derived-work-refresh',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )

        cache.noteDerivedWork(session.id, true)
        cache.refreshSession(session.id)
        expect(cache.getSession(session.id)?.derivedToolWork).toBe(true)
        store.close()
    })

    it('handleSessionEnd clears ephemeral flags but keeps durable backgroundWork (#2021 Approach)', () => {
        const originalDateNow = Date.now
        Date.now = () => baseTime
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'derived-work-end',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                null,
                'default'
            )

            cache.handleSessionAlive({ sid: session.id, time: baseTime, thinking: false })
            cache.setBackgroundTasks(session.id, [{ id: 'b1', type: 'local_bash', description: 'run' }])
            cache.noteDerivedWork(session.id, true)
            events.length = 0

            cache.handleSessionEnd({ sid: session.id, time: baseTime + 1_000 })

            const ended = cache.getSession(session.id)!
            expect(ended.active).toBe(false)
            expect(ended.backgroundTaskCount).toBe(0)
            expect(ended.backgroundTasks).toEqual([])
            expect(ended.derivedToolWork).toBe(false)
            // Wrapper exit is not containment proof — durable snapshot remains
            // so Archive still probes (#2021 Approach).
            expect(ended.metadata?.backgroundWork?.tasks).toEqual([
                { id: 'b1', type: 'local_bash', description: 'run' },
            ])
            expect(derivedWorkPatches(events, session.id)).toEqual([false])
            store.close()
        } finally {
            Date.now = originalDateNow
        }
    })

    it('clearing the last background task keeps session metadata parseable (#2021 Major)', () => {
        const originalDateNow = Date.now
        Date.now = () => baseTime
        try {
            const store = new Store(':memory:')
            const cache = new SessionCache(store, createPublisher([]))
            const session = cache.getOrCreateSession(
                'bg-clear-meta',
                { path: '/tmp/project', host: 'localhost', flavor: 'agy' },
                null,
                'default'
            )

            cache.setBackgroundTasks(session.id, [
                { id: 'b1', type: 'local_bash', description: 'job' },
            ])
            expect(cache.getSession(session.id)!.metadata?.backgroundWork?.tasks).toHaveLength(1)

            cache.setBackgroundTasks(session.id, [])
            const after = cache.getSession(session.id)!
            expect(after.backgroundTaskCount).toBe(0)
            expect(after.metadata).not.toBeNull()
            expect(after.metadata?.path).toBe('/tmp/project')
            expect(after.metadata?.host).toBe('localhost')
            expect(after.metadata?.backgroundWork).toBeUndefined()
            store.close()
        } finally {
            Date.now = originalDateNow
        }
    })

    it('expireInactive preserves background tasks across heartbeat expiry (#2021 Major)', () => {
        const originalDateNow = Date.now
        Date.now = () => baseTime
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'derived-work-expire',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                null,
                'default'
            )

            cache.handleSessionAlive({ sid: session.id, time: baseTime, thinking: false })
            // Background snapshot must survive keepalive expiry — Antigravity
            // only re-emits on membership change (#2021 Major).
            cache.setBackgroundTasks(session.id, [
                { id: 'b1', type: 'local_bash', description: 'long job' }
            ])
            cache.noteDerivedWork(session.id, true)
            events.length = 0

            const expired = cache.expireInactive(baseTime + 30_001)
            expect(expired).toEqual([session.id])

            const after = cache.getSession(session.id)!
            expect(after.active).toBe(false)
            expect(after.backgroundTaskCount).toBe(1)
            expect(after.backgroundTasks).toEqual([
                { id: 'b1', type: 'local_bash', description: 'long job' },
            ])
            expect(after.derivedToolWork).toBe(false)

            const patches = events
                .filter((event): event is Extract<SyncEvent, { type: 'session-updated' }> =>
                    event.type === 'session-updated' && event.sessionId === session.id)
                .map((event) => event.data as SessionPatch)
            expect(patches).toHaveLength(1)
            expect(patches[0]!.backgroundTaskCount).toBeUndefined()
            expect(patches[0]!.backgroundTasks).toBeUndefined()
            expect(patches[0]!.derivedToolWork).toBe(false)
            store.close()
        } finally {
            Date.now = originalDateNow
        }
    })
})
