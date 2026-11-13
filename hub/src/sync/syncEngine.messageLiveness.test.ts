import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import type { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const broadcast: SyncEvent[] = []
    const sseManager = { broadcast: (event: SyncEvent) => { broadcast.push(event) } } as unknown as SSEManager
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), sseManager)
    engine.stop()
    const sessionCache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
    return { engine, sessionCache, broadcast }
}

function seedSession(engine: SyncEngine, tag: string): string {
    const created = engine.getOrCreateSession(
        tag,
        { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        { requests: {}, completedRequests: {} },
        'default'
    )
    return created.id
}

function messageEvent(sessionId: string, id: string): SyncEvent {
    return {
        type: 'message-received',
        sessionId,
        message: { id, role: 'user', content: 'hello', createdAt: Date.now() }
    } as never as SyncEvent
}

function sessionUpdates(broadcast: SyncEvent[]): SyncEvent[] {
    return broadcast.filter((event) => event.type === 'session-updated')
}

/** Simulate the heartbeat channel dying: expire the cached liveness in place. */
function expireCachedLiveness(cache: SessionCache, sessionId: string, staleMs: number): void {
    const session = cache.getSession(sessionId)
    if (!session) throw new Error('session missing from cache')
    session.active = false
    session.activeAt = Date.now() - staleMs
}

describe('message-received re-touches session liveness', () => {
    it('marks an expired session active again when a message arrives', () => {
        const { engine, sessionCache } = createEngine()
        const sessionId = seedSession(engine, 'msg-liveness-1')

        // Heartbeat channel silent past the expiry window: the session reads
        // offline exactly like one swept by expireInactive().
        expireCachedLiveness(sessionCache, sessionId, 120_000)
        expect(sessionCache.getSession(sessionId)?.active).toBe(false)

        // ...yet the session is demonstrably still exchanging messages.
        engine.handleRealtimeEvent(messageEvent(sessionId, 'm1'))

        expect(sessionCache.getSession(sessionId)?.active).toBe(true)
    })

    it('re-touches at most once per window while messages keep streaming', () => {
        const { engine, sessionCache, broadcast } = createEngine()
        const sessionId = seedSession(engine, 'msg-liveness-2')

        expireCachedLiveness(sessionCache, sessionId, 120_000)
        broadcast.length = 0

        engine.handleRealtimeEvent(messageEvent(sessionId, 'm1'))
        expect(sessionCache.getSession(sessionId)?.active).toBe(true)
        const afterFirst = sessionUpdates(broadcast).length
        expect(afterFirst).toBeGreaterThan(0)

        // Same instant: guard suppresses the re-touch.
        engine.handleRealtimeEvent(messageEvent(sessionId, 'm2'))
        expect(sessionUpdates(broadcast)).toHaveLength(afterFirst)

        // Past the re-touch window the next message touches again.
        const touched = sessionCache.getSession(sessionId)
        if (!touched) throw new Error('session missing from cache')
        touched.activeAt = Date.now() - 6_000
        engine.handleRealtimeEvent(messageEvent(sessionId, 'm3'))
        expect(sessionUpdates(broadcast).length).toBeGreaterThan(afterFirst)
    })

    it('leaves a session with no traffic to the heartbeat expiry path', () => {
        const { engine, sessionCache } = createEngine()
        const sessionId = seedSession(engine, 'msg-liveness-3')

        expireCachedLiveness(sessionCache, sessionId, 120_000)

        // No messages arrive: the session stays honestly offline.
        expect(sessionCache.getSession(sessionId)?.active).toBe(false)
    })
})
