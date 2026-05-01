import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('alive incremental events', () => {
    it('includes active=true in session alive updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-alive-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        events.length = 0
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ active: true }))
    })

    it('emits full active machine object on machine alive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = cache.getOrCreateMachine(
            'machine-alive-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )

        events.length = 0
        cache.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const update = events.find((event) => event.type === 'machine-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'machine-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ id: machine.id, active: true }))
    })

    it('marks session thinking immediately when a user message is accepted by the hub', async () => {
        const store = new Store(':memory:')
        const emittedSocketUpdates: unknown[] = []
        const io = {
            of: () => ({
                to: () => ({
                    emit: (_event: string, payload: unknown) => {
                        emittedSocketUpdates.push(payload)
                    }
                })
            })
        }
        const engine = new SyncEngine(
            store,
            io as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const events: SyncEvent[] = []
        const unsubscribe = engine.subscribe((event) => {
            events.push(event)
        })

        try {
            const session = engine.getOrCreateSession(
                'session-send-thinking',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                { requests: {}, completedRequests: {} },
                'default'
            )

            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            const activeAtBeforeSend = engine.getSession(session.id)?.activeAt
            events.length = 0

            await engine.sendMessage(session.id, {
                text: 'hello from web',
                sentFrom: 'webapp'
            })

            expect(engine.getSession(session.id)?.thinking).toBe(true)
            expect(engine.getSession(session.id)?.activeAt).toBe(activeAtBeforeSend)
            expect(emittedSocketUpdates.length).toBeGreaterThan(0)

            const update = events.find((event) => {
                return event.type === 'session-updated'
                    && typeof event.data === 'object'
                    && event.data !== null
                    && (event.data as { thinking?: unknown }).thinking === true
            })
            expect(update).toBeDefined()
            if (!update || update.type !== 'session-updated') {
                return
            }

            expect(update.data).toEqual(expect.objectContaining({ thinking: true }))
            expect(update.data).not.toHaveProperty('activeAt')
            expect((update.data as { updatedAt?: unknown }).updatedAt).toEqual(expect.any(Number))
        } finally {
            unsubscribe()
            engine.stop()
        }
    })

    it('does not revive inactive sessions or refresh liveness when marking queued thinking', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = cache.getOrCreateSession(
            'session-queued-thinking-inactive',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.handleSessionEnd({ sid: session.id, time: now + 1_000 })
        const inactive = cache.getSession(session.id)
        expect(inactive?.active).toBe(false)
        const inactiveActiveAt = inactive?.activeAt

        events.length = 0
        cache.markMessageQueued(session.id, now + 2_000)

        const updated = cache.getSession(session.id)
        expect(updated?.active).toBe(false)
        expect(updated?.thinking).toBe(false)
        expect(updated?.activeAt).toBe(inactiveActiveAt)
        expect(events.find((event) => event.type === 'session-updated')).toBeUndefined()
    })

    it('keeps queued thinking true across false heartbeats during the grace window', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = cache.getOrCreateSession(
            'session-queued-thinking-grace',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        const originalNow = Date.now
        Date.now = () => now + 2_000
        try {
            cache.handleSessionAlive({ sid: session.id, time: now + 2_000, thinking: false })
        } finally {
            Date.now = originalNow
        }

        expect(cache.getSession(session.id)?.thinking).toBe(true)
        expect(events.find((event) => event.type === 'session-updated')).toBeUndefined()
    })

    it('clears queued thinking after the grace window expires', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = cache.getOrCreateSession(
            'session-queued-thinking-expire',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        cache.handleSessionAlive({ sid: session.id, time: now + 16_000, thinking: false })

        expect(cache.getSession(session.id)?.thinking).toBe(false)
        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }
        expect(update.data).toEqual(expect.objectContaining({ thinking: false }))
    })

    it('expires queued thinking against hub time instead of client heartbeat time', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()

        const session = cache.getOrCreateSession(
            'session-queued-thinking-clock-skew',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        const originalNow = Date.now
        Date.now = () => now + 16_000
        try {
            cache.handleSessionAlive({ sid: session.id, time: now - 60_000, thinking: false })
        } finally {
            Date.now = originalNow
        }

        expect(cache.getSession(session.id)?.thinking).toBe(false)
        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }
        expect(update.data).toEqual(expect.objectContaining({ thinking: false }))
    })
})
