import { describe, expect, it } from 'bun:test'
import { TerminalRegistry } from '../../terminalRegistry'
import { registerTerminalHandlers } from './terminalHandlers'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessResult } from './types'
import type { StoredSession } from '../../../store'

type EmittedEvent = {
    event: string
    data: unknown
}

class FakeSocket {
    readonly id: string
    readonly emitted: EmittedEvent[] = []
    readonly data: Record<string, unknown> = {}
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

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>()
}

function lastEmit(socket: FakeSocket, event: string): EmittedEvent | undefined {
    return [...socket.emitted].reverse().find((entry) => entry.event === event)
}

describe('cli terminal handlers', () => {
    it('forwards terminal exit once and removes registry entry', () => {
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
        const terminalNamespace = new FakeNamespace()
        const cliSocket = new FakeSocket('cli-socket-1')
        const terminalSocket = new FakeSocket('terminal-socket-1')
        terminalNamespace.sockets.set(terminalSocket.id, terminalSocket)

        terminalRegistry.register('terminal-1', 'session-1', terminalSocket.id, cliSocket.id)

        const resolveSessionAccess = (): AccessResult<StoredSession> => ({
            ok: true,
            value: { id: 'session-1' } as StoredSession
        })

        registerTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as unknown as ReturnType<SocketServer['of']>,
            resolveSessionAccess,
            emitAccessError: () => {}
        })

        cliSocket.trigger('terminal:exit', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            code: 0,
            signal: null
        })

        expect(terminalRegistry.get('terminal-1')).toBeNull()
        const exitEvent = lastEmit(terminalSocket, 'terminal:exit')
        expect(exitEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            code: 0,
            signal: null
        })
    })

    it('ignores stale terminal payloads', () => {
        const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
        const terminalNamespace = new FakeNamespace()
        const cliSocket = new FakeSocket('cli-socket-1')
        const terminalSocket = new FakeSocket('terminal-socket-1')
        terminalNamespace.sockets.set(terminalSocket.id, terminalSocket)

        terminalRegistry.register('terminal-1', 'session-1', terminalSocket.id, cliSocket.id)

        const resolveSessionAccess = (): AccessResult<StoredSession> => ({
            ok: true,
            value: { id: 'session-1' } as StoredSession
        })

        registerTerminalHandlers(cliSocket as unknown as CliSocketWithData, {
            terminalRegistry,
            terminalNamespace: terminalNamespace as unknown as ReturnType<SocketServer['of']>,
            resolveSessionAccess,
            emitAccessError: () => {}
        })

        cliSocket.trigger('terminal:output', {
            sessionId: 'session-1',
            terminalId: 'missing-terminal',
            data: 'hello'
        })

        cliSocket.trigger('terminal:exit', {
            sessionId: 'session-2',
            terminalId: 'terminal-1',
            code: 0,
            signal: null
        })

        expect(lastEmit(terminalSocket, 'terminal:output')).toBeUndefined()
        expect(lastEmit(terminalSocket, 'terminal:exit')).toBeUndefined()
        expect(terminalRegistry.get('terminal-1')).not.toBeNull()
    })
})
