import { Server as Engine } from '@socket.io/bun-engine'
import { Server } from 'socket.io'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import type { Store } from '../store'
import { configuration } from '../configuration'
import { registerCliHandlers } from './handlers/cli'
import { registerTerminalHandlers } from './handlers/terminal'
import { RpcRegistry } from './rpcRegistry'
import type { SyncEvent } from '../sync/syncEngine'
import { TerminalRegistry } from './terminalRegistry'

const jwtPayloadSchema = z.object({
    uid: z.number()
})

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TERMINALS = 4

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type SocketServerDeps = {
    store: Store
    jwtSecret: Uint8Array
    getSession?: (sessionId: string) => { active: boolean } | null
    onWebappEvent?: (event: SyncEvent) => void
    onSessionAlive?: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }) => void
    onSessionEnd?: (payload: { sid: string; time: number }) => void
    onMachineAlive?: (payload: { machineId: string; time: number }) => void
}

export function createSocketServer(deps: SocketServerDeps): {
    io: Server
    engine: Engine
    rpcRegistry: RpcRegistry
} {
    const corsOrigins = configuration.corsOrigins
    const allowAllOrigins = corsOrigins.includes('*')

    const io = new Server({
        cors: {
            origin: (origin, callback) => {
                if (!origin) {
                    callback(null, true)
                    return
                }

                if (allowAllOrigins || corsOrigins.includes(origin)) {
                    callback(null, true)
                    return
                }

                callback(new Error('Origin not allowed'), false)
            },
            methods: ['GET', 'POST'],
            credentials: false
        }
    })

    const engine = new Engine({ path: '/socket.io/' })
    io.bind(engine)

    const rpcRegistry = new RpcRegistry()
    const idleTimeoutMs = resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
    const maxTerminals = resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
    const maxTerminalsPerSocket = maxTerminals
    const maxTerminalsPerSession = maxTerminals
    const cliNs = io.of('/cli')
    const terminalNs = io.of('/terminal')
    const terminalRegistry = new TerminalRegistry({
        idleTimeoutMs,
        onIdle: (entry) => {
            const terminalSocket = terminalNs.sockets.get(entry.socketId)
            terminalSocket?.emit('terminal:error', {
                terminalId: entry.terminalId,
                message: 'Terminal closed due to inactivity.'
            })
            const cliSocket = cliNs.sockets.get(entry.cliSocketId)
            cliSocket?.emit('terminal:close', {
                sessionId: entry.sessionId,
                terminalId: entry.terminalId
            })
        }
    })

    cliNs.use((socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (token !== configuration.cliApiToken) {
            return next(new Error('Invalid token'))
        }
        next()
    })
    cliNs.on('connection', (socket) => registerCliHandlers(socket, {
        io,
        store: deps.store,
        rpcRegistry,
        terminalRegistry,
        onSessionAlive: deps.onSessionAlive,
        onSessionEnd: deps.onSessionEnd,
        onMachineAlive: deps.onMachineAlive,
        onWebappEvent: deps.onWebappEvent
    }))

    terminalNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (!token) {
            return next(new Error('Missing token'))
        }

        try {
            const verified = await jwtVerify(token, deps.jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return next(new Error('Invalid token payload'))
            }
            socket.data.userId = parsed.data.uid
            next()
            return
        } catch {
            return next(new Error('Invalid token'))
        }
    })
    terminalNs.on('connection', (socket) => registerTerminalHandlers(socket, {
        io,
        getSession: (sessionId) => deps.getSession?.(sessionId) ?? deps.store.getSession(sessionId),
        terminalRegistry,
        maxTerminalsPerSocket,
        maxTerminalsPerSession
    }))

    return { io, engine, rpcRegistry }
}
