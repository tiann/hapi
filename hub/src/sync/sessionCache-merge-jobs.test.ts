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

    it('records job redirects even when the source has no jobs yet', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(store.sessions.getSession(oldSession.id)).toBeNull()
        const refreshed = cache.refreshSession(newSession.id)
        expect(refreshed?.metadata?.jobsAcceptedFromSessionIds).toContain(oldSession.id)
        expect(cache.resolveAttachedJobSessionId(oldSession.id, 'default')).toBe(newSession.id)

        // First job attach after merge still lands on the canonical session
        // when the agent keeps the pre-merge HAPI_SESSION_ID.
        const upserted = store.sessionJobs.upsert(
            cache.resolveAttachedJobSessionId(oldSession.id, 'default')!,
            'late',
            { label: 'late attach', status: 'running', remaining: 1 }
        )
        expect(upserted.outcome).toBe('upserted')
        expect(store.sessionJobs.getPrimaryRunning(newSession.id)?.key).toBe('late')
    })

    it('preserves A→B→C jobsAccepted ancestry so deleted A still resolves on C', async () => {
        const { store, cache } = setup()
        const a = cache.getOrCreateSession(
            'agent-jobs-a-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const b = cache.getOrCreateSession(
            'agent-jobs-b-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const c = cache.getOrCreateSession(
            'agent-jobs-c-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        store.sessionJobs.upsert(a.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 9
        })
        await cache.mergeSessions(a.id, b.id, 'default')
        expect(cache.resolveAttachedJobSessionId(a.id, 'default')).toBe(b.id)

        await cache.mergeSessions(b.id, c.id, 'default')
        const refreshed = cache.refreshSession(c.id)
        expect(refreshed?.metadata?.jobsAcceptedFromSessionIds).toEqual(
            expect.arrayContaining([a.id, b.id])
        )
        expect(cache.resolveAttachedJobSessionId(a.id, 'default')).toBe(c.id)
        expect(cache.resolveAttachedJobSessionId(b.id, 'default')).toBe(c.id)
        expect(store.sessionJobs.getPrimaryRunning(c.id)?.key).toBe('beets')
    })

    it('keeps jobsAcceptedFromSessionIds when metadata merge also copies name from old', async () => {
        const { store, cache } = setup()
        const oldSession = cache.getOrCreateSession(
            'agent-jobs-named-old-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'codex', name: 'Lidarr drain' },
            null,
            'default'
        )
        const newSession = cache.getOrCreateSession(
            'agent-jobs-named-new-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        store.sessionJobs.upsert(oldSession.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 4
        })

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const refreshed = cache.refreshSession(newSession.id)
        expect(refreshed?.metadata?.name).toBe('Lidarr drain')
        expect(refreshed?.metadata?.jobsAcceptedFromSessionIds).toContain(oldSession.id)
        expect(cache.resolveAttachedJobSessionId(oldSession.id, 'default')).toBe(newSession.id)
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

    it('remaps dual-running same-key jobs and routes PATCH via jobKeyRedirects', async () => {
        const { store, cache } = setup()
        const oldId = 'aaaaaaaa-1111-1111-1111-111111111111'
        const newId = 'bbbbbbbb-2222-2222-2222-222222222222'
        const oldSession = cache.getOrCreateSession(
            'tag-dual-old',
            { path: '/a', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            oldId
        )
        const newSession = cache.getOrCreateSession(
            'tag-dual-new',
            { path: '/b', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            newId
        )
        expect(oldSession.id).toBe(oldId)
        expect(newSession.id).toBe(newId)

        store.sessionJobs.upsert(newSession.id, 'beets', {
            label: 'target-live',
            status: 'running',
            remaining: 9
        }, 1_000)
        store.sessionJobs.upsert(oldSession.id, 'beets', {
            label: 'source-live',
            status: 'running',
            remaining: 3
        }, 2_000)

        await cache.mergeSessionHistory(oldSession.id, newSession.id, 'default', {
            mergeAgentState: false
        })

        const onTarget = store.sessionJobs.list(newSession.id)
        expect(onTarget).toHaveLength(2)
        const refreshed = cache.refreshSession(newSession.id)
        expect(refreshed?.metadata?.jobKeyRedirects).toEqual({
            [`${oldId}/beets`]: 'beets.aaaaaaaa'
        })
        expect(
            cache.resolveAttachedJobKey(oldId, newId, 'beets', 'default')
        ).toBe('beets.aaaaaaaa')
        expect(
            cache.resolveAttachedJobKey(newId, newId, 'beets', 'default')
        ).toBe('beets')

        // Terminal update via pre-merge session id + original key touches only the remapped row.
        const patched = store.sessionJobs.patch(
            newId,
            cache.resolveAttachedJobKey(oldId, newId, 'beets', 'default'),
            { status: 'completed' },
            3_000
        )
        expect(patched?.key).toBe('beets.aaaaaaaa')
        expect(patched?.status).toBe('completed')
        expect(store.sessionJobs.get(newId, 'beets')?.status).toBe('running')
    })
})
