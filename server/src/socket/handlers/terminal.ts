import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import type { TerminalRegistry, TerminalRegistryEntry } from '../terminalRegistry'

const terminalCreateSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

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
    io: Server
    getSession: (sessionId: string) => { active: boolean } | null
    terminalRegistry: TerminalRegistry
    maxTerminalsPerSocket: number
    maxTerminalsPerSession: number
}

export function registerTerminalHandlers(socket: Socket, deps: TerminalHandlersDeps): void {
    const { io, getSession, terminalRegistry, maxTerminalsPerSocket, maxTerminalsPerSession } = deps
    const cliNamespace = io.of('/cli')

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

    const resolveCliSocket = (entry: TerminalRegistryEntry, reportError: boolean): Socket | null => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket) {
            terminalRegistry.remove(entry.terminalId)
            if (reportError) {
                emitTerminalError(entry.terminalId, 'CLI disconnected.')
            }
            return null
        }
        return cliSocket
    }

    const emitCloseToCli = (entry: TerminalRegistryEntry): void => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket) {
            return
        }
        cliSocket.emit('terminal:close', {
            sessionId: entry.sessionId,
            terminalId: entry.terminalId
        })
    }

    const pickCliSocketId = (sessionId: string): string | null => {
        const room = cliNamespace.adapter.rooms.get(`session:${sessionId}`)
        if (!room || room.size === 0) {
            return null
        }
        for (const socketId of room) {
            if (cliNamespace.sockets.has(socketId)) {
                return socketId
            }
        }
        return null
    }

    socket.on('terminal:create', (data: unknown) => {
        const parsed = terminalCreateSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sessionId, terminalId, cols, rows } = parsed.data
        const session = getSession(sessionId)
        if (!session || !session.active) {
            emitTerminalError(terminalId, 'Session is inactive or unavailable.')
            return
        }

        if (terminalRegistry.countForSocket(socket.id) >= maxTerminalsPerSocket) {
            emitTerminalError(terminalId, `Too many terminals open (max ${maxTerminalsPerSocket}).`)
            return
        }

        if (terminalRegistry.countForSession(sessionId) >= maxTerminalsPerSession) {
            emitTerminalError(terminalId, `Too many terminals open for this session (max ${maxTerminalsPerSession}).`)
            return
        }

        const cliSocketId = pickCliSocketId(sessionId)
        if (!cliSocketId) {
            emitTerminalError(terminalId, 'CLI is not connected for this session.')
            return
        }

        const entry = terminalRegistry.register(terminalId, sessionId, socket.id, cliSocketId)
        if (!entry) {
            emitTerminalError(terminalId, 'Terminal ID is already in use.')
            return
        }

        const cliSocket = cliNamespace.sockets.get(cliSocketId)
        if (!cliSocket) {
            terminalRegistry.remove(terminalId)
            emitTerminalError(terminalId, 'CLI is not connected for this session.')
            return
        }

        cliSocket.emit('terminal:open', {
            sessionId,
            terminalId,
            cols,
            rows
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
        cliSocket.emit('terminal:write', {
            sessionId: entry.sessionId,
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
        cliSocket.emit('terminal:resize', {
            sessionId: entry.sessionId,
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
        const removed = terminalRegistry.removeBySocket(socket.id)
        for (const entry of removed) {
            emitCloseToCli(entry)
        }
    })
}
