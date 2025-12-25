import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Store } from '../../store'
import { RpcRegistry } from '../rpcRegistry'
import type { SyncEvent } from '../../sync/syncEngine'
import { extractTodoWriteTodosFromMessageContent } from '../../sync/todos'
import { TerminalRegistry } from '../terminalRegistry'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
}

type SessionEndPayload = {
    sid: string
    time: number
}

type MachineAlivePayload = {
    machineId: string
    time: number
}

const messageSchema = z.object({
    sid: z.string(),
    message: z.union([z.string(), z.unknown()]),
    localId: z.string().optional()
})

const updateMetadataSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const updateStateSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    agentState: z.unknown().nullable()
})

const rpcRegisterSchema = z.object({
    method: z.string().min(1)
})

const rpcUnregisterSchema = z.object({
    method: z.string().min(1)
})

const machineUpdateMetadataSchema = z.object({
    machineId: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const machineUpdateStateSchema = z.object({
    machineId: z.string(),
    expectedVersion: z.number().int(),
    daemonState: z.unknown().nullable()
})

const terminalReadySchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1)
})

const terminalOutputSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    data: z.string()
})

const terminalExitSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    code: z.number().int().nullable(),
    signal: z.string().nullable()
})

const terminalErrorSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    message: z.string()
})

export type CliHandlersDeps = {
    io: Server
    store: Store
    rpcRegistry: RpcRegistry
    terminalRegistry: TerminalRegistry
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
}

export function registerCliHandlers(socket: Socket, deps: CliHandlersDeps): void {
    const { io, store, rpcRegistry, terminalRegistry, onSessionAlive, onSessionEnd, onMachineAlive, onWebappEvent } = deps
    const terminalNamespace = io.of('/terminal')

    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const sessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null
    if (sessionId) {
        socket.join(`session:${sessionId}`)
    }

    const machineId = typeof auth?.machineId === 'string' ? auth.machineId : null
    if (machineId) {
        socket.join(`machine:${machineId}`)
    }

    socket.on('rpc-register', (data: unknown) => {
        const parsed = rpcRegisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        rpcRegistry.register(socket, parsed.data.method)
    })

    socket.on('rpc-unregister', (data: unknown) => {
        const parsed = rpcUnregisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        rpcRegistry.unregister(socket, parsed.data.method)
    })

    socket.on('disconnect', () => {
        rpcRegistry.unregisterAll(socket)
        const removed = terminalRegistry.removeByCliSocket(socket.id)
        for (const entry of removed) {
            const terminalSocket = terminalNamespace.sockets.get(entry.socketId)
            terminalSocket?.emit('terminal:error', {
                terminalId: entry.terminalId,
                message: 'CLI disconnected.'
            })
        }
    })

    socket.on('message', (data: unknown) => {
        const parsed = messageSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sid, localId } = parsed.data
        const raw = parsed.data.message

        const content = typeof raw === 'string'
            ? (() => {
                try {
                    return JSON.parse(raw) as unknown
                } catch {
                    return raw
                }
            })()
            : raw

        const msg = store.addMessage(sid, content, localId)

        const todos = extractTodoWriteTodosFromMessageContent(content)
        if (todos) {
            const updated = store.setSessionTodos(sid, todos, msg.createdAt)
            if (updated) {
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
            }
        }

        // Broadcast to other CLI sockets interested in this session (skip sender).
        const update = {
            id: randomUUID(),
            seq: Date.now(),
            createdAt: Date.now(),
            body: {
                t: 'new-message' as const,
                sid,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        socket.to(`session:${sid}`).emit('update', update)

        onWebappEvent?.({
            type: 'message-received',
            sessionId: sid,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt
            }
        })
    })

    socket.on('update-metadata', (data: unknown, cb: (answer: unknown) => void) => {
        const parsed = updateMetadataSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, metadata, expectedVersion } = parsed.data
        const result = store.updateSessionMetadata(sid, metadata, expectedVersion)
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
                    t: 'update-session' as const,
                    sid,
                    metadata: { version: result.version, value: metadata },
                    agentState: null
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
        }
    })

    socket.on('update-state', (data: unknown, cb: (answer: unknown) => void) => {
        const parsed = updateStateSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, agentState, expectedVersion } = parsed.data
        const result = store.updateSessionAgentState(sid, agentState, expectedVersion)
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, agentState: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, agentState: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    metadata: null,
                    agentState: { version: result.version, value: agentState }
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
        }
    })

    socket.on('session-alive', (data: SessionAlivePayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        onSessionAlive?.(data)
    })

    socket.on('session-end', (data: SessionEndPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        onSessionEnd?.(data)
    })

    socket.on('machine-alive', (data: MachineAlivePayload) => {
        if (!data || typeof data.machineId !== 'string' || typeof data.time !== 'number') {
            return
        }
        onMachineAlive?.(data)
    })

    const handleMachineMetadataUpdate = (data: unknown, cb: (answer: unknown) => void) => {
        const parsed = machineUpdateMetadataSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { machineId: id, metadata, expectedVersion } = parsed.data
        const result = store.updateMachineMetadata(id, metadata, expectedVersion)
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
                    daemonState: null
                }
            }
            socket.to(`machine:${id}`).emit('update', update)
            onWebappEvent?.({ type: 'machine-updated', machineId: id, data: { id } })
        }
    }

    const handleMachineStateUpdate = (data: unknown, cb: (answer: unknown) => void) => {
        const parsed = machineUpdateStateSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { machineId: id, daemonState, expectedVersion } = parsed.data
        const result = store.updateMachineDaemonState(id, daemonState, expectedVersion)
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, daemonState: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, daemonState: result.value })
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
                    daemonState: { version: result.version, value: daemonState }
                }
            }
            socket.to(`machine:${id}`).emit('update', update)
            onWebappEvent?.({ type: 'machine-updated', machineId: id, data: { id } })
        }
    }

    socket.on('machine-update-metadata', handleMachineMetadataUpdate)
    socket.on('update-machine-metadata', handleMachineMetadataUpdate)

    socket.on('machine-update-state', handleMachineStateUpdate)
    socket.on('update-machine-state', handleMachineStateUpdate)

    socket.on('ping', (callback: () => void) => {
        callback()
    })

    const forwardTerminalEvent = (event: string, payload: { sessionId: string; terminalId: string } & Record<string, unknown>) => {
        const entry = terminalRegistry.get(payload.terminalId)
        if (!entry) {
            return
        }
        if (entry.cliSocketId !== socket.id) {
            return
        }
        if (payload.sessionId !== entry.sessionId) {
            return
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
        if (!entry || entry.sessionId !== parsed.data.sessionId || entry.cliSocketId !== socket.id) {
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
        forwardTerminalEvent('terminal:error', parsed.data)
    })
}
