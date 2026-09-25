import { describe, expect, it, spyOn } from 'bun:test'
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

    it('follows seven OpenCode clear replacements (no five-hop cap) for PATCH', async () => {
        const { store, cache } = setup()
        const sessions = Array.from({ length: 8 }, (_, i) =>
            cache.getOrCreateSession(
                `agent-clear-chain-${i}-` + Math.random().toString(36).slice(2, 8),
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
        )
        // s0→s1→…→s7 via supersededBySessionId (retained /clear archives).
        for (let i = 0; i < sessions.length - 1; i += 1) {
            const cur = sessions[i]!
            const next = sessions[i + 1]!
            const stored = store.sessions.getSessionByNamespace(cur.id, 'default')!
            const meta = {
                ...(stored.metadata as Record<string, unknown>),
                supersededBySessionId: next.id,
                lifecycleState: 'archived',
                archiveReason: 'Cleared by /clear'
            }
            store.sessions.updateSessionMetadata(cur.id, meta, stored.metadataVersion, 'default')
            cache.refreshSession(cur.id)
        }

        const origin = sessions[0]!
        const tip = sessions[sessions.length - 1]!
        const upserted = store.sessionJobs.upsert(tip.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 9
        })
        expect(upserted.outcome).toBe('upserted')
        const runId = upserted.outcome === 'upserted' ? upserted.job.runId : undefined

        expect(cache.resolveAttachedJobSessionId(origin.id, 'default')).toBe(tip.id)

        const ownerId = cache.resolveAttachedJobSessionId(origin.id, 'default')
        const patched = store.sessionJobs.patch(ownerId, 'beets', {
            remaining: 2,
            expectedRunId: runId
        })
        expect(patched.outcome).toBe('patched')
        expect(store.sessionJobs.get(tip.id, 'beets')?.remaining).toBe(2)
    })

    it('clears stale jobsTransferredToSessionId when A reclaims jobs from B (A→B then B→A)', async () => {
        const { store, cache } = setup()
        const a = cache.getOrCreateSession(
            'agent-jobs-reclaim-a-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const b = cache.getOrCreateSession(
            'agent-jobs-reclaim-b-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        store.sessionJobs.upsert(a.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 7
        })

        // A→B (kept-alive source keeps jobsTransferredToSessionId = B)
        await cache.mergeSessionHistory(a.id, b.id, 'default', { mergeAgentState: false })
        expect(cache.resolveAttachedJobSessionId(a.id, 'default')).toBe(b.id)
        expect(cache.refreshSession(a.id)?.metadata?.jobsTransferredToSessionId).toBe(b.id)

        // B→A reclaim: A becomes canonical again; must clear A's outgoing pointer
        // so resolve(A) does not hop A→B after B is deleted.
        await cache.mergeSessions(b.id, a.id, 'default')
        expect(store.sessions.getSession(b.id)).toBeNull()
        expect(store.sessionJobs.getPrimaryRunning(a.id)?.key).toBe('beets')

        const refreshedA = cache.refreshSession(a.id)
        expect(refreshedA?.metadata?.jobsTransferredToSessionId).toBeUndefined()
        expect(cache.resolveAttachedJobSessionId(a.id, 'default')).toBe(a.id)
        expect(cache.resolveAttachedJobSessionId(b.id, 'default')).toBe(a.id)

        // Original supervisor still holding A's HAPI_SESSION_ID remains patchable.
        const patched = store.sessionJobs.upsert(
            cache.resolveAttachedJobSessionId(a.id, 'default'),
            'beets',
            { label: 'beets import', status: 'running', remaining: 3, runId: store.sessionJobs.get(a.id, 'beets')?.runId }
        )
        expect(patched.outcome).toBe('upserted')
        expect(store.sessionJobs.get(a.id, 'beets')?.remaining).toBe(3)
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
        expect(patched.outcome).toBe('patched')
        if (patched.outcome !== 'patched') throw new Error('unreachable')
        expect(patched.job.key).toBe('beets.aaaaaaaa')
        expect(patched.job.status).toBe('completed')
        expect(store.sessionJobs.get(newId, 'beets')?.status).toBe('running')
    })

    it('keeps jobKeyRedirects when source contributes metadata during merge', async () => {
        const { store, cache } = setup()
        const oldId = 'cccccccc-3333-3333-3333-333333333333'
        const newId = 'dddddddd-4444-4444-4444-444444444444'
        const oldSession = cache.getOrCreateSession(
            'tag-meta-old',
            { path: '/a', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            oldId
        )
        const newSession = cache.getOrCreateSession(
            'tag-meta-new',
            { path: '/b', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            newId
        )

        // Source-only name forces mergeSessionMetadata to write (the clobber path).
        store.sessions.updateSessionMetadata(
            oldSession.id,
            { ...(oldSession.metadata as object), name: 'source-name-wins' },
            oldSession.metadataVersion,
            'default',
            { touchUpdatedAt: false }
        )

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

        const refreshed = cache.refreshSession(newSession.id)
        expect(refreshed?.metadata?.name).toBe('source-name-wins')
        expect(refreshed?.metadata?.jobKeyRedirects).toEqual({
            [`${oldId}/beets`]: 'beets.cccccccc'
        })
        expect(
            cache.resolveAttachedJobKey(oldId, newId, 'beets', 'default')
        ).toBe('beets.cccccccc')
    })

    it('composes inherited jobKeyRedirects through a second dual-running remap (A→B→C)', async () => {
        const { store, cache } = setup()
        const aId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        const bId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        const cId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
        const a = cache.getOrCreateSession(
            'tag-chain-a',
            { path: '/a', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            aId
        )
        const b = cache.getOrCreateSession(
            'tag-chain-b',
            { path: '/b', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            bId
        )
        const c = cache.getOrCreateSession(
            'tag-chain-c',
            { path: '/c', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            cId
        )

        store.sessionJobs.upsert(a.id, 'beets', { label: 'a-live', status: 'running' }, 1_000)
        store.sessionJobs.upsert(b.id, 'beets', { label: 'b-live', status: 'running' }, 2_000)

        await cache.mergeSessionHistory(a.id, b.id, 'default', { mergeAgentState: false })
        expect(cache.refreshSession(b.id)?.metadata?.jobKeyRedirects).toEqual({
            [`${aId}/beets`]: 'beets.aaaaaaaa'
        })

        // C already owns the intermediate remapped key — second collision.
        store.sessionJobs.upsert(c.id, 'beets.aaaaaaaa', {
            label: 'c-live-on-intermediate',
            status: 'running'
        }, 3_000)

        await cache.mergeSessionHistory(b.id, c.id, 'default', { mergeAgentState: false })

        const redirects = cache.refreshSession(c.id)?.metadata?.jobKeyRedirects as
            | Record<string, string>
            | undefined
        expect(redirects?.[`${bId}/beets.aaaaaaaa`]).toBe('beets.aaaaaaaa.bbbbbbbb')
        // A must follow the composed remap, not C's pre-existing intermediate key.
        expect(redirects?.[`${aId}/beets`]).toBe('beets.aaaaaaaa.bbbbbbbb')
        expect(
            cache.resolveAttachedJobKey(aId, cId, 'beets', 'default')
        ).toBe('beets.aaaaaaaa.bbbbbbbb')
        expect(store.sessionJobs.get(cId, 'beets.aaaaaaaa')?.label).toBe('c-live-on-intermediate')
        expect(store.sessionJobs.get(cId, 'beets.aaaaaaaa.bbbbbbbb')?.label).toBe('a-live')
    })

    it('composes identity maps from a no-collision A→B through a later B→C remap', async () => {
        const { store, cache } = setup()
        const aId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        const bId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        const cId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
        cache.getOrCreateSession(
            'tag-id-a',
            { path: '/a', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            aId
        )
        cache.getOrCreateSession(
            'tag-id-b',
            { path: '/b', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            bId
        )
        cache.getOrCreateSession(
            'tag-id-c',
            { path: '/c', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            cId
        )

        // A owns batch; B has no job — first transfer keeps the key.
        store.sessionJobs.upsert(aId, 'batch', {
            label: 'a-batch',
            status: 'running',
            runId: 'run-a'
        }, 1_000)

        await cache.mergeSessionHistory(aId, bId, 'default', { mergeAgentState: false })
        expect(cache.refreshSession(bId)?.metadata?.jobKeyRedirects).toEqual({
            [`${aId}/batch`]: 'batch'
        })
        expect(store.sessionJobs.get(bId, 'batch')?.label).toBe('a-batch')

        // C already has a live batch — second transfer remaps B's row.
        store.sessionJobs.upsert(cId, 'batch', {
            label: 'c-batch',
            status: 'running',
            runId: 'run-c'
        }, 2_000)

        await cache.mergeSessionHistory(bId, cId, 'default', { mergeAgentState: false })

        const redirects = cache.refreshSession(cId)?.metadata?.jobKeyRedirects as
            | Record<string, string>
            | undefined
        expect(redirects?.[`${bId}/batch`]).toBe('batch.bbbbbbbb')
        // Without the A→B identity map, A would still resolve to C's live `batch`.
        expect(redirects?.[`${aId}/batch`]).toBe('batch.bbbbbbbb')
        expect(
            cache.resolveAttachedJobKey(aId, cId, 'batch', 'default')
        ).toBe('batch.bbbbbbbb')
        expect(store.sessionJobs.get(cId, 'batch')?.label).toBe('c-batch')
        expect(store.sessionJobs.get(cId, 'batch.bbbbbbbb')?.label).toBe('a-batch')
    })

    it('honors identity redirect on corrective PUT without runId (no second key)', async () => {
        const { store, cache } = setup()
        const aId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        const bId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        cache.getOrCreateSession(
            'tag-corr-a',
            { path: '/a', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            aId
        )
        cache.getOrCreateSession(
            'tag-corr-b',
            { path: '/b', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            bId
        )

        store.sessionJobs.upsert(aId, 'batch', {
            label: 'a-batch',
            status: 'running',
            runId: 'run-a',
            startedAt: 1_000
        }, 1_000)

        await cache.mergeSessionHistory(aId, bId, 'default', { mergeAgentState: false })
        expect(cache.refreshSession(bId)?.metadata?.jobKeyRedirects).toEqual({
            [`${aId}/batch`]: 'batch'
        })

        // Corrective job set from merged-away A without runId must keep the
        // original row (and its runId), not allocate batch.<A>.
        const key = cache.resolveAttachedJobKeyForUpsert(
            aId,
            bId,
            'batch',
            'default',
            undefined
        )
        expect(key).toBe('batch')
        const upserted = store.sessionJobs.upsert(bId, key, {
            label: 'a-batch-corrected',
            status: 'running',
            startedAt: 500
        }, 2_000)
        expect(upserted.outcome).toBe('upserted')
        if (upserted.outcome !== 'upserted') throw new Error('unreachable')
        expect(upserted.job.key).toBe('batch')
        expect(upserted.job.runId).toBe('run-a')
        expect(upserted.job.label).toBe('a-batch-corrected')
        expect(upserted.job.startedAt).toBe(500)
        expect(store.sessionJobs.get(bId, 'batch.aaaaaaaa')).toBeNull()
        expect(cache.refreshSession(bId)?.metadata?.jobKeyRedirects).toEqual({
            [`${aId}/batch`]: 'batch'
        })
    })

    it('rolls back the job-row move when redirect metadata write fails', () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        store.sessionJobs.upsert(oldSession.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 12
        })

        const original = store.sessions.updateSessionMetadata.bind(store.sessions)
        spyOn(store.sessions, 'updateSessionMetadata').mockImplementation(
            (id, metadata, expectedVersion, namespace, options) => {
                const meta = metadata as Record<string, unknown> | null
                if (meta && typeof meta.jobsTransferredToSessionId === 'string') {
                    throw new Error('injected sqlite fail')
                }
                return original(id, metadata, expectedVersion, namespace, options)
            }
        )

        expect(() => {
            cache.transferAttachedJobs(oldSession.id, newSession.id, 'default')
        }).toThrow('injected sqlite fail')

        expect(store.sessionJobs.getPrimaryRunning(oldSession.id)?.key).toBe('beets')
        expect(store.sessionJobs.getPrimaryRunning(newSession.id)).toBeNull()
        expect(
            (store.sessions.getSession(oldSession.id)?.metadata as Record<string, unknown> | null)
                ?.jobsTransferredToSessionId
        ).toBeUndefined()
    })

    it('resolves + heartbeats via oldSessionId while scratchlist attachment I/O is still awaited', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        store.sessionJobs.upsert(oldSession.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 12,
            runId: 'run-mid-merge'
        })
        const created = store.scratchlist.create(oldSession.id, 'note with attachment', {
            entryId: 'note-1',
            attachments: [{
                id: 'att-1',
                filename: 'clip.png',
                mimeType: 'image/png',
                size: 4,
                path: `hub://scratchlist/${oldSession.id}/att-1-clip.png`
            }]
        })
        expect(created.outcome).toBe('created')

        let releaseGate!: () => void
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve
        })
        const storage = await import('../scratchlistAttachments/storage')
        const moveSpy = spyOn(storage, 'moveScratchlistAttachmentFilesForSession')
            .mockImplementation(async (_home, _ns, _from, _to, attachments) => {
                await gate
                return attachments
            })
        spyOn(storage, 'deleteScratchlistSessionAttachmentDir').mockResolvedValue(undefined)

        const mergePromise = cache.mergeSessionHistory(oldSession.id, newSession.id, 'default', {
            mergeAgentState: false
        })

        // Wait until merge is blocked inside attachment I/O (redirects already committed).
        for (let i = 0; i < 50 && moveSpy.mock.calls.length === 0; i += 1) {
            await Bun.sleep(10)
        }
        expect(moveSpy.mock.calls.length).toBeGreaterThan(0)

        // Cache must already follow the redirect — not wait for scratchlist I/O.
        expect(cache.resolveAttachedJobSessionId(oldSession.id, 'default')).toBe(newSession.id)
        const ownerId = cache.resolveAttachedJobSessionId(oldSession.id, 'default')
        const patched = store.sessionJobs.patch(ownerId, 'beets', {
            remaining: 11,
            expectedRunId: 'run-mid-merge'
        })
        expect(patched.outcome).toBe('patched')
        if (patched.outcome !== 'patched') throw new Error('unreachable')
        expect(patched.job.remaining).toBe(11)
        expect(store.sessionJobs.getPrimaryRunning(newSession.id)?.remaining).toBe(11)
        expect(store.sessionJobs.getPrimaryRunning(oldSession.id)).toBeNull()

        releaseGate()
        await mergePromise
        moveSpy.mockRestore()
    })

    it('remaps late PUT from merged-away session when target already has a different running generation', async () => {
        const { store, cache } = setup()
        const oldId = 'eeeeeeee-5555-5555-5555-555555555555'
        const newId = 'ffffffff-6666-6666-6666-666666666666'
        const oldSession = cache.getOrCreateSession(
            'tag-late-old',
            { path: '/a', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            oldId
        )
        const newSession = cache.getOrCreateSession(
            'tag-late-new',
            { path: '/b', host: 'local', flavor: 'codex' },
            null,
            'default',
            undefined,
            undefined,
            undefined,
            newId
        )

        // Target already owns a live meter; source has none at merge time.
        store.sessionJobs.upsert(newSession.id, 'beets', {
            label: 'target-live',
            status: 'running',
            remaining: 9,
            runId: 'run-target'
        }, 1_000)

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')
        expect(cache.resolveAttachedJobSessionId(oldId, 'default')).toBe(newId)
        expect(
            cache.resolveAttachedJobKey(oldId, newId, 'beets', 'default')
        ).toBe('beets')

        const remapped = cache.resolveAttachedJobKeyForUpsert(
            oldId,
            newId,
            'beets',
            'default',
            'run-late-source'
        )
        expect(remapped).toBe('beets.eeeeeeee')
        expect(
            cache.refreshSession(newId)?.metadata?.jobKeyRedirects
        ).toEqual({
            [`${oldId}/beets`]: 'beets.eeeeeeee'
        })

        const upserted = store.sessionJobs.upsert(newId, remapped, {
            label: 'source-late',
            status: 'running',
            remaining: 3,
            runId: 'run-late-source'
        }, 2_000)
        expect(upserted.outcome).toBe('upserted')
        expect(store.sessionJobs.get(newId, 'beets')?.runId).toBe('run-target')
        expect(store.sessionJobs.get(newId, 'beets')?.label).toBe('target-live')
        expect(store.sessionJobs.get(newId, 'beets.eeeeeeee')?.runId).toBe('run-late-source')

        // Free-key late registration records identity so a later dual-running
        // merge can compose (see next test). Further PUTs keep that key.
        const freeKey = cache.resolveAttachedJobKeyForUpsert(
            oldId,
            newId,
            'drain',
            'default',
            undefined
        )
        expect(freeKey).toBe('drain')
        expect(cache.refreshSession(newId)?.metadata?.jobKeyRedirects).toEqual({
            [`${oldId}/beets`]: 'beets.eeeeeeee',
            [`${oldId}/drain`]: 'drain'
        })
        expect(
            cache.resolveAttachedJobKeyForUpsert(oldId, newId, 'drain', 'default', undefined)
        ).toBe('drain')
    })

    it('persists late free-key identity so A→B→C collision remaps compose', async () => {
        const { store, cache } = setup()
        const aId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        const bId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        const cId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
        for (const [tag, id] of [
            ['tag-late-id-a', aId],
            ['tag-late-id-b', bId],
            ['tag-late-id-c', cId]
        ] as const) {
            cache.getOrCreateSession(
                tag,
                { path: `/${tag}`, host: 'local', flavor: 'codex' },
                null,
                'default',
                undefined,
                undefined,
                undefined,
                id
            )
        }

        // Empty A→B: no job rows, so merge records no key redirect.
        await cache.mergeSessionHistory(aId, bId, 'default', { mergeAgentState: false })
        expect(cache.refreshSession(bId)?.metadata?.jobKeyRedirects).toBeUndefined()

        // Late PUT while B's key is free — must persist A/batch→batch.
        const key = cache.resolveAttachedJobKeyForUpsert(
            aId,
            bId,
            'batch',
            'default',
            'run-late-a'
        )
        expect(key).toBe('batch')
        expect(cache.refreshSession(bId)?.metadata?.jobKeyRedirects).toEqual({
            [`${aId}/batch`]: 'batch'
        })
        store.sessionJobs.upsert(bId, key, {
            label: 'a-late',
            status: 'running',
            runId: 'run-late-a'
        }, 1_000)

        // C already runs batch — B→C remaps B's row and must compose A's identity.
        store.sessionJobs.upsert(cId, 'batch', {
            label: 'c-batch',
            status: 'running',
            runId: 'run-c'
        }, 2_000)
        await cache.mergeSessionHistory(bId, cId, 'default', { mergeAgentState: false })

        const redirects = cache.refreshSession(cId)?.metadata?.jobKeyRedirects as
            | Record<string, string>
            | undefined
        expect(redirects?.[`${bId}/batch`]).toBe('batch.bbbbbbbb')
        expect(redirects?.[`${aId}/batch`]).toBe('batch.bbbbbbbb')
        expect(cache.resolveAttachedJobKey(aId, cId, 'batch', 'default')).toBe('batch.bbbbbbbb')
        expect(store.sessionJobs.get(cId, 'batch')?.label).toBe('c-batch')
        expect(store.sessionJobs.get(cId, 'batch.bbbbbbbb')?.label).toBe('a-late')
    })

    it('late free-key PUT via retained B does not clobber composed A redirects on C', async () => {
        const { store, cache } = setup()
        const aId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        const bId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        const cId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
        for (const [tag, id] of [
            ['tag-retain-a', aId],
            ['tag-retain-b', bId],
            ['tag-retain-c', cId]
        ] as const) {
            cache.getOrCreateSession(
                tag,
                { path: `/${tag}`, host: 'local', flavor: 'codex' },
                null,
                'default',
                undefined,
                undefined,
                undefined,
                id
            )
        }

        store.sessionJobs.upsert(aId, 'batch', {
            label: 'a-batch',
            status: 'running',
            runId: 'run-a'
        }, 1_000)
        // Keep B alive after merges so a later PUT can still arrive via B.
        await cache.mergeSessionHistory(aId, bId, 'default', { mergeAgentState: false })
        expect(cache.refreshSession(bId)?.metadata?.jobKeyRedirects).toEqual({
            [`${aId}/batch`]: 'batch'
        })

        store.sessionJobs.upsert(cId, 'batch', {
            label: 'c-batch',
            status: 'running',
            runId: 'run-c'
        }, 2_000)
        await cache.mergeSessionHistory(bId, cId, 'default', { mergeAgentState: false })
        expect(
            cache.resolveAttachedJobKey(aId, cId, 'batch', 'default')
        ).toBe('batch.bbbbbbbb')

        // Late PUT through retained B for an unrelated free key must not
        // reimport B's stale A/batch→batch onto C.
        expect(
            cache.resolveAttachedJobKeyForUpsert(bId, cId, 'other', 'default', 'run-other')
        ).toBe('other')
        const redirects = cache.refreshSession(cId)?.metadata?.jobKeyRedirects as
            | Record<string, string>
            | undefined
        expect(redirects?.[`${aId}/batch`]).toBe('batch.bbbbbbbb')
        expect(redirects?.[`${bId}/batch`]).toBe('batch.bbbbbbbb')
        expect(redirects?.[`${bId}/other`]).toBe('other')
        expect(cache.resolveAttachedJobKey(aId, cId, 'batch', 'default')).toBe('batch.bbbbbbbb')
        expect(store.sessionJobs.get(cId, 'batch')?.label).toBe('c-batch')
        expect(store.sessionJobs.get(cId, 'batch.bbbbbbbb')?.label).toBe('a-batch')
    })
})
