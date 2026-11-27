import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

/**
 * Repeat/queue tasks follow a merged-away session to its survivor (and an
 * OpenCode /clear's source to its replacement). The survivor's task bar
 * learns that through `session-tasks-changed`, like every other task change.
 */

function createCapturingPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

function setup() {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const cache = new SessionCache(store, createCapturingPublisher(events))
    return { store, events, cache }
}

function makeSessions(cache: SessionCache) {
    const oldSession = cache.getOrCreateSession(
        'tasks-old-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        'default'
    )
    const newSession = cache.getOrCreateSession(
        'tasks-new-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        'default'
    )
    return { oldSession, newSession }
}

const taskChanges = (events: SyncEvent[]) => events.filter((event) => event.type === 'session-tasks-changed')

describe('session tasks through a session merge', () => {
    it('announces the tasks a merge moved to the survivor', async () => {
        const { store, events, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        const task = store.sessionTasks.create({
            sessionId: oldSession.id,
            kind: 'repeat',
            items: ['ping'],
            intervalMs: 60_000,
            maxRuns: null,
            startAt: 1,
            nextRunAt: 1
        })
        events.length = 0

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(store.sessionTasks.list(newSession.id).map((row) => row.id)).toEqual([task.id])
        expect(taskChanges(events)).toEqual([{ type: 'session-tasks-changed', sessionId: newSession.id }])
    })

    it('announces the tasks an OpenCode clear transfer moved to the replacement', () => {
        const { store, events, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        store.sessionTasks.create({
            sessionId: oldSession.id,
            kind: 'queue',
            items: ['a'],
            intervalMs: 60_000,
            maxRuns: null,
            startAt: 1,
            nextRunAt: 1
        })
        events.length = 0

        cache.transferAttachedJobs(oldSession.id, newSession.id, 'default')

        expect(store.sessionTasks.list(newSession.id)).toHaveLength(1)
        expect(taskChanges(events)).toEqual([{ type: 'session-tasks-changed', sessionId: newSession.id }])
    })

    it('says nothing when the source had no tasks', async () => {
        const { store, events, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        store.sessionJobs.upsert(oldSession.id, 'beets', { label: 'beets import', status: 'running', remaining: 1 })
        events.length = 0

        cache.transferAttachedJobs(oldSession.id, newSession.id, 'default')
        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(events.some((event) => event.type === 'session-updated')).toBe(true)
        expect(taskChanges(events)).toEqual([])
    })
})
