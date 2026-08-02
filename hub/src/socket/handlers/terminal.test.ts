import { beforeEach, describe, expect, it } from 'bun:test'
import { registerTerminalHandlers } from './terminal'
import { TerminalRegistry } from '../terminalRegistry'
import { appendAgentTerminalOutput, clearAgentTerminalBuffer, getAgentTerminalReplay } from '../agentTerminalBuffer'
import type { SocketServer, SocketWithData } from '../socketTypes'

type EmittedEvent = {
    event: string
    data: unknown
}

class FakeSocket {
    readonly id: string
    readonly data: Record<string, unknown> = {}
    readonly emitted: EmittedEvent[] = []
    readonly rooms = new Set<string>()
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

    join(room: string): void {
        this.rooms.add(room)
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
    readonly adapter = { rooms: new Map<string, Set<string>>() }
}

class FakeServer {
    private readonly namespaces = new Map<string, FakeNamespace>()

    of(name: string): FakeNamespace {
        const existing = this.namespaces.get(name)
        if (existing) {
            return existing
        }
        const namespace = new FakeNamespace()
        this.namespaces.set(name, namespace)
        return namespace
    }
}

type Harness = {
    io: FakeServer
    terminalSocket: FakeSocket
    cliNamespace: FakeNamespace
    terminalRegistry: TerminalRegistry
}

function createHarness(options?: {
    sessionActive?: boolean
    sessionNamespace?: string
    maxTerminalsPerSocket?: number
    maxTerminalsPerSession?: number
}): Harness {
    const io = new FakeServer()
    const terminalSocket = new FakeSocket('terminal-socket')
    terminalSocket.data.namespace = 'default'
    const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 0 })
    const cliNamespace = io.of('/cli')

    registerTerminalHandlers(terminalSocket as unknown as SocketWithData, {
        io: io as unknown as SocketServer,
        getSession: () => ({
            active: options?.sessionActive ?? true,
            namespace: options?.sessionNamespace ?? 'default'
        }),
        terminalRegistry,
        maxTerminalsPerSocket: options?.maxTerminalsPerSocket ?? 4,
        maxTerminalsPerSession: options?.maxTerminalsPerSession ?? 4
    })

    return { io, terminalSocket, cliNamespace, terminalRegistry }
}

function connectCliSocket(cliNamespace: FakeNamespace, cliSocket: FakeSocket, sessionId: string): void {
    cliSocket.data.namespace = 'default'
    cliNamespace.sockets.set(cliSocket.id, cliSocket)
    const roomId = `session:${sessionId}`
    const room = cliNamespace.adapter.rooms.get(roomId) ?? new Set<string>()
    room.add(cliSocket.id)
    cliNamespace.adapter.rooms.set(roomId, room)
}

function lastEmit(socket: FakeSocket, event: string): EmittedEvent | undefined {
    return [...socket.emitted].reverse().find((entry) => entry.event === event)
}

