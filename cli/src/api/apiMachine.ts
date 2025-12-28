/**
 * WebSocket client for machine/daemon communication with hapi-server
 */

import { io, type Socket } from 'socket.io-client'
import { stat } from 'node:fs/promises'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import type { DaemonState, Machine, MachineMetadata, Update, UpdateMachineBody } from './types'
import { DaemonStateSchema, MachineMetadataSchema } from './types'
import { backoff } from '@/utils/time'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers, type SpawnSessionOptions, type SpawnSessionResult } from '../modules/common/registerCommonHandlers'

interface ServerToDaemonEvents {
    update: (data: Update) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    error: (data: { message: string }) => void
}

interface DaemonToServerEvents {
    'machine-alive': (data: { machineId: string; time: number }) => void
    'machine-update-metadata': (data: { machineId: string; metadata: unknown; expectedVersion: number }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        metadata: unknown | null
    } | {
        result: 'success'
        version: number
        metadata: unknown | null
    }) => void) => void
    'machine-update-state': (data: { machineId: string; daemonState: unknown | null; expectedVersion: number }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        daemonState: unknown | null
    } | {
        result: 'success'
        version: number
        daemonState: unknown | null
    }) => void) => void
    'rpc-register': (data: { method: string }) => void
    'rpc-unregister': (data: { method: string }) => void
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
    stopSession: (sessionId: string) => boolean
    requestShutdown: () => void
}

interface PathExistsRequest {
    paths: string[]
}

interface PathExistsResponse {
    exists: Record<string, boolean>
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>
    private keepAliveInterval: NodeJS.Timeout | null = null
    private rpcHandlerManager: RpcHandlerManager

    constructor(
        private readonly token: string,
        private readonly machine: Machine
    ) {
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            logger: (msg, data) => logger.debug(msg, data)
        })

        registerCommonHandlers(this.rpcHandlerManager, process.cwd())

        this.rpcHandlerManager.registerHandler<PathExistsRequest, PathExistsResponse>('path-exists', async (params) => {
            const rawPaths = Array.isArray(params?.paths) ? params.paths : []
            const uniquePaths = Array.from(new Set(rawPaths.filter((path): path is string => typeof path === 'string')))
            const exists: Record<string, boolean> = {}

            await Promise.all(uniquePaths.map(async (path) => {
                const trimmed = path.trim()
                if (!trimmed) return
                try {
                    const stats = await stat(trimmed)
                    exists[trimmed] = stats.isDirectory()
                } catch {
                    exists[trimmed] = false
                }
            }))

            return { exists }
        })
    }

    setRPCHandlers({ spawnSession, stopSession, requestShutdown }: MachineRpcHandlers): void {
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, yolo, token, sessionType, worktreeName } = params || {}

            if (!directory) {
                throw new Error('Directory is required')
            }

            const result = await spawnSession({
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                yolo,
                token,
                sessionType,
                worktreeName
            })

            switch (result.type) {
                case 'success':
                    return { type: 'success', sessionId: result.sessionId }
                case 'requestToApproveDirectoryCreation':
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory }
                case 'error':
                    throw new Error(result.errorMessage)
            }
        })

        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {}
            if (!sessionId) {
                throw new Error('Session ID is required')
            }

            const success = stopSession(sessionId)
            if (!success) {
                throw new Error('Session not found or failed to stop')
            }

            return { message: 'Session stopped' }
        })

        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            setTimeout(() => requestShutdown(), 100)
            return { message: 'Daemon stop request acknowledged' }
        })
    }

    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata)

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: updated,
                expectedVersion: this.machine.metadataVersion
            }) as unknown

            if (!answer || typeof answer !== 'object') {
                throw new Error('Invalid machine-update-metadata response')
            }

            const obj = answer as { result?: unknown; version?: unknown; metadata?: unknown }
            if (obj.result === 'success' && typeof obj.version === 'number') {
                const next = obj.metadata
                if (next == null) {
                    this.machine.metadata = null
                } else {
                    const parsed = MachineMetadataSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.metadata = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid metadata value from ack', { version: obj.version })
                    }
                }
                this.machine.metadataVersion = obj.version
                return
            }

            if (obj.result === 'version-mismatch' && typeof obj.version === 'number') {
                const next = obj.metadata
                if (next == null) {
                    this.machine.metadata = null
                } else {
                    const parsed = MachineMetadataSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.metadata = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid metadata value from version-mismatch ack', { version: obj.version })
                    }
                }
                this.machine.metadataVersion = obj.version
                throw new Error('Metadata version mismatch')
            }
        })
    }

    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState)

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: updated,
                expectedVersion: this.machine.daemonStateVersion
            }) as unknown

            if (!answer || typeof answer !== 'object') {
                throw new Error('Invalid machine-update-state response')
            }

            const obj = answer as { result?: unknown; version?: unknown; daemonState?: unknown }
            if (obj.result === 'success' && typeof obj.version === 'number') {
                const next = obj.daemonState
                if (next == null) {
                    this.machine.daemonState = null
                } else {
                    const parsed = DaemonStateSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.daemonState = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid daemonState value from ack', { version: obj.version })
                    }
                }
                this.machine.daemonStateVersion = obj.version
                return
            }

            if (obj.result === 'version-mismatch' && typeof obj.version === 'number') {
                const next = obj.daemonState
                if (next == null) {
                    this.machine.daemonState = null
                } else {
                    const parsed = DaemonStateSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.daemonState = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid daemonState value from version-mismatch ack', { version: obj.version })
                    }
                }
                this.machine.daemonStateVersion = obj.version
                throw new Error('Daemon state version mismatch')
            }
        })
    }

    connect(): void {
        this.socket = io(`${configuration.serverUrl}/cli`, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        })

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to bot')
            this.rpcHandlerManager.onSocketConnect(this.socket)
            this.updateDaemonState((state) => ({
                ...(state ?? {}),
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            })).catch((error) => {
                logger.debug('[API MACHINE] Failed to update daemon state on connect', error)
            })
            this.startKeepAlive()
        })

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from bot')
            this.rpcHandlerManager.onSocketDisconnect()
            this.stopKeepAlive()
        })

        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('update', (data: Update) => {
            if (data.body.t !== 'update-machine') {
                return
            }

            const update = data.body as UpdateMachineBody
            if (update.machineId !== this.machine.id) {
                return
            }

            if (update.metadata) {
                const parsed = MachineMetadataSchema.safeParse(update.metadata.value)
                if (parsed.success) {
                    this.machine.metadata = parsed.data
                } else {
                    logger.debug('[API MACHINE] Ignoring invalid metadata update', { version: update.metadata.version })
                }
                this.machine.metadataVersion = update.metadata.version
            }

            if (update.daemonState) {
                const next = update.daemonState.value
                if (next == null) {
                    this.machine.daemonState = null
                } else {
                    const parsed = DaemonStateSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.daemonState = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid daemonState update', { version: update.daemonState.version })
                    }
                }
                this.machine.daemonStateVersion = update.daemonState.version
            }
        })

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`)
        })
    }

    private startKeepAlive(): void {
        this.stopKeepAlive()
        this.keepAliveInterval = setInterval(() => {
            this.socket.emit('machine-alive', {
                machineId: this.machine.id,
                time: Date.now()
            })
        }, 20_000)
    }

    private stopKeepAlive(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval)
            this.keepAliveInterval = null
        }
    }

    shutdown(): void {
        this.stopKeepAlive()
        if (this.socket) {
            this.socket.close()
        }
    }
}
