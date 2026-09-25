/**
 * session-wake emission tests.
 *
 * When a message becomes deliverable (immediate send or scheduled-message
 * maturation) but no session-scoped socket is in the session room, the hub
 * notifies the owning runner over its machine room so the session process
 * can reconnect immediately instead of waiting out the socket.io backoff.
 */
import { describe, expect, it } from 'bun:test'
import { MessageService } from './messageService'
import type { EventPublisher } from './eventPublisher'
import { Store } from '../store'
import type { Server } from 'socket.io'
import type { SyncEvent } from '@hapi/protocol/types'

type RoomEmit = { room: string; event: string; data: unknown }

function makeIo(sessionRoomSize: number): { io: Server; emitted: RoomEmit[] } {
    const emitted: RoomEmit[] = []
    const sessionRoom = sessionRoomSize > 0 ? new Set(Array.from({ length: sessionRoomSize }, (_, i) => `session-socket-${i}`)) : undefined
    return {
        emitted,
        io: {
            of: (_ns: string) => ({
                to: (room: string) => ({
                    timeout: () => ({ emit: () => {} }),
                    emit: (event: string, data: unknown) => {
                        emitted.push({ room, event, data })
                    }
                }),
                adapter: {
                    rooms: {
                        get: (roomName: string) => (roomName.startsWith('session:') ? sessionRoom : new Set(['machine-socket']))
                    }
                }
            })
        } as unknown as Server
    }
}

function makePublisher() {
    const events: SyncEvent[] = []
    return {
        emit: (event: SyncEvent) => { events.push(event) },
        events
    }
}

describe('session-wake emission', () => {
    it('wakes the owning runner when an immediate message has no connected session socket', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-immediate', { path: '/tmp/wake-immediate', machineId: 'machine-1' }, null, 'default')
        const { io, emitted } = makeIo(0)
        const service = new MessageService(store, io, makePublisher() as unknown as EventPublisher)

        service.sendMessage(session.id, { text: 'hello' })

        const update = emitted.find((entry) => entry.event === 'update')
        expect(update?.room).toBe(`session:${session.id}`)

        const wake = emitted.find((entry) => entry.event === 'session-wake')
        expect(wake?.room).toBe('machine:machine-1')
        expect(wake?.data).toEqual({ sessionId: session.id })
    })

    it('does not wake when the session socket is connected', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-connected', { path: '/tmp/wake-connected', machineId: 'machine-1' }, null, 'default')
        const { io, emitted } = makeIo(1)
        const service = new MessageService(store, io, makePublisher() as unknown as EventPublisher)

        service.sendMessage(session.id, { text: 'hello' })

        expect(emitted.some((entry) => entry.event === 'session-wake')).toBe(false)
    })

    it('does not wake for sessions without a machineId (non-runner sessions)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-local', { path: '/tmp/wake-local' }, null, 'default')
        const { io, emitted } = makeIo(0)
        const service = new MessageService(store, io, makePublisher() as unknown as EventPublisher)

        service.sendMessage(session.id, { text: 'hello' })

        expect(emitted.some((entry) => entry.event === 'update')).toBe(true)
        expect(emitted.some((entry) => entry.event === 'session-wake')).toBe(false)
    })

    it('wakes the owning runner when a scheduled message matures with no session socket', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('wake-scheduled', { path: '/tmp/wake-scheduled', machineId: 'machine-2' }, null, 'default')
        const { io, emitted } = makeIo(0)
        const service = new MessageService(store, io, makePublisher() as unknown as EventPublisher)

        const scheduledAt = Date.now() + 60_000
        service.sendMessage(session.id, { text: 'later', localId: 'wake-scheduled-1', scheduledAt })
        expect(emitted.some((entry) => entry.event === 'session-wake')).toBe(false)

        service.releaseMatureScheduledMessages(scheduledAt + 1_000)

        const wake = emitted.find((entry) => entry.event === 'session-wake')
        expect(wake?.room).toBe('machine:machine-2')
        expect(wake?.data).toEqual({ sessionId: session.id })
    })
})
