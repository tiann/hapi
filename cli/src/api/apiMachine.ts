/**
 * WebSocket client for machine/runner communication with hapi-hub
 */

import { io, type Socket } from 'socket.io-client'
import { stat } from 'node:fs/promises'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import type { ManagedSessionOutcomeAck, ManagedSessionOutcomeRequest, ManagedStopBarrierAck, ManagedStopBarrierRequest, Update, UpdateMachineBody } from '@hapi/protocol'
import type { RunnerState, Machine, MachineMetadata } from './types'
import { RunnerStateSchema, MachineMetadataSchema } from './types'
import { backoff, withRetry } from '@/utils/time'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import type { QuerySpawnSessionResult, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/rpcTypes'
import { applyVersionedAck } from './versionedUpdate'
import { buildSocketIoExtraHeaderOptions } from './hubExtraHeaders'

interface ServerToRunnerEvents {
    update: (data: Update) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    error: (data: { message: string }) => void
}

interface RunnerToServerEvents {
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
    'machine-update-state': (data: { machineId: string; runnerState: unknown | null; expectedVersion: number }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        runnerState: unknown | null
    } | {
        result: 'success'
        version: number
        runnerState: unknown | null
    }) => void) => void
    'rpc-register': (data: { method: string }) => void
    'rpc-unregister': (data: { method: string }) => void
    'runner-managed-session-outcome': (data: ManagedSessionOutcomeRequest, cb: (answer: ManagedSessionOutcomeAck) => void) => void
    'runner-managed-stop-barrier': (data: ManagedStopBarrierRequest, cb: (answer: ManagedStopBarrierAck) => void) => void
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
    querySpawnSession: (
        spawnRequestId: string,
        expectedOptions?: SpawnSessionOptions
    ) => Promise<QuerySpawnSessionResult>
    stopSession: (sessionId: string) => Promise<boolean> | boolean
    requestShutdown: () => void
}

interface PathExistsRequest {
    paths: string[]
}

interface PathExistsResponse {
    exists: Record<string, boolean>
}

export const MACHINE_UPDATE_ACK_TIMEOUT_MS = 5_000
export const MACHINE_UPDATE_MAX_ATTEMPTS = 3

export class ApiMachineClient {
    private socket!: Socket<ServerToRunnerEvents, RunnerToServerEvents>
    private keepAliveInterval: NodeJS.Timeout | null = null
    private rpcHandlerManager: RpcHandlerManager
    private readonly connectedListeners = new Set<() => void | Promise<void>>()

