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

    it('clears cached teamState when a null teamState patch lands (TeamDelete)', () => {
        // PR #897 review (HAPI Bot, 2026-06-13 Major): TeamDelete events
        // drive applyTeamStateDelta to return null; the emit-site sends
        // { teamState: null } as the explicit clear signal. Without
        // hasOwnProperty-discrimination, `if (patch.teamState !== undefined)`
        // skipped the clear path and left the hub cache holding stale
        // pre-delete TeamState — sidebar / NotificationHub / dedup all
        // would serve stale data until the next full refresh.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'teamstate-clear-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        // Seed cached teamState (the pre-delete state).
        const seedApplied = cache.applySessionPatch(created.id, {
            teamState: { teamName: 'crew', members: [{ name: 'a' }] }
        })
        expect(seedApplied).toBe(true)
        expect(cache.getSession(created.id)?.teamState?.teamName).toBe('crew')

        // TeamDelete: null teamState patch must clear the cache.
        const cleared = cache.applySessionPatch(created.id, { teamState: null })
        expect(cleared).toBe(true)
        expect(cache.getSession(created.id)?.teamState).toBeUndefined()
    })

    it('leaves teamState untouched when the patch does not carry the key', () => {
        // Guard the hasOwnProperty discriminator against a refactor back to
        // `if (patch.teamState !== undefined)` — a todos-only patch must
        // NOT clear teamState, which a naive `?? undefined` assignment on
        // the unconditional branch would do.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'teamstate-untouched-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        cache.applySessionPatch(created.id, {
            teamState: { teamName: 'crew', members: [{ name: 'a' }] }
        })
        expect(cache.getSession(created.id)?.teamState?.teamName).toBe('crew')

        const todosOnly = cache.applySessionPatch(created.id, {
            todos: [{ content: 'one', status: 'pending' as const, priority: 'medium' as const, id: '1' }]
        })
        expect(todosOnly).toBe(true)
        expect(cache.getSession(created.id)?.teamState?.teamName).toBe('crew')
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
