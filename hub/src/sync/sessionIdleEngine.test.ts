import { describe, expect, it, mock, setSystemTime } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

/**
 * tiann/hapi#1820 at the SyncEngine level. `sessionIdle.test.ts` pins the
 * pure rules and the cache; these tests drive the engine entry points the
 * hub actually wires (activity, sends, abort, the inactivity tick) and check
 * that only real agent progress moves the lifecycle.
 */

const HOUR = 60 * 60 * 1000

const RUNNING = { path: '/tmp/project', host: 'localhost', flavor: 'claude', lifecycleState: 'running' } as const

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

function withIdleWindow<T>(windowMs: number, run: () => T): T {
    const previous = process.env.HAPI_SESSION_IDLE_TIMEOUT_MS
    process.env.HAPI_SESSION_IDLE_TIMEOUT_MS = String(windowMs)
    try {
        return run()
    } finally {
        if (previous === undefined) {
            delete process.env.HAPI_SESSION_IDLE_TIMEOUT_MS
        } else {
            process.env.HAPI_SESSION_IDLE_TIMEOUT_MS = previous
        }
    }
}

describe('SyncEngine keepalive-idle tick', () => {
    it('a replayed old activity timestamp does not wake an idle session, a new one does', () => {
        withIdleWindow(HOUR, () => {
            const { store, engine } = createEngine()
            try {
                const session = engine.getOrCreateSession('replay', RUNNING, null, 'default')
                const startedAt = Date.now()
                engine.handleSessionAlive({ sid: session.id, time: startedAt })
                setSystemTime(new Date(startedAt + 2 * HOUR))
                engine.handleSessionAlive({ sid: session.id, time: Date.now() })
                ;(engine as unknown as { expireInactive(): void }).expireInactive()
                expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('idle')

                // A metadata write moved updatedAt to now; a history replay then reports
                // activity from before the idle window.
                const current = store.sessions.getSessionByNamespace(session.id, 'default')!
                const renamed = store.sessions.updateSessionMetadata(session.id, { ...current.metadata!, name: 'renamed' }, current.metadataVersion, 'default')
                expect(renamed.result).toBe('success')
                expect(store.sessions.getSession(session.id)!.updatedAt).toBeGreaterThan(startedAt)
                engine.recordSessionActivity(session.id, startedAt)
                ;(engine as unknown as { expireInactive(): void }).expireInactive()
                expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('idle')

                // Genuine new activity still wakes it.
                engine.recordSessionActivity(session.id, Date.now())
                ;(engine as unknown as { expireInactive(): void }).expireInactive()
                expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('running')
            } finally {
                setSystemTime()
                engine.stop()
            }
        })
    })

    it('a duplicate send of an already consumed message neither queues a turn nor counts as progress', async () => {
        // sendMessage emits to the CLI namespace: give the engine a socket.io stand-in.
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('retry', RUNNING, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now() })
            const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
            const queued = mock(cache.markMessageQueued.bind(cache)); cache.markMessageQueued = queued
            const activity = mock(cache.recordSessionActivity.bind(cache)); cache.recordSessionActivity = activity

            await engine.sendMessage(session.id, { text: 'hello', localId: 'retry-1' })
            expect(queued).toHaveBeenCalledTimes(1)
            // Still queued: a deliberate retry re-arms the grace window (aliveEvents.test.ts).
            await engine.sendMessage(session.id, { text: 'hello', localId: 'retry-1' })
            expect(queued).toHaveBeenCalledTimes(2)

            // Consumed by the agent: a late duplicate of the same POST changes nothing.
            expect(store.messages.markMessagesInvoked(session.id, ['retry-1'], Date.now())).toBe(1)
            const before = activity.mock.calls.length
            await engine.sendMessage(session.id, { text: 'hello', localId: 'retry-1' })
            expect(queued).toHaveBeenCalledTimes(2)
            // The message service still reports the stored row's own time (harmless:
            // the progress clock only moves forward); no "now" activity is recorded.
            const createdAt = store.messages.getAllMessages(session.id)[0]!.createdAt
            expect(activity.mock.calls.slice(before)).toEqual([[session.id, createdAt]])
        } finally {
            engine.stop()
        }
    })

    it('abort forgets background tasks so the session can reconcile idle', async () => {
        const { engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('abort', RUNNING, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            engine.handleBackgroundTaskDelta(session.id, { started: 1, completed: 0 })
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect(engine.getSession(session.id)?.backgroundTaskCount).toBe(1)
            const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
            const later = Date.now() + 87 * HOUR
            // A counter that can never be closed pins the session on "working".
            expect(cache.reconcileKeepaliveIdle(later, 12 * HOUR)).toEqual([])
            // Web clients have rendered the counter and only a `session-updated`
            // patch takes it back (the alive broadcast does not carry it).
            const events: SyncEvent[] = []
            engine.subscribe((event) => { events.push(event) })
            const cleared = () => events.filter((e) => e.type === 'session-updated' && e.data?.backgroundTaskCount === 0)

            const gateway = (engine as unknown as { rpcGateway: { abortSession: unknown } }).rpcGateway
            // The CLI refuses (no handler): nothing was killed, keep the count.
            gateway.abortSession = mock(async () => { throw new Error('handler-not-registered') })
            await expect(engine.abortSession(session.id)).rejects.toThrow()
            expect(engine.getSession(session.id)?.backgroundTaskCount).toBe(1)
            expect(cleared()).toHaveLength(0)

            // The CLI acknowledged: its process tree, background shells
            // included, is gone and no <task-notification> will follow.
            gateway.abortSession = mock(async () => {})
            await engine.abortSession(session.id)
            expect(engine.getSession(session.id)?.backgroundTaskCount).toBe(0)
            expect(cleared()).toHaveLength(1)
            expect(cache.reconcileKeepaliveIdle(later, 12 * HOUR)).toEqual([session.id])
        } finally {
            engine.stop()
        }
    })
})