    constructor(
        private readonly token: string,
        private readonly machine: Machine
    ) {
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            logger: (msg, data) => logger.debug(msg, data)
        })

        registerCommonHandlers(this.rpcHandlerManager, getInvokedCwd())

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

    setRPCHandlers({ spawnSession, querySpawnSession, stopSession, requestShutdown }: MachineRpcHandlers): void {
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { spawnRequestId, directory, sessionId, resumeSessionId, machineId, approvedNewDirectoryCreation, agent, model, effort, modelReasoningEffort, serviceTier, yolo, permissionMode, token, sessionType, worktreeName } = params || {}

            if (!directory) {
                throw new Error('Directory is required')
            }

            const result = await spawnSession({
                spawnRequestId,
                directory,
                sessionId,
                resumeSessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                modelReasoningEffort,
                serviceTier,
                yolo,
                permissionMode,
                token,
                sessionType,
                worktreeName
            })

            switch (result.type) {
                case 'success':
                    return { type: 'success', sessionId: result.sessionId }
                case 'pending':
                    return { type: 'pending', spawnRequestId: result.spawnRequestId }
                case 'requestToApproveDirectoryCreation':
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory }
                case 'error':
                    return {
                        type: 'error',
                        errorMessage: result.errorMessage,
                        ...(result.code ? { code: result.code } : {}),
                        ...(result.recoveryCommand ? { recoveryCommand: result.recoveryCommand } : {})
                    }
            }
        })

        this.rpcHandlerManager.registerHandler('query-happy-session-spawn', async (params: any) => {
            const { spawnRequestId, directory, sessionId, resumeSessionId, machineId, approvedNewDirectoryCreation, agent, model, effort, modelReasoningEffort, serviceTier, yolo, permissionMode, token, sessionType, worktreeName } = params || {}
            if (!spawnRequestId || typeof spawnRequestId !== 'string') {
                throw new Error('Spawn request ID is required')
            }
            const expectedOptions: SpawnSessionOptions | undefined = typeof directory === 'string' && directory.length > 0
                ? {
                    spawnRequestId,
                    directory,
                    sessionId,
                    resumeSessionId,
                    machineId,
                    approvedNewDirectoryCreation,
                    agent,
                    model,
                    effort,
                    modelReasoningEffort,
                    serviceTier,
                    yolo,
                    permissionMode,
                    token,
                    sessionType,
                    worktreeName,
                }
                : undefined
            return await querySpawnSession(spawnRequestId, expectedOptions)
        })

        this.rpcHandlerManager.registerHandler('stop-session', async (params: any) => {
            const { sessionId } = params || {}
            if (!sessionId) {
                throw new Error('Session ID is required')
            }

            const success = await stopSession(sessionId)
            if (!success) {
                throw new Error('Session not found or failed to stop')
            }

            return { message: 'Session stopped' }
        })

        this.rpcHandlerManager.registerHandler('stop-runner', () => {
            setTimeout(() => requestShutdown(), 100)
            return { message: 'Runner stop request acknowledged' }
        })
    }

    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await withRetry(
            async () => await this.updateMachineMetadataOnce(handler),
            { maxAttempts: MACHINE_UPDATE_MAX_ATTEMPTS, minDelay: 100, maxDelay: 500 }
        )
    }

    async updateMachineMetadataOnce(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        const updated = handler(this.machine.metadata)

        const answer = await this.socket.timeout(MACHINE_UPDATE_ACK_TIMEOUT_MS).emitWithAck('machine-update-metadata', {
            machineId: this.machine.id,
            metadata: updated,
            expectedVersion: this.machine.metadataVersion
        }) as unknown

        applyVersionedAck(answer, {
            valueKey: 'metadata',
            parseValue: (value) => {
                const parsed = MachineMetadataSchema.safeParse(value)
                return parsed.success ? parsed.data : null
            },
            applyValue: (value) => {
                this.machine.metadata = value
            },
            applyVersion: (version) => {
                this.machine.metadataVersion = version
            },
            logInvalidValue: (context, version) => {
                const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                logger.debug(`[API MACHINE] Ignoring invalid metadata value from ${suffix}`, { version })
            },
            invalidResponseMessage: 'Invalid machine-update-metadata response',
            errorMessage: 'Machine metadata update failed',
            versionMismatchMessage: 'Metadata version mismatch'
        })
    }

    onConnected(listener: () => void | Promise<void>): () => void {
        this.connectedListeners.add(listener)
        return () => this.connectedListeners.delete(listener)
    }

    async updateRunnerState(handler: (state: RunnerState | null) => RunnerState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.runnerState)

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                runnerState: updated,
                expectedVersion: this.machine.runnerStateVersion
            }) as unknown

            applyVersionedAck(answer, {
                valueKey: 'runnerState',
                parseValue: (value) => {
                    const parsed = RunnerStateSchema.safeParse(value)
                    return parsed.success ? parsed.data : null
                },
                applyValue: (value) => {
                    this.machine.runnerState = value
                },
                applyVersion: (version) => {
                    this.machine.runnerStateVersion = version
                },
                logInvalidValue: (context, version) => {
                    const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                    logger.debug(`[API MACHINE] Ignoring invalid runnerState value from ${suffix}`, { version })
                },
                invalidResponseMessage: 'Invalid machine-update-state response',
                errorMessage: 'Machine state update failed',
                versionMismatchMessage: 'Runner state version mismatch'
            })
        })
    }

    connect(): void {
        this.socket = io(`${configuration.apiUrl}/cli`, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            ...buildSocketIoExtraHeaderOptions()
        })

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to bot')
            this.rpcHandlerManager.onSocketConnect(this.socket)
            this.updateRunnerState((state) => ({
                ...(state ?? {}),
                status: 'reconciling',
                pid: process.pid,
                httpPort: this.machine.runnerState?.httpPort,
                startedAt: Date.now()
            })).catch((error) => {
                logger.debug('[API MACHINE] Failed to update runner state on connect', error)
            })
            this.startKeepAlive()
            for (const listener of this.connectedListeners) {
                try {
                    void Promise.resolve(listener()).catch((error) => {
                        logger.debug('[API MACHINE] Connected listener failed', error)
                    })
                } catch (error) {
                    logger.debug('[API MACHINE] Connected listener failed', error)
                }
            }
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

            if (update.runnerState) {
                const next = update.runnerState.value
                if (next == null) {
                    this.machine.runnerState = null
                } else {
                    const parsed = RunnerStateSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.runnerState = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid runnerState update', { version: update.runnerState.version })
                    }
                }
                this.machine.runnerStateVersion = update.runnerState.version
            }
        })

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`)
        })

        this.socket.on('error', (payload) => {
            logger.debug('[API MACHINE] Socket error:', payload)
        })
    }

    async waitForConnected(timeoutMs: number): Promise<boolean> {
        if (this.socket?.connected) return true
        return await new Promise<boolean>((resolve) => {
            let settled = false
            const finish = (value: boolean) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                this.socket.off('connect', onConnect)
                resolve(value)
            }
            const onConnect = () => finish(true)
            const timeout = setTimeout(() => finish(false), timeoutMs)
            timeout.unref()
            this.socket.on('connect', onConnect)
        })
    }

    async markManagedSessionOutcome(request: ManagedSessionOutcomeRequest, timeoutMs = 10_000): Promise<ManagedSessionOutcomeAck> {
        return await new Promise<ManagedSessionOutcomeAck>((resolve) => {
            let settled = false
            const finish = (value: ManagedSessionOutcomeAck) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                resolve(value)
            }
            const timeout = setTimeout(() => finish({ result: 'error', reason: 'internal-error' }), timeoutMs)
            timeout.unref()
            this.socket.emit('runner-managed-session-outcome', request, finish)
        })
    }

    async checkManagedStopBarrier(request: ManagedStopBarrierRequest, timeoutMs = 10_000): Promise<ManagedStopBarrierAck> {
        return await new Promise<ManagedStopBarrierAck>((resolve) => {
            let settled = false
            const finish = (value: ManagedStopBarrierAck) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                resolve(value)
            }
            const timeout = setTimeout(() => finish({ eligible: false, reason: 'hub-timeout' }), timeoutMs)
            timeout.unref()
            this.socket.emit('runner-managed-stop-barrier', request, finish)
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
