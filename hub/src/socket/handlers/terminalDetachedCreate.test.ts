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

function registerWebSocket(
    io: FakeServer,
    terminalNamespace: FakeNamespace,
    terminalRegistry: TerminalRegistry,
    socket: FakeSocket,
    maxTerminalsPerSocket: number,
    userId = 7
): void {
    socket.data.namespace = 'default'
    socket.data.userId = userId
    socket.nsp = terminalNamespace
    terminalNamespace.sockets.set(socket.id, socket)
    registerTerminalHandlers(socket as unknown as SocketWithData, {
        io: io as unknown as SocketServer,
        getSession: () => ({ active: true, namespace: 'default' }),
        terminalRegistry,
        maxTerminalsPerSocket,
        maxTerminalsPerSession: 4,
    })
}

function setup(options?: { maxTerminalsPerSocket?: number }) {
    const io = new FakeServer()
    const terminalNamespace = io.of('/terminal')
    const cliNamespace = io.of('/cli')
    const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
    const maxTerminalsPerSocket = options?.maxTerminalsPerSocket ?? 4
    const terminalSocket = new FakeSocket('web-1')
    registerWebSocket(io, terminalNamespace, terminalRegistry, terminalSocket, maxTerminalsPerSocket)

    const cliSocket = new FakeSocket('cli-1')
    cliSocket.data.namespace = 'default'
    cliNamespace.sockets.set(cliSocket.id, cliSocket)
    cliNamespace.adapter.rooms.set('session:session-1', new Set([cliSocket.id]))
    cliNamespace.adapter.rooms.set('session:session-2', new Set([cliSocket.id]))

    return { io, terminalNamespace, terminalSocket, cliSocket, terminalRegistry, maxTerminalsPerSocket }
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

    it('enforces the durable owner resource cap even when creates are detached', () => {
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
        expect(terminalRegistry.countForOwner('default:7')).toBe(1)

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

    it('keeps the owner cap across viewer disconnect and a new Socket.IO connection', () => {
        const {
            io,
            terminalNamespace,
            terminalSocket,
            terminalRegistry,
            maxTerminalsPerSocket,
        } = setup({ maxTerminalsPerSocket: 1 })

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24,
            attach: false,
        })
        terminalSocket.trigger('disconnect')

        expect(terminalRegistry.get('terminal-1')).not.toBeNull()
        expect(terminalRegistry.countForOwner('default:7')).toBe(1)

        const replacement = new FakeSocket('web-2')
        registerWebSocket(
            io,
            terminalNamespace,
            terminalRegistry,
            replacement,
            maxTerminalsPerSocket,
            7
        )
        replacement.trigger('terminal:create', {
            sessionId: 'session-2',
            terminalId: 'terminal-2',
            cols: 80,
            rows: 24,
            attach: false,
        })

        expect(terminalRegistry.get('terminal-2')).toBeNull()
        expect(
            [...replacement.emitted].reverse().find((event) => event.event === 'terminal:error')?.data
        ).toEqual({
            terminalId: 'terminal-2',
            message: 'Too many terminals open (max 1).',
        })

        terminalRegistry.remove('terminal-1')
        expect(terminalRegistry.countForOwner('default:7')).toBe(0)
    })
})
