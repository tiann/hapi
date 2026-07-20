import type { ClientToServerEvents } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Store, StoredMachine } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type MachineAlivePayload = {
    machineId: string
    time: number
    health?: unknown
}

type ResolveMachineAccess = (machineId: string) => AccessResult<StoredMachine>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type MachineUpdateMetadataHandler = ClientToServerEvents['machine-update-metadata']
type MachineUpdateStateHandler = ClientToServerEvents['machine-update-state']

const machineUpdateMetadataSchema = z.object({
    machineId: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const machineUpdateStateSchema = z.object({
    machineId: z.string(),
    expectedVersion: z.number().int(),
    runnerState: z.unknown().nullable()
})

export type MachineHandlersDeps = {
    store: Store
    resolveMachineAccess: ResolveMachineAccess
    emitAccessError: EmitAccessError
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
}

export function registerMachineHandlers(socket: CliSocketWithData, deps: MachineHandlersDeps): void {
    const { store, resolveMachineAccess, emitAccessError, onMachineAlive, onWebappEvent } = deps

    socket.on('machine-alive', (data: MachineAlivePayload) => {
        if (!data || typeof data.machineId !== 'string' || typeof data.time !== 'number') {
            return
        }
        const machineAccess = resolveMachineAccess(data.machineId)
        if (!machineAccess.ok) {
            emitAccessError('machine', data.machineId, machineAccess.reason)
            return
        }
        onMachineAlive?.(data)
    })

    const handleMachineMetadataUpdate: MachineUpdateMetadataHandler = (data, cb) => {
        const parsed = machineUpdateMetadataSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { machineId: id, metadata, expectedVersion } = parsed.data
        const machineAccess = resolveMachineAccess(id)
        if (!machineAccess.ok) {
            cb({ result: 'error', reason: machineAccess.reason })
            return
        }

        const result = store.machines.updateMachineMetadata(id, metadata, expectedVersion, machineAccess.value.namespace)
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, metadata: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-machine' as const,
                    machineId: id,
                    metadata: { version: result.version, value: metadata },
                    runnerState: null
                }
            }
            socket.to(`machine:${id}`).emit('update', update)
            onWebappEvent?.({ type: 'machine-updated', machineId: id })
        }
    }

    const handleMachineStateUpdate: MachineUpdateStateHandler = (data, cb) => {
        const parsed = machineUpdateStateSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { machineId: id, runnerState, expectedVersion } = parsed.data
        const machineAccess = resolveMachineAccess(id)
        if (!machineAccess.ok) {
            cb({ result: 'error', reason: machineAccess.reason })
            return
        }

        const result = store.machines.updateMachineRunnerState(
            id,
            runnerState,
            expectedVersion,
            machineAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, runnerState: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, runnerState: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-machine' as const,
                    machineId: id,
                    metadata: null,
                    runnerState: { version: result.version, value: runnerState }
                }
            }
            socket.to(`machine:${id}`).emit('update', update)
            onWebappEvent?.({ type: 'machine-updated', machineId: id })
        }
    }

    socket.on('machine-update-metadata', handleMachineMetadataUpdate)
    socket.on('machine-update-state', handleMachineStateUpdate)
}
