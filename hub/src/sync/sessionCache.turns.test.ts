import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function setup() {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const publisher = { emit: (event: SyncEvent) => { events.push(event) } } as unknown as EventPublisher
    const cache = new SessionCache(store, publisher)
    const session = cache.getOrCreateSession(
        'turns-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'mac', flavor: 'claude' },
        null,
        'default'
    )
    return { store, cache, session }
}

function turns(store: Store) {
    return store.turns.list('default', 0, Date.now() + 60_000)
}

describe('SessionCache turn recording', () => {
    it('records a turn from thinking on to thinking off', () => {
        const { store, cache, session } = setup()
        try {
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect(turns(store)).toEqual([])

            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            expect(turns(store)).toHaveLength(1)
            expect(turns(store)[0]).toMatchObject({ trigger: 'agent', endedAt: null })

            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect(turns(store)[0]).toMatchObject({ endReason: 'idle' })
            expect(turns(store)[0]?.endedAt).not.toBeNull()
        } finally {
            store.close()
        }
    })

    it('starts a turn when a prompt is queued through the hub', () => {
        const { store, cache, session } = setup()
        try {
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            const sentAt = Date.now() - 2_000
            cache.markMessageQueued(session.id, Date.now(), sentAt)

            expect(turns(store)).toHaveLength(1)
            expect(turns(store)[0]).toMatchObject({ trigger: 'hub_prompt', startedAt: sentAt, endedAt: null })
            // The agent picking it up doesn't start another one.
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            expect(turns(store)).toHaveLength(1)
        } finally {
            store.close()
        }
    })

    it('ends the turn when the session ends', () => {
        const { store, cache, session } = setup()
        try {
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            cache.handleSessionEnd({ sid: session.id, time: Date.now() })
            expect(turns(store)[0]).toMatchObject({ endReason: 'session_end' })
        } finally {
            store.close()
        }
    })

    it('ends an expired turn at the last keepalive, not when it was noticed', () => {
        const { store, cache, session } = setup()
        try {
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            const lastKeepalive = cache.getSession(session.id)!.activeAt
            cache.expireInactive(lastKeepalive + 301_000)
            expect(turns(store)[0]).toMatchObject({ endReason: 'expired', endedAt: lastKeepalive })
        } finally {
            store.close()
        }
    })

    it('records thinking changes that arrive as patches', () => {
        const { store, cache, session } = setup()
        try {
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect(cache.applySessionPatch(session.id, { thinking: true })).toBe(true)
            expect(turns(store)[0]).toMatchObject({ trigger: 'patch', endedAt: null })
            expect(cache.applySessionPatch(session.id, { thinking: false })).toBe(true)
            expect(turns(store)[0]?.endedAt).not.toBeNull()
        } finally {
            store.close()
        }
    })

    function restart(store: Store): SessionCache {
        const restarted = new SessionCache(store, { emit: () => {} } as unknown as EventPublisher)
        restarted.closeTurnsLeftOpen()
        restarted.reloadAll()
        return restarted
    }

    it('continues a turn a hub restart cut short, however long the agent was quiet before it', () => {
        const { store, session } = setup()
        try {
            // A command ran for 30 minutes without a message, then the hub restarted.
            const startedAt = Date.now() - 30 * 60_000
            store.turns.open(session.id, 'default', startedAt, 'agent')
            store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'running tests' } }, undefined, null, startedAt + 60_000)

            const restarted = restart(store)
            restarted.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            expect(turns(store)).toHaveLength(1)
            expect(turns(store)[0]).toMatchObject({ startedAt, endedAt: null })
        } finally {
            store.close()
        }
    })

    it('preserves a stored footer when the agent resumes a turn a hub restart cut short (#1717 cold-review round 32)', () => {
        // The old process set a footer before it died mid-turn. On restart,
        // the fresh in-memory cache's `thinking` defaults to false, so the
        // runner's first keepalive (still `thinking: true`, genuinely
        // continuing the SAME interrupted turn) looks like an ordinary
        // false-to-true rising edge — which `markSessionActive`'s own
        // "a new turn invalidates the agent's last self-report" rule would
        // otherwise clear. `recordTurn` already distinguishes a genuine
        // resume from a new turn for its OWN bookkeeping; the clear must
        // respect that same distinction instead of re-deriving it (and
        // getting it wrong) from the bare `thinking` transition alone.
        const { store, session } = setup()
        try {
            store.sessions.setSessionLastNotify(session.id, {
                status: 'blocked', at: Date.now() - 60_000, note: 'needs creds'
            }, 'default')
            store.turns.open(session.id, 'default', Date.now() - 60_000, 'agent')

            const restarted = restart(store)
            restarted.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })

            expect(turns(store)).toHaveLength(1)
            expect(turns(store)[0]).toMatchObject({ endedAt: null })
            expect(restarted.getSession(session.id)?.lastNotify?.status).toBe('blocked')
        } finally {
            store.close()
        }
    })

    it('starts a new turn once the agent was seen idle after a restart', () => {
        const { store, session } = setup()
        try {
            store.turns.open(session.id, 'default', Date.now() - 60_000, 'agent')
            const restarted = restart(store)
            restarted.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            restarted.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })

            expect(turns(store)).toHaveLength(2)
            expect(turns(store)[0]?.endReason).toBe('hub_restart')
            expect(turns(store)[1]?.endedAt).toBeNull()
        } finally {
            store.close()
        }
    })

    it('starts a new turn for a prompt sent after a restart', () => {
        const { store, session } = setup()
        try {
            store.turns.open(session.id, 'default', Date.now() - 60_000, 'agent')
            const restarted = restart(store)
            restarted.markSessionActive(session.id)
            restarted.markMessageQueued(session.id)

            expect(turns(store)).toHaveLength(2)
            expect(turns(store)[0]?.endReason).toBe('hub_restart')
            expect(turns(store)[1]).toMatchObject({ trigger: 'hub_prompt', endedAt: null })
        } finally {
            store.close()
        }
    })

    it('keeps a merged-away session\'s turns', async () => {
        const { store, cache, session } = setup()
        const replacement = cache.getOrCreateSession('turns-new', { path: '/tmp/project', host: 'mac', flavor: 'claude' }, null, 'default')
        try {
            cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            cache.handleSessionEnd({ sid: session.id, time: Date.now() })
            await cache.mergeSessions(session.id, replacement.id, 'default')
            expect(turns(store).map((turn) => turn.sessionId)).toEqual([replacement.id])
        } finally {
            store.close()
        }
    })
})
