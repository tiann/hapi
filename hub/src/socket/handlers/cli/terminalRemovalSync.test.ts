import { describe, expect, it } from 'bun:test'
import type { StoredSession } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { TerminalRegistry } from '../../terminalRegistry'
import { cleanupTerminalHandlers, registerTerminalHandlers } from './terminalHandlers'

type EmittedEvent = { event: string; data: unknown }
type RoomEmit = { room: string; event: string; data: unknown }

class FakeSocket {
    readonly id: string
    readonly rooms = new Set<string>()
    readonly emitted: EmittedEvent[] = []
    private readonly handlers = new Map<string, (...args: unknown[]) => void>()

    constructor(id: string) {
        this.id = id
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(event: string, data: unknown): boolean {
        this.emitted.push({ event, data })
        return true
    }

    trigger(event: string, data?: unknown): void {
        const handler = this.handlers.get(event)
        if (!handler) return
        if (typeof data === 'undefined') handler()
        else handler(data)
    }
}

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>()
    readonly roomEmits: RoomEmit[] = []

    to(room: string): { emit: (event: string, data: unknown) => FakeNamespace } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEmits.push({ room, event, data })
                return this
            }
        }
    }
}

function registerDetachedTerminal(
    terminalRegistry: TerminalRegistry,
    terminalId: string,
    cliSocketId: string
): void {
    terminalRegistry.register(terminalId, 'session-1', 'old-viewer', cliSocketId)
    terminalRegistry.detachBySocket('old-viewer')
    expect(terminalRegistry.get(terminalId)?.viewerSocketIds.size).toBe(0)
}

function registerCliHandler(
    cliSocket: FakeSocket,
    terminalNamespace: FakeNamespace,
    terminalRegistry: TerminalRegistry
): void {
    registerTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
        terminalRegistry,
        terminalNamespace: terminalNamespace as never,
        resolveSessionAccess: () => ({ ok: true, value: {} as StoredSession }),
        emitAccessError: () => {
            throw new Error('Unexpected access error')
        }
    })
}

describe('detached terminal removal synchronization', () => {
    it('broadcasts a detached terminal exit to session inventory subscribers', () => {
        const cliSocket = new FakeSocket('cli-1')
        const terminalNamespace = new FakeNamespace()
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
        registerDetachedTerminal(terminalRegistry, 'terminal-1', cliSocket.id)
        registerCliHandler(cliSocket, terminalNamespace, terminalRegistry)

        cliSocket.trigger('terminal:exit', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            code: 0,
            signal: null
        })

        expect(terminalRegistry.get('terminal-1')).toBeNull()
        expect(terminalNamespace.roomEmits).toEqual([{
            room: 'session:session-1',
            event: 'terminal:exit',
            data: {
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                code: 0,
                signal: null
            }
        }])
    })

    it('ignores a stale exit for an old auto ID after a unique replacement exists', () => {
        const cliSocket = new FakeSocket('cli-1')
        const terminalNamespace = new FakeNamespace()
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
        const replacementId = 'term-session-1-auto-new-nonce'
        terminalRegistry.register(replacementId, 'session-1', 'new-viewer', cliSocket.id)
        registerCliHandler(cliSocket, terminalNamespace, terminalRegistry)

        cliSocket.trigger('terminal:exit', {
            sessionId: 'session-1',
            terminalId: 'term-session-1-auto-old-nonce',
            code: 0,
            signal: null
        })

        expect(terminalRegistry.get(replacementId)?.terminalId).toBe(replacementId)
        expect(terminalNamespace.roomEmits).toHaveLength(0)
    })

    it('broadcasts a detached terminal error to session inventory subscribers', () => {
        const cliSocket = new FakeSocket('cli-1')
        const terminalNamespace = new FakeNamespace()
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
        registerDetachedTerminal(terminalRegistry, 'terminal-1', cliSocket.id)
        registerCliHandler(cliSocket, terminalNamespace, terminalRegistry)

        cliSocket.trigger('terminal:error', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            message: 'PTY failed.'
        })

        expect(terminalRegistry.get('terminal-1')).toBeNull()
        expect(terminalNamespace.roomEmits).toEqual([{
            room: 'session:session-1',
            event: 'terminal:error',
            data: {
                sessionId: 'session-1',
                terminalId: 'terminal-1',
                message: 'PTY failed.'
            }
        }])
    })

    it('broadcasts CLI disconnect removal even when the terminal has zero viewers', () => {
        const cliSocket = new FakeSocket('cli-1')
        const terminalNamespace = new FakeNamespace()
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
        registerDetachedTerminal(terminalRegistry, 'terminal-1', cliSocket.id)

        cleanupTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as never
        })

        expect(terminalRegistry.get('terminal-1')).toBeNull()
        expect(terminalNamespace.roomEmits).toEqual([{
            room: 'session:session-1',
            event: 'terminal:error',
            data: {
                terminalId: 'terminal-1',
                message: 'CLI disconnected.'
            }
        }])
    })
})
