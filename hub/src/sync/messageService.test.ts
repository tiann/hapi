/**
 * MessageService.cancelQueuedMessage race scenario tests
 *
 * Race-A: CLI ack returns { removed: true }  → DB DELETE + status='cancelled'
 * Race-B: CLI ack returns { removed: false } (already shift()-ed) → markMessagesInvoked + status='invoked'
 * Race-C: CLI ack times out (500 ms)         → markMessagesInvoked + status='invoked'
 * Race-D (CLI offline): no CLI socket in room → immediate DELETE, message-cancelled emit, no ack call
 * Race-E (partial ack): broadcast ack receives err + [{ removed: true }] → DELETE + status='cancelled'
 */
import { describe, expect, it } from 'bun:test'
import { MessageService } from './messageService'
import { Store } from '../store'
import type { Server } from 'socket.io'
import type { SyncEvent } from '@hapi/protocol/types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

type AckCallback = (err: Error | null, responses: Array<{ removed: boolean }>) => void

function makeIo(onEmit: (ack: AckCallback) => void, socketCount = 1): Server {
    const broadcastRoom = {
        timeout: (_ms: number) => ({
            emit: (_event: string, _data: unknown, callback: AckCallback) => {
                onEmit(callback)
            }
        }),
        emit: () => {}
    }

    // Pre-built set reused on every rooms.get() call (socketCount=0 → undefined)
    const socketSet = socketCount > 0
        ? new Set(Array.from({ length: socketCount }, (_, i) => `socket-${i}`))
        : undefined

    return {
        of: (_ns: string) => ({
            to: (_room: string) => broadcastRoom,
            adapter: { rooms: { get: (_roomName: string) => socketSet } }
        })
    } as unknown as Server
}

