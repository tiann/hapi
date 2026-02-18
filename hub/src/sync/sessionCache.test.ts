import { describe, expect, it } from 'bun:test'
import type { Session, SyncEvent } from '@hapi/protocol/types'
import { SessionCache } from './sessionCache'
import type { Store } from '../store'
import { EventPublisher } from './eventPublisher'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        ...overrides
    }
}

function createTestCache() {
    const events: SyncEvent[] = []

    const store = {
        sessions: {
            getSession: (id: string) => makeSession(id),
            getSessions: () => [],
            getOrCreateSession: () => makeSession('test'),
            setSessionTodos: () => false
        },
        messages: {
            getMessages: () => []
        }
    } as unknown as Store

    const sseManager = new SSEManager(0, new VisibilityTracker())
    const publisher = new EventPublisher(sseManager, () => 'default')
    publisher.subscribe((event) => events.push(event))

    const cache = new SessionCache(store, publisher)

    return { cache, events }
}

describe('SessionCache thinking state', () => {
    it('handleSessionAlive broadcasts thinking state changes', () => {
        const { cache, events } = createTestCache()
        const now = Date.now()

        // First alive: session becomes active with thinking=true
        cache.handleSessionAlive({ sid: 's1', time: now, thinking: true })

        const thinkingEvent = events.find(
            e => e.type === 'session-updated' && e.sessionId === 's1' && (e as any).data?.thinking === true
        )
        expect(thinkingEvent).toBeDefined()
    })

    it('handleSessionAlive broadcasts when thinking changes to false', () => {
        const { cache, events } = createTestCache()
        const now = Date.now()

        cache.handleSessionAlive({ sid: 's1', time: now, thinking: true })
        events.length = 0 // clear previous events

        cache.handleSessionAlive({ sid: 's1', time: now + 1000, thinking: false })

        const event = events.find(
            e => e.type === 'session-updated' && e.sessionId === 's1' && (e as any).data?.thinking === false
        )
        expect(event).toBeDefined()
    })

    it('expireInactive broadcasts thinking:false alongside active:false', () => {
        const { cache, events } = createTestCache()
        const now = Date.now()

        // Make session active and thinking
        cache.handleSessionAlive({ sid: 's1', time: now, thinking: true })
        events.length = 0

        // Expire it (31s later)
        cache.expireInactive(now + 31_000)

        // Should have broadcast with BOTH active:false AND thinking:false
        const expireEvent = events.find(
            e => e.type === 'session-updated' && e.sessionId === 's1'
        )
        expect(expireEvent).toBeDefined()
        expect((expireEvent as any).data.active).toBe(false)
        expect((expireEvent as any).data.thinking).toBe(false)
    })

    it('REGRESSION: expireInactive without thinking:false leaves UI showing spinner', () => {
        // This test verifies the fix. Before the fix, expireInactive
        // broadcast { active: false } without thinking: false, so the
        // web UI would keep showing the thinking spinner.
        const { cache, events } = createTestCache()
        const now = Date.now()

        cache.handleSessionAlive({ sid: 's1', time: now, thinking: true })
        events.length = 0

        cache.expireInactive(now + 31_000)

        const expireEvent = events.find(
            e => e.type === 'session-updated' && e.sessionId === 's1'
        )
        // The critical assertion: thinking MUST be explicitly false in the broadcast
        expect((expireEvent as any).data).toHaveProperty('thinking', false)
    })

    it('handleSessionEnd broadcasts thinking:false', () => {
        const { cache, events } = createTestCache()
        const now = Date.now()

        cache.handleSessionAlive({ sid: 's1', time: now, thinking: true })
        events.length = 0

        cache.handleSessionEnd({ sid: 's1', time: now + 1000 })

        const endEvent = events.find(
            e => e.type === 'session-updated' && e.sessionId === 's1'
        )
        expect(endEvent).toBeDefined()
        expect((endEvent as any).data.active).toBe(false)
        expect((endEvent as any).data.thinking).toBe(false)
    })

    it('does not expire sessions within timeout window', () => {
        const { cache, events } = createTestCache()
        const now = Date.now()

        cache.handleSessionAlive({ sid: 's1', time: now, thinking: true })
        events.length = 0

        // Only 10s later — within 30s timeout
        cache.expireInactive(now + 10_000)

        // No expiration events
        const expireEvents = events.filter(
            e => e.type === 'session-updated' && (e as any).data?.active === false
        )
        expect(expireEvents).toHaveLength(0)
    })
})
