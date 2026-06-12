import { z } from 'zod'
import {
    TerminalErrorPayloadSchema,
    TerminalExitPayloadSchema,
    TerminalOutputPayloadSchema,
    TerminalReadyPayloadSchema
} from '@hapi/protocol'
import type { StoredSession } from '../../../store'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { appendAgentTerminalOutput, clearAgentTerminalBuffer } from '../../agentTerminalBuffer'
import { appendUserTerminalOutput, clearUserTerminalBuffer } from '../../userTerminalBuffer'

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>

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
    emitAccessError: EmitAccessError
}

export function registerTerminalHandlers(socket: CliSocketWithData, deps: TerminalHandlersDeps): void {
    const { terminalRegistry, terminalNamespace, resolveSessionAccess, emitAccessError } = deps

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
        const sessionAccess = resolveSessionAccess(payload.sessionId)
        if (!sessionAccess.ok) {
            emitAccessError('session', payload.sessionId, sessionAccess.reason)
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
        // Keep a scrollback buffer so reconnecting web clients see the
        // current terminal content instead of a black screen.
        appendUserTerminalOutput(parsed.data.sessionId, parsed.data.terminalId, parsed.data.data)
        forwardTerminalEvent('terminal:output', parsed.data)
    })

    socket.on('agent-terminal:output', (data: unknown) => {
        const parsed = terminalOutputSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        const sessionAccess = resolveSessionAccess(parsed.data.sessionId)
        if (!sessionAccess.ok) {
            emitAccessError('session', parsed.data.sessionId, sessionAccess.reason)
            return
        }
        // Keep a scrollback buffer so a web client that subscribes later can be
        // replayed the current screen (avoids the black-screen-until-keystroke).
        appendAgentTerminalOutput(parsed.data.sessionId, parsed.data.data)
        // Broadcast to the agent-terminal room (distinct from the user-terminal's
        // `session:${id}` room) so only agent-terminal viewers receive PTY output
        // and the streaming-teardown viewer count stays accurate.
        terminalNamespace.to(`agent-session:${parsed.data.sessionId}`).emit('agent-terminal:output', parsed.data)
    })

    socket.on('agent-terminal:reset', (data: unknown) => {
        const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(data)
        if (!parsed.success) {
            return
        }
        const sessionAccess = resolveSessionAccess(parsed.data.sessionId)
        if (!sessionAccess.ok) {
            emitAccessError('session', parsed.data.sessionId, sessionAccess.reason)
            return
        }
        // A fresh agent PTY spawned — drop the previous session's scrollback so a
        // re-subscribing viewer doesn't replay stale (and alt-screen-corrupted)
        // output from before the restart.
        clearAgentTerminalBuffer(parsed.data.sessionId)
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
        // Drop the scrollback so a reconnecting viewer doesn't replay a dead
        // terminal's output, and so the buffer doesn't leak for the session's life.
        clearUserTerminalBuffer(parsed.data.sessionId)
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
        if (!entry || entry.sessionId !== parsed.data.sessionId || entry.cliSocketId !== socket.id) {
            return
        }

        const sessionAccess = resolveSessionAccess(parsed.data.sessionId)
        if (!sessionAccess.ok) {
            terminalRegistry.remove(parsed.data.terminalId)
            emitAccessError('session', parsed.data.sessionId, sessionAccess.reason)
            return
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
            terminalId: entry.terminalId,
            message: 'CLI disconnected.'
        })
    }
}