function makePublisher() {
    const events: SyncEvent[] = []
    return {
        emit: (event: SyncEvent) => { events.push(event) },
        events
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageService.cancelQueuedMessage race scenarios', () => {
    describe('Race-A: CLI ack removed:true → DELETE + status=cancelled', () => {
        it('returns cancelled and emits message-cancelled SSE after CLI confirms removal', async () => {
            const store = makeStore()
            const session = makeSession(store, 'race-a')
            const msg = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-a'
            )

            const publisher = makePublisher()
            const io = makeIo((callback) => {
                // CLI confirms it removed the item
                callback(null, [{ removed: true }])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('cancelled')

            // Row must be gone from the DB
            const remaining = store.messages.getUninvokedLocalMessages(session.id)
            expect(remaining).toHaveLength(0)

            // message-cancelled SSE must have been broadcast
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeDefined()

            // No messages-consumed for cancelled path (row is deleted, not invoked)
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)
        })
    })

    describe('Race-B: CLI ack removed:false (already shift()-ed) → markMessagesInvoked + status=invoked', () => {
        it('returns invoked with message row when CLI says item was already consumed', async () => {
            const store = makeStore()
            const session = makeSession(store, 'race-b')
            const msg = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-b'
            )

            const publisher = makePublisher()
            const io = makeIo((callback) => {
                // CLI already shifted the item before the cancel arrived
                callback(null, [{ removed: false }])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('invoked')
            if (result.status === 'invoked') {
                expect(result.message.id).toBe(msg.id)
                expect(result.message.localId).toBe('local-b')
                expect(result.message.invokedAt).not.toBeNull()
            }

            // Row must still exist but now have invoked_at set
            const rows = store.messages.getMessages(session.id)
            const row = rows.find(r => r.id === msg.id)
            expect(row).toBeDefined()
            expect(row!.invokedAt).not.toBeNull()

            // No message-cancelled SSE should have been emitted
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeUndefined()

            // messages-consumed SSE must be broadcast so other web clients clear the queued row
            const consumed = publisher.events.find(e => e.type === 'messages-consumed')
            expect(consumed).toBeDefined()
            if (consumed?.type === 'messages-consumed') {
                expect(consumed.sessionId).toBe(session.id)
                expect(consumed.localIds).toEqual(['local-b'])
                expect(typeof consumed.invokedAt).toBe('number')
            }

            // messages-consumed must be emitted exactly once
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(1)
        })
    })

    describe('Race-C: CLI ack timeout → markMessagesInvoked + status=invoked', () => {
        it('returns invoked with message row when CLI does not respond within timeout', async () => {
            const store = makeStore()
            const session = makeSession(store, 'race-c')
            const msg = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-c'
            )

            const publisher = makePublisher()
            const io = makeIo((callback) => {
                // Simulate timeout: socket.io passes an error as first arg
                callback(new Error('operation has timed out'), [])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('invoked')
            if (result.status === 'invoked') {
                expect(result.message.id).toBe(msg.id)
                expect(result.message.invokedAt).not.toBeNull()
            }

            // Row must still exist with invoked_at stamped
            const rows = store.messages.getMessages(session.id)
            const row = rows.find(r => r.id === msg.id)
            expect(row).toBeDefined()
            expect(row!.invokedAt).not.toBeNull()

            // No message-cancelled SSE
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeUndefined()

            // messages-consumed SSE must be broadcast so other web clients clear the queued row
            const consumed = publisher.events.find(e => e.type === 'messages-consumed')
            expect(consumed).toBeDefined()
            if (consumed?.type === 'messages-consumed') {
                expect(consumed.sessionId).toBe(session.id)
                expect(consumed.localIds).toEqual(['local-c'])
                expect(typeof consumed.invokedAt).toBe('number')
            }

            // messages-consumed must be emitted exactly once
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(1)
        })
    })

    describe('Race-D: CLI offline (room socket count === 0) → immediate DELETE, no ack', () => {
        it('returns cancelled and emits message-cancelled without calling ack when no CLI socket is connected', async () => {
            const store = makeStore()
            const session = makeSession(store, 'race-d-offline')
            const msg = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-offline'
            )

            let ackCalled = false
            // socketCount=0 → adapter.rooms.get() returns undefined → cliCount = 0
            const io = makeIo(() => { ackCalled = true }, 0)
            const publisher = makePublisher()

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            // Hub must return cancelled immediately
            expect(result.status).toBe('cancelled')

            // CLI ack must NOT have been called
            expect(ackCalled).toBe(false)

            // Row must be gone from the DB (immediate DELETE)
            const remaining = store.messages.getUninvokedLocalMessages(session.id)
            expect(remaining).toHaveLength(0)

            // message-cancelled SSE must have been emitted with localId
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeDefined()
            if (cancelled?.type === 'message-cancelled') {
                expect(cancelled.localId).toBe('local-offline')
            }

            // No messages-consumed (row was deleted, not invoked)
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)

            // No invoked_at stamped (row deleted, not marked invoked)
            const rows = store.messages.getMessages(session.id)
            expect(rows.find(r => r.id === msg.id)).toBeUndefined()
        })
    })

    describe('existing store-level invoked guard (DB first-write-wins) still respected', () => {
        it('returns invoked without contacting CLI when DB row already has invoked_at', async () => {
            const store = makeStore()
            const session = makeSession(store, 'race-d-already-invoked')
            const msg = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-d'
            )

            // DB row was already marked invoked (e.g. by a concurrent messages-consumed)
            const invokedAt = Date.now()
            store.messages.markMessagesInvoked(session.id, ['local-d'], invokedAt)

            let cliContacted = false
            const io = makeIo(() => { cliContacted = true })
            const publisher = makePublisher()

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('invoked')
            // CLI must NOT have been contacted — DB guard should short-circuit before ack
            expect(cliContacted).toBe(false)

            if (result.status === 'invoked') {
                expect(result.message.invokedAt).toBe(invokedAt)
            }

            // DB guard path: messages-consumed was already published by the prior
            // messages-consumed flow that set invoked_at.  No additional emit here.
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)
        })
    })

    describe('Race-E: partial ack — broadcast callback receives err + [{ removed: true }]', () => {
        it('returns cancelled and deletes row when at least one socket acked removal, even if err is set', async () => {
            const store = makeStore()
            const session = makeSession(store, 'race-e')
            const msg = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-e'
            )

            const publisher = makePublisher()
            // Reconnect-overlap scenario: one socket timed out (err set by Socket.IO),
            // but the live socket confirmed removal in responses.
            const io = makeIo((callback) => {
                callback(new Error('operation has timed out'), [{ removed: true }])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            // The live socket's ack must win — cancel is confirmed
            expect(result.status).toBe('cancelled')

            // Row must be deleted
            const remaining = store.messages.getUninvokedLocalMessages(session.id)
            expect(remaining).toHaveLength(0)

            // message-cancelled SSE must have been emitted
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeDefined()

            // No messages-consumed (row deleted, not invoked)
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)
        })
    })
})
