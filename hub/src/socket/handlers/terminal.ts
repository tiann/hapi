import { TerminalOpenPayloadSchema } from '@hapi/protocol'
import { z } from 'zod'
import type { TerminalRegistry, TerminalRegistryEntry } from '../terminalRegistry'
import type { SocketServer, SocketWithData } from '../socketTypes'
import { getAgentTerminalReplay } from '../agentTerminalBuffer'
import { getUserTerminalBuffer } from '../userTerminalBuffer'

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

    socket.on('terminal:create', (data: unknown) => {
        const parsed = terminalCreateSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sessionId, terminalId, cols, rows } = parsed.data
        const session = getSession(sessionId)
        if (!namespace || !session || session.namespace !== namespace || !session.active) {
            emitTerminalError(terminalId, 'Session is inactive or unavailable.')
            return
        }

        const existingEntry = terminalRegistry.get(terminalId)
        const isReconnect = existingEntry?.sessionId === sessionId

        if (!isReconnect && terminalRegistry.countForSocket(socket.id) >= maxTerminalsPerSocket) {
            emitTerminalError(terminalId, `Too many terminals open (max ${maxTerminalsPerSocket}).`)
            return
        }

        if (!isReconnect && terminalRegistry.countForSession(sessionId) >= maxTerminalsPerSession) {
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

        socket.join(`session:${sessionId}`)

        cliSocket.emit('terminal:open', {
            sessionId,
            terminalId,
            cols,
            rows
        })
        terminalRegistry.markActivity(terminalId)

        // Replay buffered output so the terminal shows scrollback immediately
        // instead of staying black until the next output from CLI.
        // The buffer is never explicitly cleared here: it persists so a client
        // that navigates away and back (new socket, isReconnect=false) still
        // sees the accumulated output. It is bounded to 256KB per session.
        const buffered = getUserTerminalBuffer(sessionId)
        if (buffered && !isReconnect) {
            socket.emit('terminal:output', { terminalId, data: buffered })
        }
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

    const emitToCliForSession = (sessionId: string, event: 'agent-terminal:resize' | 'agent-terminal:refresh' | 'agent-terminal:idle' | 'agent-terminal:input', payload: Record<string, unknown>): void => {
        const cliSocketId = pickCliSocketId(sessionId)
        if (!cliSocketId) return
        const cliSocket = cliNamespace.sockets.get(cliSocketId)
        if (!cliSocket || cliSocket.data.namespace !== namespace) return
        cliSocket.emit(event, payload as never)
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
    // terminal:create guard (terminal.ts:95). Callers drop silently rather than
    // emitting an error: surfacing "session inactive/unavailable" to an
    // unauthorized caller would leak existence, and the only honest-client
    // rejection path (a session that just went inactive) unmounts the terminal
    // view anyway via canViewAgentTerminal, so there is no live viewer to inform.
    const isAuthorizedSession = (sessionId: string): boolean => {
        const session = getSession(sessionId)
        return Boolean(namespace && session && session.namespace === namespace && session.active)
    }
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
        // Replay recent output so the terminal renders the current screen
        // immediately instead of staying black until the next keystroke.
        // terminalId must match the web client's filter ('agent'), not a
        // synthetic id, otherwise the replayed data is silently dropped.
        const buffered = getAgentTerminalReplay(sessionId)
        if (buffered) {
            socket.emit('agent-terminal:output', { sessionId, terminalId: 'agent', data: buffered })
        }
        // Full-screen TUIs (e.g. claude's ink alt-screen) can't always
        // be reconstructed from a byte-ring replay (truncated alt-screen enter,
        // stale alt-screen-exit from a prior spawn). Ask the CLI to repaint the
        // current screen so a freshly (re)subscribed viewer never sees black.
        emitToCliForSession(sessionId, 'agent-terminal:refresh', { sessionId })
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
    // PTY. Same authorization guard as resize: only an authorized viewer of an
    // active session in this namespace may drive its TUI.
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
        const removed = terminalRegistry.removeBySocket(socket.id)
        for (const entry of removed) {
            emitCloseToCli(entry)
        }
        // On disconnect the socket has already left its rooms, so the room size
        // now reflects the remaining viewers — tell the CLI to stop streaming any
        // agent terminal this socket was the last viewer of.
        for (const sessionId of subscribedAgentSessions) {
            tellCliIfNoViewers(sessionId)
        }
    })
}
