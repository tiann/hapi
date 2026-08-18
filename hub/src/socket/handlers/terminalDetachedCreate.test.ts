import { describe, expect, it } from 'bun:test'
import { appendUserTerminalOutput, clearUserTerminalBuffer } from '../userTerminalBuffer'
import { TerminalRegistry } from '../terminalRegistry'
import type { SocketServer, SocketWithData } from '../socketTypes'
import { registerTerminalHandlers } from './terminal'

type EmittedEvent = { event: string; data: unknown }
type Handler = (...args: unknown[]) => void

class FakeSocket {
    readonly id: string
    readonly data: Record<string, unknown> = {}
    readonly emitted: EmittedEvent[] = []
    readonly rooms = new Set<string>()
    nsp: FakeNamespace | null = null
    private readonly handlers = new Map<string, Handler>()

    constructor(id: string) {
        this.id = id
    }

    on(event: string, handler: Handler): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(event: string, data: unknown): boolean {
        this.emitted.push({ event, data })
        return true
    }

    join(room: string): void {
        this.rooms.add(room)
        if (!this.nsp) return
        const members = this.nsp.adapter.rooms.get(room) ?? new Set<string>()
        members.add(this.id)
        this.nsp.adapter.rooms.set(room, members)
    }

    leave(room: string): void {
        this.rooms.delete(room)
        if (!this.nsp) return
        const members = this.nsp.adapter.rooms.get(room)
        members?.delete(this.id)
        if (members?.size === 0) {
            this.nsp.adapter.rooms.delete(room)
        }
    }

    trigger(event: string, data?: unknown): void {
        const handler = this.handlers.get(event)
        if (!handler) return
        if (typeof data === 'undefined') {
            handler()
        } else {
            handler(data)
        }
    }
}

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>()
    readonly adapter = { rooms: new Map<string, Set<string>>() }
}

class FakeServer {
    private readonly namespaces = new Map<string, FakeNamespace>()

    of(name: string): FakeNamespace {
        const existing = this.namespaces.get(name)
        if (existing) return existing
        const namespace = new FakeNamespace()
        this.namespaces.set(name, namespace)
        return namespace
    }
}

function setup(options?: { maxTerminalsPerSocket?: number }) {
    const io = new FakeServer()
    const terminalNamespace = io.of('/terminal')
    const cliNamespace = io.of('/cli')
    const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
    const terminalSocket = new FakeSocket('web-1')
    terminalSocket.data.namespace = 'default'
    terminalSocket.nsp = terminalNamespace
    terminalNamespace.sockets.set(terminalSocket.id, terminalSocket)

    registerTerminalHandlers(terminalSocket as unknown as SocketWithData, {
        io: io as unknown as SocketServer,
        getSession: () => ({ active: true, namespace: 'default' }),
        terminalRegistry,
        maxTerminalsPerSocket: options?.maxTerminalsPerSocket ?? 4,
        maxTerminalsPerSession: 4,
    })

    const cliSocket = new FakeSocket('cli-1')
    cliSocket.data.namespace = 'default'
    cliNamespace.sockets.set(cliSocket.id, cliSocket)
    cliNamespace.adapter.rooms.set('session:session-1', new Set([cliSocket.id]))
    cliNamespace.adapter.rooms.set('session:session-2', new Set([cliSocket.id]))

    return { terminalSocket, cliSocket, terminalRegistry }
}

function outputEvents(socket: FakeSocket): EmittedEvent[] {
    return socket.emitted.filter((event) => event.event === 'terminal:output')
}

describe('detached terminal creation', () => {
    it('buffers startup output and replays it exactly once on the first explicit attach', () => {
        clearUserTerminalBuffer('session-1', 'terminal-1')
        const { terminalSocket, cliSocket, terminalRegistry } = setup()

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24,
            attach: false,
        })

        expect(terminalRegistry.get('terminal-1')?.viewerSocketIds.size).toBe(0)
        expect(cliSocket.emitted.some((event) => event.event === 'terminal:open')).toBe(true)

        // Models CLI startup bytes arriving after PTY creation but before the
        // browser has selected/mounted the terminal. The CLI handler owns the
        // same server-side buffer in production.
        appendUserTerminalOutput('session-1', 'terminal-1', 'startup prompt$ ')
        expect(outputEvents(terminalSocket)).toHaveLength(0)

        terminalSocket.trigger('terminal:attach', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24,
        })

        expect(outputEvents(terminalSocket)).toEqual([
            {
                event: 'terminal:output',
                data: { terminalId: 'terminal-1', data: 'startup prompt$ ' },
            },
        ])
        expect(terminalRegistry.isViewer('terminal-1', terminalSocket.id)).toBe(true)

        terminalSocket.trigger('terminal:attach', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 100,
            rows: 30,
        })

        expect(outputEvents(terminalSocket)).toHaveLength(1)
        clearUserTerminalBuffer('session-1', 'terminal-1')
    })

    it('keeps create-as-attach as the default for legacy clients', () => {
        const { terminalSocket, terminalRegistry } = setup()

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'legacy-terminal',
            cols: 80,
            rows: 24,
        })

        expect(terminalRegistry.isViewer('legacy-terminal', terminalSocket.id)).toBe(true)
    })

    it('enforces the per-socket resource cap even when creates are detached', () => {
        const { terminalSocket, terminalRegistry } = setup({ maxTerminalsPerSocket: 1 })

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24,
            attach: false,
        })
        expect(terminalRegistry.get('terminal-1')).not.toBeNull()
        expect(terminalRegistry.countForSocket(terminalSocket.id)).toBe(0)

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-2',
            terminalId: 'terminal-2',
            cols: 80,
            rows: 24,
            attach: false,
        })

        expect(terminalRegistry.get('terminal-2')).toBeNull()
        expect(
            [...terminalSocket.emitted].reverse().find((event) => event.event === 'terminal:error')?.data
        ).toEqual({
            terminalId: 'terminal-2',
            message: 'Too many terminals open (max 1).',
        })
    })
})
