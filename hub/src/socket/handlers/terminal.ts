import { TerminalOpenPayloadSchema } from '@hapi/protocol'
import { z } from 'zod'
import type { TerminalRegistry, TerminalRegistryEntry } from '../terminalRegistry'
import type { SocketServer, SocketWithData } from '../socketTypes'
import { getAgentTerminalReplay } from '../agentTerminalBuffer'
import { getUserTerminalBuffer } from '../userTerminalBuffer'

// Legacy clients treated terminal:create as create-and-attach. Keep that as the
// default while allowing the persistent Web Terminal to create a durable PTY
// resource first and attach only after authoritative inventory selects it.
const terminalCreateSchema = TerminalOpenPayloadSchema.extend({
    attach: z.boolean().optional().default(true)
})

const terminalListSchema = z.object({
    sessionId: z.string().min(1)
})

const terminalAttachSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

const terminalDetachSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1)
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

// sessionId is optional for compatibility with older web clients. New clients
// include it so they can explicitly close a detached terminal from the selector.
const terminalCloseSchema = z.object({
    sessionId: z.string().min(1).optional(),
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
    const terminalNamespace = io.of('/terminal')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    // The socket-level limit is an admission-control policy for resources this
    // connection creates, not a viewer count. Persistent terminals can be born
    // detached and can outlive this socket, so keep the accounting local to the
    // connection instead of coupling it to the durable registry's viewer index.
    const createdTerminalIds = new Set<string>()
    const countLiveCreatedTerminals = (): number => {
        for (const terminalId of createdTerminalIds) {
            if (!terminalRegistry.get(terminalId)) {
                createdTerminalIds.delete(terminalId)
            }
        }
        return createdTerminalIds.size
    }

    const emitTerminalError = (terminalId: string, message: string) => {
        socket.emit('terminal:error', { terminalId, message })
    }

    const isAuthorizedSession = (sessionId: string): boolean => {
        const session = getSession(sessionId)
        return Boolean(namespace && session && session.namespace === namespace && session.active)
    }

    const subscribeToTerminalSession = (sessionId: string): void => {
        // Keep the existing room membership for compatibility with the rest of
        // the socket server, while the registry tracks selector subscribers so
        // inventory updates are not tied to ownership of a PTY.
        socket.join(`session:${sessionId}`)
        terminalRegistry.subscribeSession(sessionId, socket.id)
    }

    const buildTerminalSessions = (sessionId: string) => ({
        sessionId,
        maxTerminals: maxTerminalsPerSession,
        terminals: terminalRegistry.listForSession(sessionId).map((entry) => ({
            terminalId: entry.terminalId,
            createdAt: entry.createdAt,
            attached: entry.viewerSocketIds.size > 0
        }))
    })

    const emitTerminalSessions = (sessionId: string): void => {
        if (!isAuthorizedSession(sessionId)) {
            return
        }

        const payload = buildTerminalSessions(sessionId)
        const subscribers = terminalRegistry.subscribersForSession(sessionId)
        if (subscribers.length === 0) {
            socket.emit('terminal:sessions', payload)
            return
        }

        for (const socketId of subscribers) {
            if (socketId === socket.id) {
                socket.emit('terminal:sessions', payload)
                continue
            }
            terminalNamespace.sockets.get(socketId)?.emit('terminal:sessions', payload)
        }
    }

    const resolveEntryForSocket = (terminalId: string): TerminalRegistryEntry | null => {
        const entry = terminalRegistry.get(terminalId)
        if (!entry || !terminalRegistry.isViewer(terminalId, socket.id)) {
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
            emitTerminalSessions(entry.sessionId)
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

    const replayTerminalBuffer = (sessionId: string, terminalId: string): void => {
        const buffered = getUserTerminalBuffer(sessionId, terminalId)
        if (buffered) {
            socket.emit('terminal:output', { terminalId, data: buffered })
        }
    }

    const attachExistingTerminal = (
        entry: TerminalRegistryEntry,
        cols: number,
        rows: number
    ): boolean => {
        const cliSocket = resolveCliSocket(entry, true)
        if (!cliSocket) {
            return false
        }
        const shouldReplay = !terminalRegistry.isViewer(entry.terminalId, socket.id)
        const attached = terminalRegistry.attach(entry.terminalId, entry.sessionId, socket.id)
        if (!attached) {
            emitTerminalError(entry.terminalId, 'Terminal is unavailable.')
            return false
        }

        subscribeToTerminalSession(entry.sessionId)
        cliSocket.emit('terminal:resize', {
            sessionId: entry.sessionId,
            terminalId: entry.terminalId,
            cols,
            rows
        })
        terminalRegistry.markActivity(entry.terminalId)
        if (shouldReplay) {
            replayTerminalBuffer(entry.sessionId, entry.terminalId)
        }
        // Existing PTYs do not emit terminal:ready again from the CLI on attach,
        // so acknowledge this viewer directly from the hub.
        socket.emit('terminal:ready', {
            sessionId: entry.sessionId,
            terminalId: entry.terminalId
        })
        emitTerminalSessions(entry.sessionId)
        return true
    }

    socket.on('terminal:list', (data: unknown) => {
        const parsed = terminalListSchema.safeParse(data)
        if (!parsed.success || !isAuthorizedSession(parsed.data.sessionId)) {
            return
        }
        subscribeToTerminalSession(parsed.data.sessionId)
        emitTerminalSessions(parsed.data.sessionId)
    })

    socket.on('terminal:create', (data: unknown) => {
        const parsed = terminalCreateSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sessionId, terminalId, cols, rows, attach } = parsed.data
        if (!isAuthorizedSession(sessionId)) {
            emitTerminalError(terminalId, 'Session is inactive or unavailable.')
            return
        }
        subscribeToTerminalSession(sessionId)

        const existingEntry = terminalRegistry.get(terminalId)
        if (existingEntry) {
            if (existingEntry.sessionId !== sessionId) {
                emitTerminalError(terminalId, 'Terminal ID is already in use.')
                return
            }
            // terminal:create historically doubled as reconnect, so omitted
            // attach still attaches. New clients can explicitly keep an already
            // existing resource detached while waiting for inventory selection.
            if (attach) {
                attachExistingTerminal(existingEntry, cols, rows)
            } else {
                emitTerminalSessions(sessionId)
            }
            return
        }

        if (countLiveCreatedTerminals() >= maxTerminalsPerSocket) {
            emitTerminalError(terminalId, `Too many terminals open (max ${maxTerminalsPerSocket}).`)
            return
        }

        if (terminalRegistry.countForSession(sessionId) >= maxTerminalsPerSession) {
            emitTerminalError(terminalId, `Too many terminals open for this session (max ${maxTerminalsPerSession}).`)
            emitTerminalSessions(sessionId)
            return
        }

        const cliSocketId = pickCliSocketId(sessionId)
        if (!cliSocketId) {
            emitTerminalError(terminalId, 'CLI is not connected for this session.')
            return
        }

        const entry = terminalRegistry.register(terminalId, sessionId, attach ? socket.id : null, cliSocketId)
        if (!entry) {
            emitTerminalError(terminalId, 'Terminal ID is already in use.')
            return
        }

        const cliSocket = cliNamespace.sockets.get(cliSocketId)
        if (!cliSocket) {
            terminalRegistry.remove(terminalId)
            emitTerminalError(terminalId, 'CLI is not connected for this session.')
            emitTerminalSessions(sessionId)
            return
        }

        createdTerminalIds.add(terminalId)
        cliSocket.emit('terminal:open', {
            sessionId,
            terminalId,
            cols,
            rows
        })
        terminalRegistry.markActivity(terminalId)
        emitTerminalSessions(sessionId)
    })

    socket.on('terminal:attach', (data: unknown) => {
        const parsed = terminalAttachSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        const { sessionId, terminalId, cols, rows } = parsed.data
        if (!isAuthorizedSession(sessionId)) {
            emitTerminalError(terminalId, 'Session is inactive or unavailable.')
            return
        }
        subscribeToTerminalSession(sessionId)
        const entry = terminalRegistry.get(terminalId)
        if (!entry || entry.sessionId !== sessionId) {
            emitTerminalError(terminalId, 'Terminal not found.')
            emitTerminalSessions(sessionId)
            return
        }

        attachExistingTerminal(entry, cols, rows)
    })

    socket.on('terminal:detach', (data: unknown) => {
        const parsed = terminalDetachSchema.safeParse(data)
        if (!parsed.success || !isAuthorizedSession(parsed.data.sessionId)) {
            return
        }
        const { sessionId, terminalId } = parsed.data
        const entry = terminalRegistry.get(terminalId)
        if (!entry || entry.sessionId !== sessionId) {
            return
        }
        terminalRegistry.detach(terminalId, socket.id)
        emitTerminalSessions(sessionId)
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

        const { terminalId, sessionId: requestedSessionId } = parsed.data
        const entry = terminalRegistry.get(terminalId)
        if (!entry) {
            createdTerminalIds.delete(terminalId)
            if (requestedSessionId && isAuthorizedSession(requestedSessionId)) {
                subscribeToTerminalSession(requestedSessionId)
                emitTerminalSessions(requestedSessionId)
            }
            return
        }

        if (requestedSessionId) {
            if (entry.sessionId !== requestedSessionId || !isAuthorizedSession(requestedSessionId)) {
                return
            }
            subscribeToTerminalSession(requestedSessionId)
        } else if (!terminalRegistry.isViewer(terminalId, socket.id)) {
            // Legacy clients omit sessionId and may close only a terminal they
            // are currently attached to.
            return
        }

        terminalRegistry.remove(terminalId)
        createdTerminalIds.delete(terminalId)
        emitCloseToCli(entry)
        emitTerminalSessions(entry.sessionId)
    })

    /** Returns false when no CLI socket owns this session in the caller's namespace. */
    const emitToCliForSession = (sessionId: string, event: 'agent-terminal:resize' | 'agent-terminal:refresh' | 'agent-terminal:idle' | 'agent-terminal:input', payload: Record<string, unknown>): boolean => {
        const cliSocketId = pickCliSocketId(sessionId)
        if (!cliSocketId) return false
        const cliSocket = cliNamespace.sockets.get(cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) return false
        cliSocket.emit(event, payload as never)
        return true
    }

    // Sessions this socket is viewing the agent terminal for. When the last
    // viewer of a session leaves (this socket unsubscribes or disconnects and the
    // room empties), tell the CLI to stop streaming that PTY.
    //
    // Agent-terminal viewers get their OWN room, distinct from the user-terminal's
    // `session:${id}` room: the streaming-teardown count must reflect agent-terminal
    // viewers only, otherwise a user-terminal viewer in `session:${id}` would keep
    // the agent PTY streaming forever after every agent-terminal viewer has left.
    const agentTerminalRoom = (sessionId: string): string => `agent-session:${sessionId}`
    const subscribedAgentSessions = new Set<string>()
    // A valid token for one namespace must not be able to act on (subscribe to,
    // replay, or drive) a session in another namespace. Same shape as the
    // terminal:create guard. Callers drop silently rather than leaking existence.
    const tellCliIfNoViewers = (sessionId: string): void => {
        const size = socket.nsp.adapter.rooms.get(agentTerminalRoom(sessionId))?.size ?? 0
        if (size === 0) {
            emitToCliForSession(sessionId, 'agent-terminal:idle', { sessionId })
        }
    }

    socket.on('agent-terminal:subscribe', (data: unknown) => {
        const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(data)
        if (!parsed.success) {
            return
        }
        const { sessionId } = parsed.data
        if (!isAuthorizedSession(sessionId)) {
            return
        }
        socket.join(agentTerminalRoom(sessionId))
        subscribedAgentSessions.add(sessionId)
        // Full-screen TUIs (agy's bubbletea alt-screen, claude's ink) can't always
        // be reconstructed from a byte-ring replay. Ask the CLI to repaint first.
        const askedCliToRepaint = emitToCliForSession(sessionId, 'agent-terminal:refresh', { sessionId })
        if (!askedCliToRepaint) {
            const buffered = getAgentTerminalReplay(sessionId)
            if (buffered) {
                socket.emit('agent-terminal:output', { sessionId, terminalId: 'agent', data: buffered })
            }
        }
    })

    socket.on('agent-terminal:unsubscribe', (data: unknown) => {
        const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(data)
        if (!parsed.success) {
            return
        }
        const { sessionId } = parsed.data
        socket.leave(agentTerminalRoom(sessionId))
        subscribedAgentSessions.delete(sessionId)
        tellCliIfNoViewers(sessionId)
    })

    socket.on('agent-terminal:resize', (data: unknown) => {
        const parsed = z.object({
            sessionId: z.string().min(1),
            cols: z.number().int().positive(),
            rows: z.number().int().positive()
        }).safeParse(data)
        if (!parsed.success) {
            return
        }
        const { sessionId, cols, rows } = parsed.data
        if (!isAuthorizedSession(sessionId)) {
            return
        }
        emitToCliForSession(sessionId, 'agent-terminal:resize', { sessionId, cols, rows })
    })

    // Raw keystroke(s) from a viewer → relay to the CLI to write into the agent
    // PTY. Same authorization guard as resize.
    socket.on('agent-terminal:input', (data: unknown) => {
        const parsed = z.object({
            sessionId: z.string().min(1),
            data: z.string().min(1)
        }).safeParse(data)
        if (!parsed.success) {
            return
        }
        const { sessionId, data: keys } = parsed.data
        if (!isAuthorizedSession(sessionId)) {
            return
        }
        emitToCliForSession(sessionId, 'agent-terminal:input', { sessionId, data: keys })
    })

    socket.on('disconnect', () => {
        // Browser sockets are only viewers. Detach this viewer and forget its
        // selector subscriptions; the PTYs remain alive until close/exit/idle.
        const detached = terminalRegistry.detachBySocket(socket.id)
        for (const sessionId of new Set(detached.map((entry) => entry.sessionId))) {
            emitTerminalSessions(sessionId)
        }
        createdTerminalIds.clear()
        // On disconnect the socket has already left its rooms, so the room size
        // now reflects the remaining agent-terminal viewers.
        for (const sessionId of subscribedAgentSessions) {
            tellCliIfNoViewers(sessionId)
        }
    })
}
