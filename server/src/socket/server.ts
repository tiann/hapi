import { Server as Engine } from '@socket.io/bun-engine'
import { Server } from 'socket.io'
import type { Store } from '../store'
import { configuration } from '../configuration'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import { registerCliHandlers } from './handlers/cli'
import { registerWebappHandlers } from './handlers/webapp'
import { RpcRegistry } from './rpcRegistry'
import type { SyncEvent } from '../sync/syncEngine'

const webappJwtPayloadSchema = z.object({
    uid: z.number()
})

export type SocketServerDeps = {
    store: Store
    jwtSecret: Uint8Array
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

    const cliNs = io.of('/cli')
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
        onSessionAlive: deps.onSessionAlive,
        onSessionEnd: deps.onSessionEnd,
        onMachineAlive: deps.onMachineAlive,
        onWebappEvent: deps.onWebappEvent
    }))

    const webappNs = io.of('/webapp')
    webappNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (!token) {
            return next(new Error('Missing token'))
        }

        try {
            const verified = await jwtVerify(token, deps.jwtSecret, { algorithms: ['HS256'] })
            const parsed = webappJwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return next(new Error('Invalid token payload'))
            }

            socket.data.telegramUserId = parsed.data.uid
            next()
        } catch {
            return next(new Error('Invalid token'))
        }
    })
    webappNs.on('connection', (socket) => registerWebappHandlers(socket, {}))

    return { io, engine, rpcRegistry }
}
