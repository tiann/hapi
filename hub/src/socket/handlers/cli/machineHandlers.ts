import { MachineMetadataSchema, ManagedSessionOutcomeRequestSchema, ManagedStopBarrierRequestSchema, isObject, type ClientToServerEvents, type ManagedSessionOutcomeAck, type ManagedSessionOutcomeRequest, type ManagedStopBarrierAck, type ManagedStopBarrierRequest } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Store, StoredMachine } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type MachineAlivePayload = {
    machineId: string
    time: number
}

type ResolveMachineAccess = (machineId: string) => AccessResult<StoredMachine>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type MachineUpdateMetadataHandler = ClientToServerEvents['machine-update-metadata']
type MachineUpdateStateHandler = ClientToServerEvents['machine-update-state']

const machineUpdateMetadataSchema = z.object({
    machineId: z.string(),
    expectedVersion: z.number().int(),
    metadata: MachineMetadataSchema
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
            cb({ result: 'error', reason: 'invalid-request' })
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
            onWebappEvent?.({ type: 'machine-updated', machineId: id, data: { id } })
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
            onWebappEvent?.({ type: 'machine-updated', machineId: id, data: { id } })
        }
    }

    socket.on('machine-update-metadata', handleMachineMetadataUpdate)
    socket.on('machine-update-state', handleMachineStateUpdate)
    socket.on('runner-managed-session-outcome', (raw: ManagedSessionOutcomeRequest, cb: (answer: ManagedSessionOutcomeAck) => void) => {
        const parsed = ManagedSessionOutcomeRequestSchema.safeParse(raw)
        if (!parsed.success) {
            cb({ result: 'error', reason: 'invalid-request' })
            return
        }
        const request = parsed.data
        const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null
        const authenticatedMachineId = typeof (socket.handshake.auth as Record<string, unknown> | undefined)?.machineId === 'string'
            ? (socket.handshake.auth as Record<string, unknown>).machineId as string
            : null
        if (!namespace || authenticatedMachineId !== request.machineId || request.namespace !== namespace) {
            cb({ result: 'error', reason: 'access-denied' })
            return
        }
        try {
            if (!request.sessionId) {
                cb({ result: 'deferred', launchNonce: request.launchNonce })
                return
            }
            const canonicalSessionId = store.managedSessions.resolveCanonical(namespace, request.sessionId)
            const session = store.sessions.getSessionByNamespace(canonicalSessionId, namespace)
            const metadata = session && isObject(session.metadata) ? session.metadata : null
            if (!session || !metadata || metadata.launchNonce !== request.launchNonce || metadata.runnerInstanceId !== request.runnerInstanceId) {
                cb({ result: 'error', reason: session ? 'launch-mismatch' : 'not-found' })
                return
            }
            const answer = store.managedSessions.markOutcome({ ...request, sessionId: canonicalSessionId, expectedVersion: session.metadataVersion })
            cb(answer)
            if (answer.result === 'success') {
                onWebappEvent?.({ type: 'session-updated', sessionId: answer.canonicalSessionId })
            }
        } catch {
            cb({ result: 'error', reason: 'internal-error' })
        }
    })
    socket.on('runner-managed-stop-barrier', (raw: ManagedStopBarrierRequest, cb: (answer: ManagedStopBarrierAck) => void) => {
        const parsed = ManagedStopBarrierRequestSchema.safeParse(raw)
        if (!parsed.success) return cb({ eligible: false, reason: 'invalid-request' })
        const request = parsed.data
        const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null
        const authenticatedMachineId = typeof (socket.handshake.auth as Record<string, unknown> | undefined)?.machineId === 'string'
            ? (socket.handshake.auth as Record<string, unknown>).machineId as string
            : null
        if (!namespace || request.namespace !== namespace || request.machineId !== authenticatedMachineId) {
            return cb({ eligible: false, reason: 'access-denied' })
        }
        try {
            const canonicalSessionId = store.managedSessions.resolveCanonical(namespace, request.sessionId)
            const session = store.sessions.getSessionByNamespace(canonicalSessionId, namespace)
            const metadata = session && isObject(session.metadata) ? session.metadata : null
            if (!session || !metadata) return cb({ eligible: false, reason: 'not-found' })
            if (metadata.launchNonce !== request.launchNonce || metadata.runnerInstanceId !== request.runnerInstanceId) {
                return cb({ eligible: false, reason: 'launch-mismatch' })
            }
            if (session.active || metadata.lifecycleState === 'running') return cb({ eligible: false, reason: 'session-active' })
            if (metadata.stopReasonCode === 'ambiguous-turn-delivery'
                || store.deliveryAttempts.hasUnresolvedAmbiguous(namespace, canonicalSessionId)) {
                return cb({ eligible: false, reason: 'ambiguous-delivery' })
            }
            return cb({ eligible: true, reason: 'canonical-terminal-outcome' })
        } catch {
            return cb({ eligible: false, reason: 'internal-error' })
        }
    })
}