describe('terminal socket handlers', () => {
    it('rejects terminal creation when session is inactive', () => {
        const { terminalSocket, terminalRegistry } = createHarness({ sessionActive: false })

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24
        })

        const errorEvent = lastEmit(terminalSocket, 'terminal:error')
        expect(errorEvent).toBeDefined()
        expect(errorEvent?.data).toEqual({
            terminalId: 'terminal-1',
            message: 'Session is inactive or unavailable.'
        })
        expect(terminalRegistry.get('terminal-1')).toBeNull()
    })

    it('opens a terminal and forwards write/resize/close to the CLI socket', () => {
        const { terminalSocket, cliNamespace, terminalRegistry } = createHarness()
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 120,
            rows: 40
        })

        const openEvent = lastEmit(cliSocket, 'terminal:open')
        expect(openEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 120,
            rows: 40
        })
        expect(terminalRegistry.get('terminal-1')).not.toBeNull()

        terminalSocket.trigger('terminal:write', {
            terminalId: 'terminal-1',
            data: 'ls\n'
        })
        const writeEvent = lastEmit(cliSocket, 'terminal:write')
        expect(writeEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            data: 'ls\n'
        })

        terminalSocket.trigger('terminal:resize', {
            terminalId: 'terminal-1',
            cols: 100,
            rows: 30
        })
        const resizeEvent = lastEmit(cliSocket, 'terminal:resize')
        expect(resizeEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 100,
            rows: 30
        })

        terminalSocket.trigger('terminal:close', {
            terminalId: 'terminal-1'
        })
        const closeEvent = lastEmit(cliSocket, 'terminal:close')
        expect(closeEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })
        expect(terminalRegistry.get('terminal-1')).toBeNull()
    })

    it('cleans up and notifies CLI on terminal socket disconnect', () => {
        const { terminalSocket, cliNamespace, terminalRegistry } = createHarness()
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 90,
            rows: 24
        })

        terminalSocket.trigger('disconnect')

        const closeEvent = lastEmit(cliSocket, 'terminal:close')
        expect(closeEvent?.data).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1'
        })
        expect(terminalRegistry.get('terminal-1')).toBeNull()
    })

    it('joins terminal socket to session room on create', () => {
        const { terminalSocket, cliNamespace } = createHarness()
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24
        })

        expect(terminalSocket.rooms.has('session:session-1')).toBe(true)
    })

    describe('agent-terminal:subscribe', () => {
        beforeEach(() => {
            clearAgentTerminalBuffer('session-1')
            clearAgentTerminalBuffer('session-2')
        })

        it('replays buffered agent output on subscribe', () => {
            const { terminalSocket } = createHarness()
            appendAgentTerminalOutput('session-1', '\x1b[32mInitial output\x1b[0m\r\n')
            appendAgentTerminalOutput('session-1', 'More output\r\n')

            terminalSocket.trigger('agent-terminal:subscribe', { sessionId: 'session-1' })

            expect(terminalSocket.rooms.has('agent-session:session-1')).toBe(true)
            const replayEvent = lastEmit(terminalSocket, 'agent-terminal:output')
            expect(replayEvent).toBeDefined()
            expect(replayEvent?.data).toEqual({
                sessionId: 'session-1',
                terminalId: 'agent',
                data: '\x1b[32mInitial output\x1b[0m\r\nMore output\r\n'
            })
        })

        it('rejects subscribe to a session in another namespace (no join, no replay)', () => {
            // A valid token for the 'default' namespace must not be able to
            // subscribe to a session that belongs to a different namespace.
            const { terminalSocket } = createHarness({ sessionNamespace: 'other' })
            appendAgentTerminalOutput('session-1', 'secret-output-from-other-namespace')

            terminalSocket.trigger('agent-terminal:subscribe', { sessionId: 'session-1' })

            expect(terminalSocket.rooms.has('agent-session:session-1')).toBe(false)
            expect(lastEmit(terminalSocket, 'agent-terminal:output')).toBeUndefined()
        })

        it('rejects subscribe when the session is inactive (no join, no replay)', () => {
            const { terminalSocket } = createHarness({ sessionActive: false })
            appendAgentTerminalOutput('session-1', 'stale-output')

            terminalSocket.trigger('agent-terminal:subscribe', { sessionId: 'session-1' })

            expect(terminalSocket.rooms.has('agent-session:session-1')).toBe(false)
            expect(lastEmit(terminalSocket, 'agent-terminal:output')).toBeUndefined()
        })

        it('joins a dedicated agent-terminal room (not the user-terminal session room)', () => {
            const { terminalSocket } = createHarness()

            terminalSocket.trigger('agent-terminal:subscribe', { sessionId: 'session-1' })

            // Agent-terminal viewers must NOT land in the user-terminal `session:` room,
            // otherwise the streaming-teardown viewer count counts the wrong sockets.
            expect(terminalSocket.rooms.has('agent-session:session-1')).toBe(true)
            expect(terminalSocket.rooms.has('session:session-1')).toBe(false)
            const replayEvent = lastEmit(terminalSocket, 'agent-terminal:output')
            expect(replayEvent).toBeUndefined()
        })

        it('strips a trailing alt-screen-exit so an exited TUI replays its last frame (not black)', () => {
            clearAgentTerminalBuffer('session-3')
            // alt-screen enter + a frame, then the process exits (alt-screen exit).
            appendAgentTerminalOutput('session-3', '\x1b[?1049h\x1b[HLAST FRAME')
            appendAgentTerminalOutput('session-3', '\r\n\x1b[?1049l\x1b[?25h')
            const replay = getAgentTerminalReplay('session-3')
            expect(replay).toContain('LAST FRAME')
            expect(replay).not.toContain('\x1b[?1049l')
            clearAgentTerminalBuffer('session-3')
        })

        it('keeps alt-screen content intact for a live (still in alt-screen) TUI', () => {
            clearAgentTerminalBuffer('session-4')
            appendAgentTerminalOutput('session-4', '\x1b[?1049h\x1b[HLIVE FRAME')
            const replay = getAgentTerminalReplay('session-4')
            expect(replay).toBe('\x1b[?1049h\x1b[HLIVE FRAME')
            clearAgentTerminalBuffer('session-4')
        })

        it('replays buffer per-session independently', () => {
            const { terminalSocket } = createHarness()
            appendAgentTerminalOutput('session-1', 'data-for-session-1')
            appendAgentTerminalOutput('session-2', 'data-for-session-2')

            terminalSocket.trigger('agent-terminal:subscribe', { sessionId: 'session-2' })

            const replayEvent = lastEmit(terminalSocket, 'agent-terminal:output')
            expect(replayEvent?.data).toEqual({
                sessionId: 'session-2',
                terminalId: 'agent',
                data: 'data-for-session-2'
            })
        })

        it('replays same buffer on repeated subscribe (no clear)', () => {
            const { terminalSocket } = createHarness()
            appendAgentTerminalOutput('session-1', 'persistent-data')

            terminalSocket.trigger('agent-terminal:subscribe', { sessionId: 'session-1' })
            const firstReplay = lastEmit(terminalSocket, 'agent-terminal:output')
            expect(firstReplay).toBeDefined()
            expect((firstReplay!.data as { data: string }).data).toBe('persistent-data')

            // Second subscribe gets the same buffer again (not cleared)
            terminalSocket.emitted.length = 0
            terminalSocket.trigger('agent-terminal:subscribe', { sessionId: 'session-1' })
            const secondReplay = lastEmit(terminalSocket, 'agent-terminal:output')
            expect(secondReplay).toBeDefined()
            expect((secondReplay!.data as { data: string }).data).toBe('persistent-data')
        })
    })

    describe('agent-terminal:resize', () => {
        it('forwards a resize to the CLI socket for an authorized active session', () => {
            const { terminalSocket, cliNamespace } = createHarness()
            const cliSocket = new FakeSocket('cli-socket-1')
            connectCliSocket(cliNamespace, cliSocket, 'session-1')

            terminalSocket.trigger('agent-terminal:resize', { sessionId: 'session-1', cols: 100, rows: 30 })

            const resizeEvent = lastEmit(cliSocket, 'agent-terminal:resize')
            expect(resizeEvent?.data).toEqual({ sessionId: 'session-1', cols: 100, rows: 30 })
        })

        it('does not forward a resize when the session is inactive (guard, not just pickCliSocket)', () => {
            // CLI socket IS connected in this socket's own namespace, so without
            // the authorization guard pickCliSocketId would find it and emit.
            const { terminalSocket, cliNamespace } = createHarness({ sessionActive: false })
            const cliSocket = new FakeSocket('cli-socket-1')
            connectCliSocket(cliNamespace, cliSocket, 'session-1')

            terminalSocket.trigger('agent-terminal:resize', { sessionId: 'session-1', cols: 100, rows: 30 })

            expect(lastEmit(cliSocket, 'agent-terminal:resize')).toBeUndefined()
        })
    })

    describe('agent-terminal:input', () => {
        it('forwards raw keystrokes to the CLI socket for an authorized active session', () => {
            const { terminalSocket, cliNamespace } = createHarness()
            const cliSocket = new FakeSocket('cli-socket-1')
            connectCliSocket(cliNamespace, cliSocket, 'session-1')

            terminalSocket.trigger('agent-terminal:input', { sessionId: 'session-1', data: '\u001b' })

            const inputEvent = lastEmit(cliSocket, 'agent-terminal:input')
            expect(inputEvent?.data).toEqual({ sessionId: 'session-1', data: '\u001b' })
        })

        it('does not forward input when the session is inactive (same guard as resize)', () => {
            const { terminalSocket, cliNamespace } = createHarness({ sessionActive: false })
            const cliSocket = new FakeSocket('cli-socket-1')
            connectCliSocket(cliNamespace, cliSocket, 'session-1')

            terminalSocket.trigger('agent-terminal:input', { sessionId: 'session-1', data: 'a' })

            expect(lastEmit(cliSocket, 'agent-terminal:input')).toBeUndefined()
        })

        it('drops malformed input (empty data) without emitting', () => {
            const { terminalSocket, cliNamespace } = createHarness()
            const cliSocket = new FakeSocket('cli-socket-1')
            connectCliSocket(cliNamespace, cliSocket, 'session-1')

            terminalSocket.trigger('agent-terminal:input', { sessionId: 'session-1', data: '' })

            expect(lastEmit(cliSocket, 'agent-terminal:input')).toBeUndefined()
        })

        it('does not forward input to a session in another namespace (no cross-namespace keystroke injection)', () => {
            // The socket's namespace is 'default'; the session belongs to 'other'.
            // A CLI socket IS connected, so without the namespace guard the relay
            // would inject keystrokes into another namespace's live agent PTY.
            const { terminalSocket, cliNamespace } = createHarness({ sessionNamespace: 'other' })
            const cliSocket = new FakeSocket('cli-socket-1')
            connectCliSocket(cliNamespace, cliSocket, 'session-1')

            terminalSocket.trigger('agent-terminal:input', { sessionId: 'session-1', data: 'a' })

            expect(lastEmit(cliSocket, 'agent-terminal:input')).toBeUndefined()
        })
    })

    it('enforces per-socket terminal limits', () => {
        const { terminalSocket, cliNamespace } = createHarness({ maxTerminalsPerSocket: 1 })
        const cliSocket = new FakeSocket('cli-socket-1')
        connectCliSocket(cliNamespace, cliSocket, 'session-1')

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            cols: 80,
            rows: 24
        })

        terminalSocket.trigger('terminal:create', {
            sessionId: 'session-1',
            terminalId: 'terminal-2',
            cols: 80,
            rows: 24
        })

        const errorEvent = lastEmit(terminalSocket, 'terminal:error')
        expect(errorEvent?.data).toEqual({
            terminalId: 'terminal-2',
            message: 'Too many terminals open (max 1).'
        })
    })
})
