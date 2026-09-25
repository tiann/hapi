import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { StoredMachine } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerMachineHandlers } from './machineHandlers'

type MachineAlivePayload = {
    machineId: string
    time: number
    aliveSessions?: string[]
}

function harness() {
    const socket = new EventEmitter() as unknown as CliSocketWithData
    const received: MachineAlivePayload[] = []
    const events: SyncEvent[] = []

    registerMachineHandlers(socket, {
        store: {} as never,
        resolveMachineAccess: () => ({ ok: true, value: { namespace: 'alpha' } as StoredMachine }),
        emitAccessError: () => {},
        onMachineAlive: (payload) => { received.push(payload) },
        onWebappEvent: (event) => { events.push(event) }
    })

    return { socket: socket as unknown as EventEmitter, received, events }
}

describe('machine-alive aliveSessions sanitization', () => {
    it('passes a well-formed list through unchanged', () => {
        const { socket, received } = harness()

        socket.emit('machine-alive', { machineId: 'machine-1', time: 1, aliveSessions: ['a', 'b'] })

        expect(received).toEqual([{ machineId: 'machine-1', time: 1, aliveSessions: ['a', 'b'] }])
    })

    it('keeps the payload untouched when aliveSessions is absent', () => {
        const { socket, received } = harness()
        const payload = { machineId: 'machine-1', time: 1 }

        socket.emit('machine-alive', payload)

        expect(received).toEqual([payload])
        expect('aliveSessions' in received[0]).toBe(false)
    })

    it('drops non-string, empty and oversized ids and dedupes', () => {
        const { socket, received } = harness()

        socket.emit('machine-alive', {
            machineId: 'machine-1',
            time: 1,
            aliveSessions: [
                'good',
                42,
                null,
                '',
                'good',
                'x'.repeat(129)
            ] as unknown as string[]
        })

        expect(received[0]?.aliveSessions).toEqual(['good'])
    })

    it('treats a non-array aliveSessions as absent', () => {
        const { socket, received } = harness()

        socket.emit('machine-alive', { machineId: 'machine-1', time: 1, aliveSessions: 'not-a-list' } as never)

        expect(received).toEqual([{ machineId: 'machine-1', time: 1 }])
    })

    it('caps the list at 256 entries', () => {
        const { socket, received } = harness()

        socket.emit('machine-alive', {
            machineId: 'machine-1',
            time: 1,
            aliveSessions: Array.from({ length: 300 }, (_, i) => `session-${i}`)
        })

        expect(received[0]?.aliveSessions).toHaveLength(256)
        expect(received[0]?.aliveSessions?.[255]).toBe('session-255')
    })
})
