import { describe, expect, it } from 'bun:test'
import type { StoredSession } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { TerminalRegistry } from '../../terminalRegistry'
import { registerTerminalHandlers } from './terminalHandlers'

type EmittedEvent = {
    event: string
    data: unknown
}

class FakeSocket {
    readonly id: string
    readonly data: Record<string, unknown> = {}
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
        if (!handler) {
            return
        }
        if (typeof data === 'undefined') {
            handler()
            return
        }
        handler(data)
    }
}

type RoomEmit = {
    room: string
    event: string
    data: unknown
}

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>()
    readonly roomEmits: RoomEmit[] = []

    to(room: string): { emit: (event: string, data: unknown) => FakeNamespace } {
        const self = this
        return {
            emit(event: string, data: unknown) {
                self.roomEmits.push({ room, event, data })
                return self
            }
        }
    }
}

function lastEmit(socket: FakeSocket, event: string): EmittedEvent | undefined {
    return [...socket.emitted].reverse().find((entry) => entry.event === event)
}

function lastRoomEmit(namespace: FakeNamespace, event: string): RoomEmit | undefined {
    return [...namespace.roomEmits].reverse().find((entry) => entry.event === event)
}

function firstRoomEmit(namespace: FakeNamespace, event: string): RoomEmit | undefined {
    return namespace.roomEmits.find((entry) => entry.event === event)
}

describe('cli terminal handlers', () => {
    it('forwards agent-terminal:output to the agent-terminal room on terminal namespace', () => {
        const cliSocket = new FakeSocket('cli-socket')
        const terminalNamespace = new FakeNamespace()
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })

        registerTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as never,
            resolveSessionAccess: () => ({ ok: true, value: {} as StoredSession }),
            emitAccessError: () => {
                throw new Error('Unexpected access error')
            }
        })

        cliSocket.trigger('agent-terminal:output', {
            sessionId: 'session-1',
            terminalId: 'agent',
            data: '\x1b[32mhello\x1b[0m'
        })

        const emit = lastRoomEmit(terminalNamespace, 'agent-terminal:output')
        expect(emit).toBeDefined()
        expect(emit?.room).toBe('agent-session:session-1')
        expect(emit?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'agent',
            data: '\x1b[32mhello\x1b[0m'
        })
    })

    it('rejects agent-terminal:output when session access is denied', () => {
        const cliSocket = new FakeSocket('cli-socket')
        const terminalNamespace = new FakeNamespace()
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
        const accessErrors: { scope: string; id: string; reason: string }[] = []

        registerTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as never,
            resolveSessionAccess: () => ({ ok: false, reason: 'access-denied' }),
            emitAccessError: (scope, id, reason) => {
                accessErrors.push({ scope, id, reason })
            }
        })

        cliSocket.trigger('agent-terminal:output', {
            sessionId: 'session-1',
            terminalId: 'agent',
            data: 'should not pass'
        })

        expect(terminalNamespace.roomEmits).toHaveLength(0)
        expect(accessErrors).toEqual([
            { scope: 'session', id: 'session-1', reason: 'access-denied' }
        ])
    })

    it('removes stale registry entries after terminal errors', () => {
        const cliSocket = new FakeSocket('cli-socket')
        const terminalSocket = new FakeSocket('terminal-socket')
        const terminalNamespace = new FakeNamespace()
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })

        terminalNamespace.sockets.set(terminalSocket.id, terminalSocket)
        terminalRegistry.register('terminal-1', 'session-1', terminalSocket.id, cliSocket.id)

        registerTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as never,
            resolveSessionAccess: () => ({ ok: true, value: {} as StoredSession }),
            emitAccessError: () => {
                throw new Error('Unexpected access error')
            }
        })

        cliSocket.trigger('terminal:error', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            message: 'Remote terminal is not supported on Windows yet.'
        })

        expect(terminalRegistry.get('terminal-1')).toBeNull()
        expect(lastEmit(terminalSocket, 'terminal:error')?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            message: 'Remote terminal is not supported on Windows yet.'
        })
    })
})
