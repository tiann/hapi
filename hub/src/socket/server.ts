import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type DefaultEventsMap } from 'socket.io'
import type { Store } from '../store'
import { getConfiguration } from '../configuration'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'
import { verifyWebAuthToken, type WebAuthTokenVerification } from '../web/authToken'
import type { CloudflareAccessVerifier } from '../web/cloudflareAccess'
import { registerCliHandlers } from './handlers/cli'
import { registerTerminalHandlers } from './handlers/terminal'
import { RpcRegistry } from './rpcRegistry'
import { SOCKET_MAX_HTTP_BUFFER_SIZE } from './socketLimits'
import type { SyncEvent } from '../sync/syncEngine'
import { TerminalRegistry } from './terminalRegistry'
import { clearUserTerminalBuffer } from './userTerminalBuffer'
import type { CliSocketWithData, SocketData, SocketServer } from './socketTypes'

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

export interface VerifyTerminalSocketAuthOptions {
    /**
     * Cloudflare Access verifier override (tests only). When omitted, the
     * verifier for the configured bundle is used; an explicitly null value
     * models a disabled Cloudflare configuration.
     */
    cloudflareAccessVerifier?: CloudflareAccessVerifier | null
}

/**
 * Authenticate a /terminal namespace handshake. Cloudflare-derived HAPI JWTs
 * must present a current Cf-Access-Jwt-Assertion forwarded in the handshake
 * headers; legacy JWTs keep their existing behaviour.
 */
export async function verifyTerminalSocketAuth(
    token: string | null,
    assertionHeader: string | string[] | undefined,
    jwtSecret: Uint8Array,
    options: VerifyTerminalSocketAuthOptions = {}
): Promise<WebAuthTokenVerification> {
    if (!token) {
        return { ok: false, status: 401, error: 'Missing token' }
    }
    const assertion = Array.isArray(assertionHeader) ? assertionHeader[0] : assertionHeader
    return await verifyWebAuthToken(token, jwtSecret, assertion, {
        cloudflareAccessVerifier: options.cloudflareAccessVerifier
    })
}

export type SocketServerDeps = {
    store: Store
    jwtSecret: Uint8Array
    corsOrigins?: string[]
    getSession?: (sessionId: string) => { active: boolean; namespace: string } | null
    onWebappEvent?: (event: SyncEvent) => void
    onSessionAlive?: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }) => void
    onSessionReady?: (payload: { sid: string; time: number }) => void
    onSessionEnd?: (payload: { sid: string; time: number }) => void
    onMachineAlive?: (payload: { machineId: string; time: number; health?: unknown }) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    onAgentProgress?: (sessionId: string, at: number) => void
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    onMessagesConsumed?: (sessionId: string) => void
}

export function createSocketServer(deps: SocketServerDeps): {
    io: SocketServer
    engine: Engine
    rpcRegistry: RpcRegistry
} {
    const configuration = getConfiguration()
    const corsOrigins = deps.corsOrigins ?? configuration.corsOrigins
    const allowAllOrigins = corsOrigins.includes('*')
    const corsOriginOption = allowAllOrigins ? '*' : corsOrigins
    const corsOptions = {
        origin: corsOriginOption,
        methods: ['GET', 'POST'],
        credentials: false
    }

    const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>({
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE
    })

    const engine = new Engine({
        path: '/socket.io/',
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
        allowRequest: async (req) => {
            const origin = req.headers.get('origin')
            if (!origin || allowAllOrigins || corsOrigins.includes(origin)) {
                return
            }
            throw 'Origin not allowed'
        }
    })
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
        // Release the per-terminal scrollback buffer whenever a terminal is
        // genuinely removed (close / idle / CLI gone) so it
        // doesn't accumulate in the hub for the process's life. Reconnect
        // re-registers skip this (remove(id, false)) to keep their buffer.
        onRemove: (entry) => clearUserTerminalBuffer(entry.sessionId, entry.terminalId),
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
        const parsedToken = token ? parseAccessToken(token) : null
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return next(new Error('Invalid token'))
        }
        socket.data.namespace = parsedToken.namespace
        next()
    })
    cliNs.on('connection', (socket) => registerCliHandlers(socket as CliSocketWithData, {
        io,
        store: deps.store,
        rpcRegistry,
        terminalRegistry,
        onSessionAlive: deps.onSessionAlive,
        onSessionReady: deps.onSessionReady,
        onSessionEnd: deps.onSessionEnd,
        onMachineAlive: deps.onMachineAlive,
        onWebappEvent: deps.onWebappEvent,
        onBackgroundTaskDelta: deps.onBackgroundTaskDelta,
        onSessionActivity: deps.onSessionActivity,
        onAgentProgress: deps.onAgentProgress,
        onSweepImmediateQueued: deps.onSweepImmediateQueued,
        onMessagesConsumed: deps.onMessagesConsumed
    }))

    terminalNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        const result = await verifyTerminalSocketAuth(
            token,
            socket.handshake.headers['cf-access-jwt-assertion'],
            deps.jwtSecret
        )
        if (!result.ok) {
            return next(new Error(result.error))
        }
        socket.data.userId = result.userId
        socket.data.namespace = result.namespace
        next()
    })
    terminalNs.on('connection', (socket) => registerTerminalHandlers(socket, {
        io,
        getSession: (sessionId) => {
            return deps.getSession?.(sessionId) ?? deps.store.sessions.getSession(sessionId)
        },
        terminalRegistry,
        maxTerminalsPerSocket,
        maxTerminalsPerSession
    }))

    return { io, engine, rpcRegistry }
}
