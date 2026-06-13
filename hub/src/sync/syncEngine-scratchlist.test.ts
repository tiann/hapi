import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

/**
 * Tests for scratchlist v2 (tiann/hapi#893) wiring at the SyncEngine /
 * SessionCache layer:
 *   - every successful mutation emits a `session-updated` SyncEvent
 *     carrying `scratchlistUpdatedAt`
 *   - failed mutations (entry not found, duplicate) emit nothing
 *   - the patch is namespace-scoped to the session's own namespace so
 *     the SSE manager doesn't broadcast across operators
 *
 * The web client uses the patch as a refetch trigger; the timestamp
 * itself is the only signal, the entries arrive via the dedicated
 * `/api/sessions/:id/scratchlist` GET endpoint.
 */

function createCapturingPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('SessionCache.emitScratchlistChanged', () => {
    it('emits a session-updated patch carrying scratchlistUpdatedAt', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createCapturingPublisher(events))
        const session = cache.getOrCreateSession(
            'tag',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        // Drain spawn events so we can assert on the scratchlist
        // emission alone.
        events.length = 0

        cache.emitScratchlistChanged(session.id, 9999)

        expect(events).toHaveLength(1)
        const event = events[0]!
        expect(event.type).toBe('session-updated')
        if (event.type !== 'session-updated') throw new Error('unreachable')
        expect(event.sessionId).toBe(session.id)
        expect(event.namespace).toBe('default')
        expect(event.data).toEqual({ scratchlistUpdatedAt: 9999 })
    })

    it('does not emit when the session is unknown (no namespace to scope to)', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createCapturingPublisher(events))
        cache.emitScratchlistChanged('does-not-exist', 9999)
        expect(events).toHaveLength(0)
    })
})

describe('SyncEngine scratchlist mutations emit session-updated patches', () => {
    function setup() {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createCapturingPublisher(events))
        // We attach the EventPublisher to SyncEngine via a private field
        // path so the route-layer surface (createScratchlistEntry, etc.)
        // exercises the same code path used in production. We only need
        // the cache for `getOrCreateSession`; the engine reuses the
        // store internally.
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        // SyncEngine constructs its own SessionCache internally - shimming
        // the inner one would be brittle. Use the engine's events stream
        // directly via subscription.
        const engineEvents: SyncEvent[] = []
        engine.subscribe((e) => { engineEvents.push(e) })
        return { engine, store, events, cache, engineEvents }
    }

    it('createScratchlistEntry emits a session-updated patch on success', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-create',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        // Drain events from the spawn so we can assert on the mutation
        // emission alone.
        engineEvents.length = 0

        const result = engine.createScratchlistEntry(session.id, 'note', { entryId: 'e1' })
        expect(result.outcome).toBe('created')

        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(1)
        const patch = matching[0]
        if (!patch || patch.type !== 'session-updated') throw new Error('unreachable')
        expect(patch.sessionId).toBe(session.id)
        expect(patch.namespace).toBe('default')

        engine.stop()
    })

    it('updateScratchlistEntry emits a session-updated patch on success', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-update',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'before', { entryId: 'e1' })
        engineEvents.length = 0

        const updated = engine.updateScratchlistEntry(session.id, 'e1', 'after')
        expect(updated).not.toBeNull()
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(1)

        engine.stop()
    })

    it('updateScratchlistEntry on a missing entry emits nothing', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-update-missing',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engineEvents.length = 0
        const updated = engine.updateScratchlistEntry(session.id, 'never-existed', 'whatever')
        expect(updated).toBeNull()
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(0)
        engine.stop()
    })

    it('deleteScratchlistEntry emits a session-updated patch on success', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-delete',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'doomed', { entryId: 'e1' })
        engineEvents.length = 0
        const removed = engine.deleteScratchlistEntry(session.id, 'e1')
        expect(removed).toBe(true)
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(1)
        engine.stop()
    })

    it('deleteScratchlistEntry on a missing entry emits nothing', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-delete-missing',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engineEvents.length = 0
        const removed = engine.deleteScratchlistEntry(session.id, 'no-such-entry')
        expect(removed).toBe(false)
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(0)
        engine.stop()
    })

    it('createScratchlistEntry on duplicate does not emit an extra patch', () => {
        const { engine, engineEvents } = setup()
        const session = engine.getOrCreateSession(
            'tag-dup',
            { path: '/tmp', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        engine.createScratchlistEntry(session.id, 'first', { entryId: 'dup' })
        engineEvents.length = 0
        const result = engine.createScratchlistEntry(session.id, 'second', { entryId: 'dup' })
        if (result.outcome === 'session-not-found') throw new Error('unexpected')
        expect(result.outcome).toBe('duplicate')
        const matching = engineEvents.filter(
            (e) => e.type === 'session-updated' && (e.data as Record<string, unknown>).scratchlistUpdatedAt !== undefined
        )
        expect(matching).toHaveLength(0)
        engine.stop()
    })
})
