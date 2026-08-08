import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { MetadataSchema } from '@hapi/protocol/schemas'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

/**
 * Cold-review pass 2 (#1404): job-owner redirects written by recordJobs*()
 * must survive SessionCache.refreshSession. MetadataSchema used to strip
 * jobsAcceptedFromSessionIds / jobsTransferredToSessionId as unknown keys,
 * so resolveAttachedJobSessionId never followed the merge.
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

function makeSessions(cache: SessionCache, ns: string = 'default') {
    const oldSession = cache.getOrCreateSession(
        'agent-jobs-old-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        ns
    )
    const newSession = cache.getOrCreateSession(
        'agent-jobs-new-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        ns
    )
    return { oldSession, newSession }
}

describe('mergeSessions job redirect through SessionCache (#1404)', () => {
    it('keeps jobsAcceptedFromSessionIds after refresh when old session is deleted', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)

        const upserted = store.sessionJobs.upsert(oldSession.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 12
        })
        expect(upserted.outcome).toBe('upserted')

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(store.sessionJobs.getPrimaryRunning(newSession.id)?.key).toBe('beets')
        expect(store.sessions.getSession(oldSession.id)).toBeNull()

        // Schema strip regression: refresh must retain the acceptor list.
        const refreshed = cache.refreshSession(newSession.id)
        expect(refreshed).not.toBeNull()
        const accepted = refreshed!.metadata?.jobsAcceptedFromSessionIds
        expect(accepted).toContain(oldSession.id)
        expect(
            MetadataSchema.parse(refreshed!.metadata).jobsAcceptedFromSessionIds
        ).toContain(oldSession.id)

        expect(cache.resolveAttachedJobSessionId(oldSession.id, 'default')).toBe(newSession.id)
        expect(cache.resolveAttachedJobSessionId(newSession.id, 'default')).toBe(newSession.id)
    })

    it('keeps jobsTransferredToSessionId on a kept-alive source after mergeSessionHistory', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)

        store.sessionJobs.upsert(oldSession.id, 'drain', {
            label: 'rsync drain',
            status: 'running',
            remaining: 3
        })

        await cache.mergeSessionHistory(oldSession.id, newSession.id, 'default', {
            mergeAgentState: false
        })

        expect(store.sessionJobs.getPrimaryRunning(newSession.id)?.key).toBe('drain')
        expect(store.sessions.getSession(oldSession.id)).not.toBeNull()

        const refreshedOld = cache.refreshSession(oldSession.id)
        expect(refreshedOld?.metadata?.jobsTransferredToSessionId).toBe(newSession.id)
        expect(
            MetadataSchema.parse(refreshedOld!.metadata).jobsTransferredToSessionId
        ).toBe(newSession.id)

        expect(cache.resolveAttachedJobSessionId(oldSession.id, 'default')).toBe(newSession.id)
    })
})
