import {
    TerminalErrorPayloadSchema,
    TerminalExitPayloadSchema,
    TerminalOutputPayloadSchema,
    TerminalReadyPayloadSchema
} from '@hapi/protocol'
import type { StoredMachine, StoredSession } from '../../../store'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>
type ResolveMachineAccess = (machineId: string) => AccessResult<StoredMachine>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type SocketNamespace = ReturnType<SocketServer['of']>

const terminalReadySchema = TerminalReadyPayloadSchema
const terminalOutputSchema = TerminalOutputPayloadSchema
const terminalExitSchema = TerminalExitPayloadSchema
const terminalErrorSchema = TerminalErrorPayloadSchema

export type TerminalHandlersDeps = {
    terminalRegistry: TerminalRegistry
    terminalNamespace: SocketNamespace
    resolveSessionAccess: ResolveSessionAccess
    resolveMachineAccess: ResolveMachineAccess
    emitAccessError: EmitAccessError
}

export function registerTerminalHandlers(socket: CliSocketWithData, deps: TerminalHandlersDeps): void {
    const { terminalRegistry, terminalNamespace, resolveSessionAccess, resolveMachineAccess, emitAccessError } = deps

    const forwardTerminalEvent = (event: string, payload: { sessionId?: string; machineId?: string; terminalId: string } & Record<string, unknown>) => {
        const entry = terminalRegistry.get(payload.terminalId)
        if (!entry) {
            return
        }
        if (entry.cliSocketId !== socket.id) {
            return
        }
        if (payload.sessionId !== entry.sessionId || payload.machineId !== entry.machineId) {
            return
        }
        if (payload.sessionId) {
            const sessionAccess = resolveSessionAccess(payload.sessionId)
            if (!sessionAccess.ok) {
                emitAccessError('session', payload.sessionId, sessionAccess.reason)
                return
            }
        } else if (payload.machineId) {
            const machineAccess = resolveMachineAccess(payload.machineId)
            if (!machineAccess.ok) {
                emitAccessError('machine', payload.machineId, machineAccess.reason)
                return
            }
        }
        const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
        if (!terminalSocket) {
            return
        }
        terminalSocket.emit(event, payload)
    }

    socket.on('terminal:ready', (data: unknown) => {
        const parsed = terminalReadySchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        terminalRegistry.markActivity(parsed.data.terminalId)
        forwardTerminalEvent('terminal:ready', parsed.data)
    })

    socket.on('terminal:output', (data: unknown) => {
        const parsed = terminalOutputSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        terminalRegistry.markActivity(parsed.data.terminalId)
        forwardTerminalEvent('terminal:output', parsed.data)
    })

    socket.on('terminal:exit', (data: unknown) => {
        const parsed = terminalExitSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        const entry = terminalRegistry.get(parsed.data.terminalId)
        if (!entry || entry.sessionId !== parsed.data.sessionId || entry.machineId !== parsed.data.machineId || entry.cliSocketId !== socket.id) {
            return
        }
        terminalRegistry.remove(parsed.data.terminalId)
        const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
        if (!terminalSocket) {
            return
        }
        terminalSocket.emit('terminal:exit', parsed.data)
    })

    socket.on('terminal:error', (data: unknown) => {
        const parsed = terminalErrorSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const entry = terminalRegistry.get(parsed.data.terminalId)
        if (!entry || entry.sessionId !== parsed.data.sessionId || entry.machineId !== parsed.data.machineId || entry.cliSocketId !== socket.id) {
            return
        }

        if (parsed.data.sessionId) {
            const sessionAccess = resolveSessionAccess(parsed.data.sessionId)
            if (!sessionAccess.ok) {
                terminalRegistry.remove(parsed.data.terminalId)
                emitAccessError('session', parsed.data.sessionId, sessionAccess.reason)
                return
            }
        } else if (parsed.data.machineId) {
            const machineAccess = resolveMachineAccess(parsed.data.machineId)
            if (!machineAccess.ok) {
                terminalRegistry.remove(parsed.data.terminalId)
                emitAccessError('machine', parsed.data.machineId, machineAccess.reason)
                return
            }
        }

        const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
        terminalRegistry.remove(parsed.data.terminalId)
        terminalSocket?.emit('terminal:error', parsed.data)
    })
}

export function cleanupTerminalHandlers(socket: CliSocketWithData, deps: { terminalRegistry: TerminalRegistry; terminalNamespace: SocketNamespace }): void {
    const removed = deps.terminalRegistry.removeByCliSocket(socket.id)
    for (const entry of removed) {
        const terminalSocket = deps.terminalNamespace.sockets.get(entry.socketId)
        terminalSocket?.emit('terminal:error', {
            ...(entry.sessionId ? { sessionId: entry.sessionId } : { machineId: entry.machineId }),
            terminalId: entry.terminalId,
            message: 'CLI disconnected.'
        })
    }
}
