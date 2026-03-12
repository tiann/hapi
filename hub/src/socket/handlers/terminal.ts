import { TerminalOpenPayloadSchema } from '@zs/protocol'
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
    terminalRegistry: TerminalRegistry
    maxTerminalsPerSocket: number
    maxTerminalsPerSession: number
}

export function registerTerminalHandlers(socket: SocketWithData, deps: TerminalHandlersDeps): void {
    const { io, getSession, terminalRegistry, maxTerminalsPerSocket, maxTerminalsPerSession } = deps
    const cliNamespace = io.of('/cli')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    const logTerminalEvent = (
        level: 'log' | 'error',
        stage: string,
        outcome: 'start' | 'success' | 'error' | 'duplicate' | 'retry',
        details: Record<string, unknown>
    ) => {
        const message = `[Terminal] stage=${stage} outcome=${outcome}`
        if (level === 'error') {
            console.error(message, details)
            return
        }
        console.log(message, details)
    }

    const emitTerminalError = (terminalId: string, message: string, cause?: string, context?: Record<string, unknown>) => {
        logTerminalEvent('error', 'error.emit', 'error', {
            terminalId,
            cause: cause ?? 'terminal_error',
            message,
            socketId: socket.id,
            namespace,
            ...context
        })
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
                emitTerminalError(entry.terminalId, 'CLI disconnected.', 'cli_disconnected', {
                    sessionId: entry.sessionId,
                    cliSocketId: entry.cliSocketId
                })
            }
            return null
        }
        return cliSocket
    }

    const emitCloseToCli = (entry: TerminalRegistryEntry): void => {
        const cliSocket = cliNamespace.sockets.get(entry.cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            return
        }
        cliSocket.emit('terminal:close', {
            sessionId: entry.sessionId,
            terminalId: entry.terminalId
        })
    }

    const emitOpenToCli = (cliSocketId: string, payload: { sessionId: string; terminalId: string; cols: number; rows: number }): boolean => {
        const cliSocket = cliNamespace.sockets.get(cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) {
            return false
        }
        cliSocket.emit('terminal:open', payload)
        return true
    }

    const pickCliSocketId = (sessionId: string): string | null => {
        const room = cliNamespace.adapter.rooms.get(`session:${sessionId}`)
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

        const { sessionId, terminalId, cols, rows } = parsed.data
        logTerminalEvent('log', 'terminal.create.received', 'start', {
            sessionId,
            terminalId,
            cols,
            rows,
            socketId: socket.id,
            namespace
        })

        const session = getSession(sessionId)
        if (!namespace || !session || session.namespace !== namespace || !session.active) {
            emitTerminalError(terminalId, 'Session is inactive or unavailable.', 'session_inactive_or_unavailable', {
                sessionId,
                socketId: socket.id,
                namespace,
                sessionNamespace: session?.namespace ?? null,
                sessionActive: session?.active ?? null
            })
            return
        }

        if (terminalRegistry.countForSocket(socket.id) >= maxTerminalsPerSocket) {
            emitTerminalError(terminalId, `Too many terminals open (max ${maxTerminalsPerSocket}).`, 'terminal_limit_exceeded_per_socket', {
                sessionId,
                socketId: socket.id,
                maxTerminalsPerSocket
            })
            return
        }

        if (terminalRegistry.countForSession(sessionId) >= maxTerminalsPerSession) {
            emitTerminalError(terminalId, `Too many terminals open for this session (max ${maxTerminalsPerSession}).`, 'terminal_limit_exceeded_per_session', {
                sessionId,
                terminalId,
                maxTerminalsPerSession
            })
            return
        }

        const cliSocketId = pickCliSocketId(sessionId)
        if (!cliSocketId) {
            emitTerminalError(terminalId, 'CLI is not connected for this session.', 'cli_not_connected_for_session', {
                sessionId,
                terminalId
            })
            return
        }

        const openPayload = {
            sessionId,
            terminalId,
            cols,
            rows
        }

        const entry = terminalRegistry.register(terminalId, sessionId, socket.id, cliSocketId)
        if (!entry) {
            const existing = terminalRegistry.get(terminalId)
            if (!existing) {
                emitTerminalError(terminalId, 'Terminal ID is already in use.', 'terminal_id_conflict', {
                    sessionId,
                    terminalId,
                    socketId: socket.id
                })
                return
            }

            if (existing.sessionId !== sessionId || existing.socketId !== socket.id) {
                emitTerminalError(terminalId, 'Terminal ID is already in use.', 'terminal_id_conflict', {
                    sessionId,
                    terminalId,
                    socketId: socket.id,
                    existingSessionId: existing.sessionId,
                    existingSocketId: existing.socketId
                })
                return
            }

            logTerminalEvent('log', 'terminal.create.duplicate', 'duplicate', {
                sessionId,
                terminalId,
                socketId: socket.id,
                existingCliSocketId: existing.cliSocketId,
                requestedCliSocketId: cliSocketId
            })

            if (!emitOpenToCli(existing.cliSocketId, openPayload)) {
                logTerminalEvent('log', 'terminal.open.forward', 'retry', {
                    sessionId,
                    terminalId,
                    reason: 'existing_cli_socket_missing',
                    existingCliSocketId: existing.cliSocketId,
                    retryCliSocketId: cliSocketId
                })

                terminalRegistry.remove(terminalId)
                const retryEntry = terminalRegistry.register(terminalId, sessionId, socket.id, cliSocketId)
                if (!retryEntry) {
                    emitTerminalError(terminalId, 'Terminal ID is already in use.', 'terminal_id_conflict', {
                        sessionId,
                        terminalId,
                        socketId: socket.id,
                        reason: 'retry_register_failed'
                    })
                    return
                }
                if (!emitOpenToCli(retryEntry.cliSocketId, openPayload)) {
                    terminalRegistry.remove(terminalId)
                    emitTerminalError(terminalId, 'CLI is not connected for this session.', 'cli_not_connected_for_session', {
                        sessionId,
                        terminalId,
                        cliSocketId: retryEntry.cliSocketId,
                        reason: 'retry_open_failed'
                    })
                    return
                }
                terminalRegistry.markActivity(terminalId)
                logTerminalEvent('log', 'terminal.open.forward', 'success', {
                    sessionId,
                    terminalId,
                    cliSocketId: retryEntry.cliSocketId,
                    mode: 'retry'
                })
                return
            }

            terminalRegistry.markActivity(terminalId)
            logTerminalEvent('log', 'terminal.open.forward', 'success', {
                sessionId,
                terminalId,
                cliSocketId: existing.cliSocketId,
                mode: 'duplicate-idempotent'
            })
            return
        }

        if (!emitOpenToCli(cliSocketId, openPayload)) {
            terminalRegistry.remove(terminalId)
            emitTerminalError(terminalId, 'CLI is not connected for this session.', 'cli_not_connected_for_session', {
                sessionId,
                terminalId,
                cliSocketId,
                reason: 'initial_open_failed'
            })
            return
        }

        terminalRegistry.markActivity(terminalId)
        logTerminalEvent('log', 'terminal.open.forward', 'success', {
            sessionId,
            terminalId,
            cliSocketId,
            mode: 'initial'
        })

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
        logTerminalEvent('log', 'terminal.close', 'success', {
            sessionId: entry.sessionId,
            terminalId,
            socketId: socket.id,
            cliSocketId: entry.cliSocketId
        })
    })

    socket.on('disconnect', () => {
        const removed = terminalRegistry.removeBySocket(socket.id)
        for (const entry of removed) {
            emitCloseToCli(entry)
        }
        logTerminalEvent('log', 'terminal.socket.disconnect', 'success', {
            socketId: socket.id,
            namespace,
            removedTerminalCount: removed.length,
            removedTerminalIds: removed.map((entry) => entry.terminalId)
        })
    })
}
