import { Server as Engine } from '@socket.io/bun-engine'
import { Server } from 'socket.io'
import type { Store } from '../store'
import { configuration } from '../configuration'
import { registerCliHandlers } from './handlers/cli'
import { RpcRegistry } from './rpcRegistry'
import type { SyncEvent } from '../sync/syncEngine'

export type SocketServerDeps = {
    store: Store
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

    return { io, engine, rpcRegistry }
}
