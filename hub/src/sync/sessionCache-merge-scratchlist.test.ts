import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

/**
 * Regression tests for tiann/hapi#920: scratchlist rows must survive
 * the `mergeSessionData` codepath in `SessionCache`.
 *
 * Background: `mergeSessionData` ends with `deleteSession(oldSessionId)`
 * which fires `ON DELETE CASCADE` on every FK-tied table. The
 * `session_scratchlist` table joins on `sessions(id)` with cascade
 * delete, so without an explicit transfer step every dedup
 * (#448 agent-id collision) and every resume-of-inactive path
 * (`syncEngine.resumeSession`) silently destroys the operator's notes.
 *
 * Two codepaths:
 *   - `mergeSessions(old, new, ns)` -> `mergeSessionData(deleteOld=true)`
 *   - `mergeSessionHistory(old, new, ns, opts)` -> `mergeSessionData(deleteOld=false)`
 *
 * Both must transfer scratchlist rows. We pin both with their own
 * happy-path test plus a PK-collision test (same `entryId` on both
 * sides; the dedup target wins).
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
        'agent-merge-old-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        ns
    )
    const newSession = cache.getOrCreateSession(
        'agent-merge-new-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        null,
        ns
    )
    return { oldSession, newSession }
}

describe('mergeSessions (deleteOldSession=true) - scratchlist transfer', () => {
    it('moves scratchlist rows from old to new before the cascade-delete fires', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)

        store.scratchlist.create(oldSession.id, 'note one', { entryId: 'e-1', createdAt: 100 })
        store.scratchlist.create(oldSession.id, 'note two', { entryId: 'e-2', createdAt: 200 })

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        // New session now owns the rows.
        const onNew = store.scratchlist.list(newSession.id).map((e) => e.entryId).sort()
        expect(onNew).toEqual(['e-1', 'e-2'])

        // Old session is gone (deleteOldSession=true) AND its rows
        // are not stranded on a phantom session id.
        expect(store.scratchlist.list(oldSession.id)).toEqual([])
    })

    it('handles entryId PK collision by keeping the dedup target row (operator-visible session wins)', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)

        // Both sessions have an entry at the same id - the new wins.
        store.scratchlist.create(oldSession.id, 'OLD copy', { entryId: 'shared-id', createdAt: 100 })
        store.scratchlist.create(newSession.id, 'NEW copy', { entryId: 'shared-id', createdAt: 200 })
        store.scratchlist.create(oldSession.id, 'unique to old', { entryId: 'old-only', createdAt: 50 })

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const final = store.scratchlist.list(newSession.id)
        const byId = new Map(final.map((e) => [e.entryId, e.text]))
        expect(byId.get('shared-id')).toBe('NEW copy')
        expect(byId.get('old-only')).toBe('unique to old')
        expect(final).toHaveLength(2)
    })

    it('emits scratchlistUpdatedAt on the new session (and not on the old one - it is about to be removed)', async () => {
        const { store, events, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        store.scratchlist.create(oldSession.id, 'note', { entryId: 'e-1', createdAt: 100 })
        events.length = 0

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const scratchPatches = events.filter((e) => {
            return e.type === 'session-updated'
                && typeof e.data === 'object' && e.data !== null
                && 'scratchlistUpdatedAt' in (e.data as Record<string, unknown>)
        })
        // Exactly one - on the new session id.
        expect(scratchPatches).toHaveLength(1)
        expect(scratchPatches[0]!.type === 'session-updated' && scratchPatches[0]!.sessionId).toBe(newSession.id)
    })

    it('is a no-op (no extra emit) when the old session has no scratchlist rows', async () => {
        const { events, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        events.length = 0

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const scratchPatches = events.filter((e) => {
            return e.type === 'session-updated'
                && typeof e.data === 'object' && e.data !== null
                && 'scratchlistUpdatedAt' in (e.data as Record<string, unknown>)
        })
        expect(scratchPatches).toHaveLength(0)
    })
})

describe('mergeSessionHistory (deleteOldSession=false) - scratchlist transfer', () => {
    it('moves scratchlist rows even when the old session row stays alive', async () => {
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)

        store.scratchlist.create(oldSession.id, 'still-need-this', { entryId: 'e-1', createdAt: 100 })

        // Active-duplicate codepath: keeps the live socket but moves
        // the persisted history into the dedup target. Scratchlist
        // is "persisted history" for this purpose.
        await cache.mergeSessionHistory(oldSession.id, newSession.id, 'default', { mergeAgentState: false })

        expect(store.scratchlist.list(newSession.id).map((e) => e.entryId)).toEqual(['e-1'])
        // Old row is still alive but its scratchlist is empty - the
        // operator-facing dedup target is now the source of truth.
        expect(store.scratchlist.list(oldSession.id)).toEqual([])
    })

    it('emits scratchlistUpdatedAt on BOTH the new and the still-alive old session id', async () => {
        const { store, events, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        store.scratchlist.create(oldSession.id, 'note', { entryId: 'e-1', createdAt: 100 })
        events.length = 0

        await cache.mergeSessionHistory(oldSession.id, newSession.id, 'default', { mergeAgentState: false })

        const scratchPatches = events.filter((e) => {
            return e.type === 'session-updated'
                && typeof e.data === 'object' && e.data !== null
                && 'scratchlistUpdatedAt' in (e.data as Record<string, unknown>)
        })
        // Two emits: one per session id, so any client looking at
        // either side invalidates and refetches.
        const ids = scratchPatches
            .map((e) => e.type === 'session-updated' ? e.sessionId : '')
            .sort()
        expect(ids).toEqual([oldSession.id, newSession.id].sort())
    })
})

describe('cascade-delete safety (regression)', () => {
    it('without the transfer, the cascade would have nuked them - confirm by deleting the new session at the end', async () => {
        // This is a smoke test for the ON DELETE CASCADE on
        // `session_scratchlist.session_id` itself: after the merge
        // moves rows to the new session and the new session is
        // later deleted (e.g. operator clicks Delete), the rows
        // disappear too. This is the cascade we DO want; the bug
        // is that the merge codepath was triggering it on the OLD
        // id while the operator expected the data to follow the
        // new id.
        const { store, cache } = setup()
        const { oldSession, newSession } = makeSessions(cache)
        store.scratchlist.create(oldSession.id, 'note', { entryId: 'e-1', createdAt: 100 })

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')
        expect(store.scratchlist.list(newSession.id)).toHaveLength(1)

        // Now an explicit operator-driven delete of the new session.
        // Mark it inactive first because deleteSession refuses to
        // delete an active session.
        const cached = cache.getSession(newSession.id)
        if (cached) cached.active = false
        await cache.deleteSession(newSession.id)
        expect(store.scratchlist.list(newSession.id)).toEqual([])
    })
})
