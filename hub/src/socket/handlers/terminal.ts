import { TerminalOpenPayloadSchema } from '@hapi/protocol'
import { z } from 'zod'
import type { TerminalRegistry, TerminalRegistryEntry } from '../terminalRegistry'
import type { SocketServer, SocketWithData } from '../socketTypes'

const terminalCreateSchema = TerminalOpenPayloadSchema

const terminalWriteSchema = z.object({
    terminalId: z.string().min(1),
    data: z.string()
})

const terminalResizeSchema = z.object({
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

const terminalCloseSchema = z.object({
    terminalId: z.string().min(1)
})

export type TerminalHandlersDeps = {
    io: SocketServer
    getSession: (sessionId: string) => { active: boolean; namespace: string } | null
    getMachine: (machineId: string) => { active: boolean; namespace: string } | null
    terminalRegistry: TerminalRegistry
    maxTerminalsPerSocket: number
    maxTerminalsPerSession: number
}

export function registerTerminalHandlers(socket: SocketWithData, deps: TerminalHandlersDeps): void {
    const { io, getSession, getMachine, terminalRegistry, maxTerminalsPerSocket, maxTerminalsPerSession } = deps
    const cliNamespace = io.of('/cli')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    const emitTerminalError = (terminalId: string, message: string) => {
        socket.emit('terminal:error', { terminalId, message })
    }

    const resolveEntryForSocket = (terminalId: string): TerminalRegistryEntry | null => {
        const entry = terminalRegistry.get(terminalId)
        if (!entry || entry.socketId !== socket.id) {
            return null
        }
        return entry
    }

    const resolveCliSocket = (entry: TerminalRegistryEntry, reportError: boolean): SocketWithData | null => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            terminalRegistry.remove(entry.terminalId)
            if (reportError) {
                emitTerminalError(entry.terminalId, 'CLI disconnected.')
            }
            return null
        }
        return cliSocket
    }

    const getEntryScope = (entry: TerminalRegistryEntry): { sessionId: string } | { machineId: string } | null => {
        if (entry.sessionId) return { sessionId: entry.sessionId }
        if (entry.machineId) return { machineId: entry.machineId }
        return null
    }

    const emitCloseToCli = (entry: TerminalRegistryEntry): void => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            return
        }
        const scope = getEntryScope(entry)
        if (!scope) return
        cliSocket.emit('terminal:close', { ...scope, terminalId: entry.terminalId })
    }

    const emitDetachToCli = (entry: TerminalRegistryEntry): void => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            return
        }
        const scope = getEntryScope(entry)
        if (!scope) return
        cliSocket.emit('terminal:detach', { ...scope, terminalId: entry.terminalId })
    }

    const pickCliSocketId = (scope: { sessionId: string } | { machineId: string }): string | null => {
        const roomId = 'sessionId' in scope ? `session:${scope.sessionId}` : `machine:${scope.machineId}`
        const room = cliNamespace.adapter.rooms.get(roomId)
        if (!room || room.size === 0) {
            return null
        }
        for (const socketId of room) {
            const cliSocket = cliNamespace.sockets.get(socketId)
            if (cliSocket && cliSocket.data.namespace === namespace) {
                return cliSocket.id
            }
        }
        return null
    }

    socket.on('terminal:create', (data: unknown) => {
        const parsed = terminalCreateSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sessionId, machineId, terminalId, cols, rows, cwd, replay } = parsed.data
        const scope = sessionId ? { sessionId } : machineId ? { machineId } : null
        if (!scope) {
            emitTerminalError(terminalId, 'Terminal scope is unavailable.')
            return
        }

        if (sessionId) {
            const session = getSession(sessionId)
            if (!namespace || !session || session.namespace !== namespace || !session.active) {
                emitTerminalError(terminalId, 'Session is inactive or unavailable.')
                return
            }
        } else if (machineId) {
            const machine = getMachine(machineId)
            if (!namespace || !machine || machine.namespace !== namespace || !machine.active) {
                emitTerminalError(terminalId, 'Machine is inactive or unavailable.')
                return
            }
        }

        const existingEntry = terminalRegistry.get(terminalId)
        const isReconnect = existingEntry?.sessionId === sessionId && existingEntry?.machineId === machineId

        if (!isReconnect && terminalRegistry.countForSocket(socket.id) >= maxTerminalsPerSocket) {
            emitTerminalError(terminalId, `Too many terminals open (max ${maxTerminalsPerSocket}).`)
            return
        }

        const scopeCount = sessionId
            ? terminalRegistry.countForSession(sessionId)
            : machineId
              ? terminalRegistry.countForMachine(machineId)
              : 0
        const scopeLabel = sessionId ? 'session' : 'machine'
        if (!isReconnect && scopeCount >= maxTerminalsPerSession) {
            emitTerminalError(terminalId, `Too many terminals open for this ${scopeLabel} (max ${maxTerminalsPerSession}).`)
            return
        }

        const cliSocketId = pickCliSocketId(scope)
        if (!cliSocketId) {
            emitTerminalError(terminalId, `CLI is not connected for this ${scopeLabel}.`)
            return
        }

        const entry = terminalRegistry.register({
            terminalId,
            sessionId,
            machineId,
            socketId: socket.id,
            cliSocketId
        })
        if (!entry) {
            emitTerminalError(terminalId, 'Terminal ID is already in use.')
            return
        }

        const cliSocket = cliNamespace.sockets.get(cliSocketId)
        if (!cliSocket) {
            terminalRegistry.remove(terminalId)
            emitTerminalError(terminalId, `CLI is not connected for this ${scopeLabel}.`)
            return
        }

        cliSocket.emit('terminal:open', {
            ...scope,
            terminalId,
            cols,
            rows,
            ...(cwd ? { cwd } : {}),
            ...(replay ? { replay } : {})
        })
        terminalRegistry.markActivity(terminalId)
    })

    socket.on('terminal:write', (data: unknown) => {
        const parsed = terminalWriteSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { terminalId, data: payload } = parsed.data
        const entry = resolveEntryForSocket(terminalId)
        if (!entry) {
            return
        }

        const cliSocket = resolveCliSocket(entry, true)
        if (!cliSocket) {
            return
        }
        const entryScope = getEntryScope(entry)
        if (!entryScope) return
        cliSocket.emit('terminal:write', {
            ...entryScope,
            terminalId,
            data: payload
        })
        terminalRegistry.markActivity(terminalId)
    })

    socket.on('terminal:resize', (data: unknown) => {
        const parsed = terminalResizeSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { terminalId, cols, rows } = parsed.data
        const entry = resolveEntryForSocket(terminalId)
        if (!entry) {
            return
        }

        const cliSocket = resolveCliSocket(entry, true)
        if (!cliSocket) {
            return
        }
        const entryScope = getEntryScope(entry)
        if (!entryScope) return
        cliSocket.emit('terminal:resize', {
            ...entryScope,
            terminalId,
            cols,
            rows
        })
        terminalRegistry.markActivity(terminalId)
    })

    socket.on('terminal:close', (data: unknown) => {
        const parsed = terminalCloseSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { terminalId } = parsed.data
        const entry = resolveEntryForSocket(terminalId)
        if (!entry) {
            return
        }

        terminalRegistry.remove(terminalId)
        emitCloseToCli(entry)
    })

    socket.on('disconnect', () => {
        // Socket disconnect means the web view detached (route switch,
        // reconnect, page background, etc.). Do not close the underlying
        // terminal process here; explicit `terminal:close` is the destructive
        // lifecycle event. A later `terminal:create` with the same ID will
        // re-register and reattach to the CLI-side terminal manager.
        const removed = terminalRegistry.removeBySocket(socket.id)
        for (const entry of removed) {
            emitDetachToCli(entry)
        }
    })
}
