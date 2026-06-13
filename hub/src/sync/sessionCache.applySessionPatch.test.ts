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

// Companion guard for syncEngine.handleRealtimeEvent's new "forward structured
// patches without DB refresh" branch (closes the second half of #884). The
// hub-side fast-path is only safe if applySessionPatch keeps the in-memory
// cache consistent with what just landed in the DB — otherwise subsequent
// callers like NotificationHub.getSession would see stale data and the
// cache-vs-DB divergence would manifest as ghost notifications, stale
// pendingRequestsCount, or wrong todos progress in the session list.
describe('SessionCache.applySessionPatch', () => {
    it('applies a todos patch in place when the session is cached', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'todos-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        const todos = [
            { content: 'one', status: 'pending' as const, priority: 'medium' as const, id: '1' }
        ]
        const applied = cache.applySessionPatch(created.id, { todos })

        expect(applied).toBe(true)
        expect(cache.getSession(created.id)?.todos).toEqual(todos)
    })

    it('applies a versioned metadata patch by unwrapping value + version', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'meta-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        const nextVersion = created.metadataVersion + 1
        const applied = cache.applySessionPatch(created.id, {
            metadata: {
                version: nextVersion,
                value: { path: '/tmp', host: 'h', lifecycleState: 'archived' }
            }
        })

        expect(applied).toBe(true)
        const after = cache.getSession(created.id)
        expect(after?.metadata?.lifecycleState).toBe('archived')
        expect(after?.metadataVersion).toBe(nextVersion)
    })

    it('applies a versioned agentState patch with null value', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'agent-patch-session',
            { path: '/tmp', host: 'h' },
            { controlledByUser: true },
            'default'
        )
        expect(created.agentState).not.toBeNull()

        const nextVersion = created.agentStateVersion + 1
        const applied = cache.applySessionPatch(created.id, {
            agentState: { version: nextVersion, value: null }
        })

        expect(applied).toBe(true)
        const after = cache.getSession(created.id)
        expect(after?.agentState).toBeNull()
        expect(after?.agentStateVersion).toBe(nextVersion)
    })

    it('returns false (caller falls back to refresh) when the session is not cached', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const applied = cache.applySessionPatch('does-not-exist', { todos: [] })
        expect(applied).toBe(false)
    })

    it('returns false when patch data fails SessionPatchSchema', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'bad-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        // Bogus shape: { metadata: { value: ... } } is missing the required version.
        const applied = cache.applySessionPatch(created.id, {
            metadata: { value: { path: '/x', host: 'y' } }
        })
        expect(applied).toBe(false)
    })

    it('refuses an empty patch ({}) so the caller falls back to refreshSession', () => {
        // Web-side getSessionPatch rejects empty payloads (Object.keys length 0)
        // and would fall through to REST invalidation — exactly the storm we
        // are closing. The empty-patch guard keeps the syncEngine on the safe
        // legacy refresh path for these no-op events.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'empty-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        expect(cache.applySessionPatch(created.id, {})).toBe(false)
    })

    it('refuses cross-namespace patches even if the session exists', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'ns-guard-session',
            { path: '/tmp', host: 'h' },
            null,
            'tenant-a'
        )

        const applied = cache.applySessionPatch(created.id, { todos: [] }, 'tenant-b')
        expect(applied).toBe(false)
    })
})
