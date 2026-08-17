import { z } from 'zod'
import {
    TerminalErrorPayloadSchema,
    TerminalExitPayloadSchema,
    TerminalOutputPayloadSchema,
    TerminalReadyPayloadSchema
} from '@hapi/protocol'
import type { StoredSession } from '../../../store'
import type { TerminalRegistry, TerminalRegistryEntry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { appendAgentTerminalOutput, clearAgentTerminalBuffer } from '../../agentTerminalBuffer'
import { appendUserTerminalOutput } from '../../userTerminalBuffer'

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

function emitToTerminalViewers(
    terminalNamespace: SocketNamespace,
    entry: TerminalRegistryEntry,
    event: string,
    payload: unknown
): boolean {
    let emitted = false
    for (const socketId of entry.viewerSocketIds) {
        const terminalSocket = terminalNamespace.sockets.get(socketId)
        if (!terminalSocket) {
            continue
        }
        terminalSocket.emit(event, payload)
        emitted = true
    }
    return emitted
}

export function registerTerminalHandlers(socket: CliSocketWithData, deps: TerminalHandlersDeps): void {
    const { terminalRegistry, terminalNamespace, resolveSessionAccess, emitAccessError } = deps

    const resolveOwnedEntry = (payload: { sessionId: string; terminalId: string }) => {
        const entry = terminalRegistry.get(payload.terminalId)
        if (!entry || entry.cliSocketId !== socket.id || payload.sessionId !== entry.sessionId) return null
        const sessionAccess = resolveSessionAccess(payload.sessionId)
        if (!sessionAccess.ok) {
            emitAccessError('session', payload.sessionId, sessionAccess.reason)
            return null
        }
        return entry
    }

    const ownsAgentSession = (sessionId: string): boolean => socket.rooms.has(`session:${sessionId}`)

    socket.on('terminal:ready', (data: unknown) => {
        const parsed = terminalReadySchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        const entry = resolveOwnedEntry(parsed.data)
        if (!entry) {
            return
        }
        emitToTerminalViewers(terminalNamespace, entry, 'terminal:ready', parsed.data)
        terminalRegistry.markActivity(parsed.data.terminalId)
    })

    socket.on('terminal:output', (data: unknown) => {
        const parsed = terminalOutputSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        const entry = resolveOwnedEntry(parsed.data)
        if (!entry) return
        terminalRegistry.markActivity(parsed.data.terminalId)
        // The PTY is server-side and durable. Buffer output even with zero web
        // viewers, then fan live bytes out to every currently attached viewer.
        appendUserTerminalOutput(parsed.data.sessionId, parsed.data.terminalId, parsed.data.data)
        emitToTerminalViewers(terminalNamespace, entry, 'terminal:output', parsed.data)
    })

    socket.on('agent-terminal:output', (data: unknown) => {
        const parsed = terminalOutputSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        if (!ownsAgentSession(parsed.data.sessionId)) return
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
        if (!ownsAgentSession(parsed.data.sessionId)) return
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
        // remove() clears the server-side resource and its scrollback, but the
        // returned entry still carries the viewer set so every UI can be told.
        terminalRegistry.remove(parsed.data.terminalId)
        emitToTerminalViewers(terminalNamespace, entry, 'terminal:exit', parsed.data)
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

        terminalRegistry.remove(parsed.data.terminalId)
        emitToTerminalViewers(terminalNamespace, entry, 'terminal:error', parsed.data)
    })
}

export function cleanupTerminalHandlers(socket: CliSocketWithData, deps: { terminalRegistry: TerminalRegistry; terminalNamespace: SocketNamespace }): void {
    const removed = deps.terminalRegistry.removeByCliSocket(socket.id)
    for (const entry of removed) {
        emitToTerminalViewers(deps.terminalNamespace, entry, 'terminal:error', {
            terminalId: entry.terminalId,
            message: 'CLI disconnected.'
        })
    }
}
