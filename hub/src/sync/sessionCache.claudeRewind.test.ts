import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

/**
 * A stored metadata blob whose `claudeRewind` carries a legacy or garbage shape
 * must not nuke the whole session metadata: SessionCache.refreshSession parses
 * via MetadataSchema and used to store metadata = null (flavor, machine, path,
 * lifecycle all lost) when the intent alone was malformed.
 */
function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => events.push(event)
    } as unknown as EventPublisher
}

describe('SessionCache.refreshSession claudeRewind tolerance', () => {
    it('keeps the rest of the metadata when the stored claudeRewind has a legacy shape', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'claude-rewind-legacy-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        const stored = store.sessions.getSession(created.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
        expect(stored?.metadata).toBeTruthy()

        store.sessions.updateSessionMetadata(
            created.id,
            {
                ...(stored?.metadata ?? {}),
                claudeRewind: {
                    operationId: 'op-1',
                    phase: 'pending',
                    requestedLocalId: 'local-1',
                    truncateFromLocalId: 'local-1',
                    keepBoundary: 'boundary-uuid',
                    cutoffSeq: 7
                }
            },
            (stored?.metadataVersion ?? 1) as number,
            'default'
        )

        const refreshed = cache.refreshSession(created.id)
        expect(refreshed?.metadata).not.toBeNull()
        expect(refreshed?.metadata?.flavor).toBe('claude')
        expect(refreshed?.metadata?.path).toBe('/tmp/project')
        expect(refreshed?.metadata?.claudeRewind).toBeUndefined()
    })

    it('keeps the rest of the metadata when the stored claudeRewind is garbage', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))
        const created = cache.getOrCreateSession(
            'claude-rewind-garbage-' + Math.random().toString(36).slice(2, 8),
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        const stored = store.sessions.getSession(created.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }

        store.sessions.updateSessionMetadata(
            created.id,
            { ...(stored?.metadata ?? {}), claudeRewind: 'legacy' },
            (stored?.metadataVersion ?? 1) as number,
            'default'
        )

        const refreshed = cache.refreshSession(created.id)
        expect(refreshed?.metadata).not.toBeNull()
        expect(refreshed?.metadata?.flavor).toBe('claude')
        expect(refreshed?.metadata?.claudeRewind).toBeUndefined()
    })
})
