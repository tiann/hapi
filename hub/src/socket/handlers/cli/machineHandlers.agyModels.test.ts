import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { StoredMachine } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerMachineHandlers } from './machineHandlers'

function harness(options: { access: 'ok' | 'denied' }) {
    const socket = new EventEmitter() as unknown as CliSocketWithData
    const events: SyncEvent[] = []
    const accessErrors: Array<{ scope: string; id: string; reason: string }> = []

    registerMachineHandlers(socket, {
        store: {} as never,
        resolveMachineAccess: () => (
            options.access === 'ok'
                ? { ok: true, value: { namespace: 'alpha' } as StoredMachine }
                : { ok: false, reason: 'access-denied' }
        ),
        emitAccessError: (scope, id, reason) => { accessErrors.push({ scope, id, reason }) },
        onWebappEvent: (event) => { events.push(event) }
    })

    return { socket: socket as unknown as EventEmitter, events, accessErrors }
}

describe('machine-agy-models-changed', () => {
    it('forwards a catalog announcement for a machine this CLI may speak for', () => {
        const { socket, events } = harness({ access: 'ok' })

        socket.emit('machine-agy-models-changed', { machineId: 'machine-1' })

        expect(events).toEqual([{ type: 'machine-agy-models-updated', machineId: 'machine-1' }])
    })

    it('refuses to announce for a machine the CLI has no access to', () => {
        const { socket, events, accessErrors } = harness({ access: 'denied' })

        socket.emit('machine-agy-models-changed', { machineId: 'someone-elses-machine' })

        expect(events).toEqual([])
        expect(accessErrors).toEqual([
            { scope: 'machine', id: 'someone-elses-machine', reason: 'access-denied' }
        ])
    })

    it('drops a malformed payload without announcing or erroring', () => {
        const { socket, events, accessErrors } = harness({ access: 'ok' })

        socket.emit('machine-agy-models-changed', {})
        socket.emit('machine-agy-models-changed', { machineId: '' })
        socket.emit('machine-agy-models-changed', null)
        socket.emit('machine-agy-models-changed', 'machine-1')

        expect(events).toEqual([])
        expect(accessErrors).toEqual([])
    })
})
