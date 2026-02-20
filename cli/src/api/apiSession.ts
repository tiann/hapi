import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import axios from 'axios'
import type { ZodType } from 'zod'
import { logger } from '@/ui/logger'
import { backoff } from '@/utils/time'
import { apiValidationError, extractErrorInfo } from '@/utils/errorUtils'
import { AsyncLock } from '@/utils/lock'
import type { RawJSONLines } from '@/claude/types'
import { configuration } from '@/configuration'
import type { ClientToServerEvents, ServerToClientEvents, Update } from '@hapi/protocol'
import {
    TerminalClosePayloadSchema,
    TerminalOpenPayloadSchema,
    TerminalResizePayloadSchema,
    TerminalWritePayloadSchema
} from '@hapi/protocol'
import type {
    AgentState,
    CliSpawnSessionResponse,
    Machine,
    MessageContent,
    MessageMeta,
    Metadata,
    Session,
    SessionModelMode,
    SessionPermissionMode,
    UserMessage
} from './types'
import {
    AgentStateSchema,
    CliMachinesResponseSchema,
    CliMessagesResponseSchema,
    CliSpawnSessionResponseSchema,
    MachineMetadataSchema,
    MetadataSchema,
    RunnerStateSchema,
    UserMessageSchema
} from './types'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import { cleanupUploadDir } from '../modules/common/handlers/uploads'
import { TerminalManager } from '@/terminal/TerminalManager'
import { applyVersionedAck } from './versionedUpdate'

export class ApiSessionClient extends EventEmitter {
    private readonly token: string
    readonly sessionId: string
    private metadata: Metadata | null
    private metadataVersion: number
    private agentState: AgentState | null
    private agentStateVersion: number
    private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>
    private pendingMessages: UserMessage[] = []
    private pendingUserEchoes: Array<{ text: string; createdAt: number }> = []
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null
    private lastSeenMessageSeq: number | null = null
    private backfillInFlight: Promise<void> | null = null
    private needsBackfill = false
    private hasConnectedOnce = false
    readonly rpcHandlerManager: RpcHandlerManager
    private readonly terminalManager: TerminalManager
    private agentStateLock = new AsyncLock()
    private metadataLock = new AsyncLock()
    private _lastThinking = false

    private isDisconnectedTransportError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false
        }
        const message = error.message.toLowerCase()
        return message.includes('disconnected transport')
            || message.includes('transport closed')
            || message.includes('transport is closed')
            || message.includes('socket is not connected')
            || message.includes('not connected')
    }

    private emitSocketSafely(
        event: string,
        payload: unknown,
        options?: { allowWhenDisconnected?: boolean; volatile?: boolean }
    ): void {
        if (!options?.allowWhenDisconnected && !this.socket.connected) {
            return
        }

        try {
            const emitter = options?.volatile ? this.socket.volatile : this.socket
            emitter.emit(event as any, payload as any)
        } catch (error) {
            if (this.isDisconnectedTransportError(error)) {
                logger.debug(`[API] Dropped '${event}' due to disconnected transport`)
                return
            }
            logger.debug(`[API] Failed to emit '${event}'`, error)
        }
    }

    constructor(token: string, session: Session) {
        super()
        this.token = token
        this.sessionId = session.id
        this.metadata = session.metadata
        this.metadataVersion = session.metadataVersion
        this.agentState = session.agentState
        this.agentStateVersion = session.agentStateVersion

        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            logger: (msg, data) => logger.debug(msg, data)
        })

        if (this.metadata?.path) {
            registerCommonHandlers(this.rpcHandlerManager, this.metadata.path)
        }

        this.socket = io(`${configuration.apiUrl}/cli`, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            autoConnect: false
        })

        this.terminalManager = new TerminalManager({
            sessionId: this.sessionId,
            getSessionPath: () => this.metadata?.path ?? null,
            onReady: (payload) => this.emitSocketSafely('terminal:ready', payload),
            onOutput: (payload) => this.emitSocketSafely('terminal:output', payload),
            onExit: (payload) => this.emitSocketSafely('terminal:exit', payload),
            onError: (payload) => this.emitSocketSafely('terminal:error', payload)
        })

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully')
            this.rpcHandlerManager.onSocketConnect(this.socket)
            if (this.hasConnectedOnce) {
                this.needsBackfill = true
            }
            void this.backfillIfNeeded()
            this.hasConnectedOnce = true
            this.emitSocketSafely('session-alive', {
                sid: this.sessionId,
                time: Date.now(),
                thinking: this._lastThinking
            }, { allowWhenDisconnected: true })
        })

        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason)
            this.rpcHandlerManager.onSocketDisconnect()
            this.terminalManager.closeAll()
            if (this.hasConnectedOnce) {
                this.needsBackfill = true
            }
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error)
            this.rpcHandlerManager.onSocketDisconnect()
        })

        this.socket.on('error', (payload) => {
            logger.debug('[API] Socket error:', payload)
        })

        const handleTerminalEvent = <T extends { sessionId: string }>(
            schema: ZodType<T>,
            handler: (payload: T) => void
        ) => (data: unknown) => {
            const parsed = schema.safeParse(data)
            if (!parsed.success) {
                return
            }
            if (parsed.data.sessionId !== this.sessionId) {
                return
            }
            handler(parsed.data)
        }

        this.socket.on('terminal:open', handleTerminalEvent(TerminalOpenPayloadSchema, (payload) => {
            this.terminalManager.create(payload.terminalId, payload.cols, payload.rows)
        }))

        this.socket.on('terminal:write', handleTerminalEvent(TerminalWritePayloadSchema, (payload) => {
            this.terminalManager.write(payload.terminalId, payload.data)
        }))

        this.socket.on('terminal:resize', handleTerminalEvent(TerminalResizePayloadSchema, (payload) => {
            this.terminalManager.resize(payload.terminalId, payload.cols, payload.rows)
        }))

        this.socket.on('terminal:close', handleTerminalEvent(TerminalClosePayloadSchema, (payload) => {
            this.terminalManager.close(payload.terminalId)
        }))

        this.socket.on('update', (data: Update) => {
            try {
                if (!data.body) return

                if (data.body.t === 'new-message') {
                    this.handleIncomingMessage(data.body.message)
                    return
                }

                if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        const parsed = MetadataSchema.safeParse(data.body.metadata.value)
                        if (parsed.success) {
                            this.metadata = parsed.data
                        } else {
                            logger.debug('[API] Ignoring invalid metadata update', { version: data.body.metadata.version })
                        }
                        this.metadataVersion = data.body.metadata.version
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        const next = data.body.agentState.value
                        if (next == null) {
                            this.agentState = null
                        } else {
                            const parsed = AgentStateSchema.safeParse(next)
                            if (parsed.success) {
                                this.agentState = parsed.data
                            } else {
                                logger.debug('[API] Ignoring invalid agentState update', { version: data.body.agentState.version })
                            }
                        }
                        this.agentStateVersion = data.body.agentState.version
                    }
                    return
                }

                this.emit('message', data.body)
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error })
            }
        })

        this.socket.connect()
    }

    onUserMessage(callback: (data: UserMessage) => void): void {
        this.pendingMessageCallback = callback
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!)
        }
    }

    private enqueueUserMessage(message: UserMessage): void {
        if (this.pendingMessageCallback) {
            this.pendingMessageCallback(message)
        } else {
            this.pendingMessages.push(message)
        }
    }

    private normalizeUserEchoText(text: string): string {
        return text.replace(/\s+/g, ' ').trim()
    }

    private trackPendingUserEcho(text: string): void {
        const normalized = this.normalizeUserEchoText(text)
        if (!normalized) {
            return
        }

        const now = Date.now()
        const windowMs = 120_000
        this.pendingUserEchoes = this.pendingUserEchoes.filter((entry) => now - entry.createdAt <= windowMs)
        this.pendingUserEchoes.push({ text: normalized, createdAt: now })
    }

    private consumePendingUserEcho(text: string): boolean {
        const normalized = this.normalizeUserEchoText(text)
        if (!normalized) {
            return false
        }

        const now = Date.now()
        const windowMs = 120_000
        this.pendingUserEchoes = this.pendingUserEchoes.filter((entry) => now - entry.createdAt <= windowMs)
        const index = this.pendingUserEchoes.findIndex((entry) => entry.text === normalized)
        if (index === -1) {
            return false
        }

        this.pendingUserEchoes.splice(index, 1)
        return true
    }

    private handleIncomingMessage(message: { seq?: number; content: unknown }): void {
        const seq = typeof message.seq === 'number' ? message.seq : null
        if (seq !== null) {
            if (this.lastSeenMessageSeq !== null && seq <= this.lastSeenMessageSeq) {
                return
            }
            this.lastSeenMessageSeq = seq
        }

        const userResult = UserMessageSchema.safeParse(message.content)
        if (userResult.success) {
            if (userResult.data.meta?.sentFrom === 'scanner') {
                logger.debug('[API] Ignoring scanner-originated user message for agent input queue')
                return
            }
            this.trackPendingUserEcho(userResult.data.content.text)
            this.enqueueUserMessage(userResult.data)
            return
        }

        this.emit('message', message.content)
    }

    private async backfillIfNeeded(): Promise<void> {
        if (!this.needsBackfill) {
            return
        }
        try {
            await this.backfillMessages()
            this.needsBackfill = false
        } catch (error) {
            logger.debug('[API] Backfill failed', error)
            this.needsBackfill = true
        }
    }

    private async backfillMessages(): Promise<void> {
        if (this.backfillInFlight) {
            await this.backfillInFlight
            return
        }

        const startSeq = this.lastSeenMessageSeq
        if (startSeq === null) {
            logger.debug('[API] Skipping backfill because no last-seen message sequence is available')
            return
        }

        const limit = 200
        const run = async () => {
            let cursor = startSeq
            while (true) {
                const response = await axios.get(
                    `${configuration.apiUrl}/cli/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                    {
                        params: { afterSeq: cursor, limit },
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15_000
                    }
                )

                const parsed = CliMessagesResponseSchema.safeParse(response.data)
                if (!parsed.success) {
                    throw apiValidationError('Invalid /cli/sessions/:id/messages response', response)
                }

                const messages = parsed.data.messages
                if (messages.length === 0) {
                    break
                }

                let maxSeq = cursor
                for (const message of messages) {
                    if (typeof message.seq === 'number') {
                        if (message.seq > maxSeq) {
                            maxSeq = message.seq
                        }
                    }
                    this.handleIncomingMessage(message)
                }

                const observedSeq = this.lastSeenMessageSeq ?? maxSeq
                const nextCursor = Math.max(maxSeq, observedSeq)
                if (nextCursor <= cursor) {
                    logger.debug('[API] Backfill stopped due to non-advancing cursor', {
                        cursor,
                        maxSeq,
                        observedSeq
                    })
                    break
                }

                cursor = nextCursor
                if (messages.length < limit) {
                    break
                }
            }
        }

        this.backfillInFlight = run().finally(() => {
            this.backfillInFlight = null
        })

        await this.backfillInFlight
    }

    getCurrentMachineId(): string | null {
        const machineId = this.metadata?.machineId
        if (typeof machineId !== 'string') {
            return null
        }
        const trimmed = machineId.trim()
        return trimmed.length > 0 ? trimmed : null
    }

    async listOnlineMachines(): Promise<Machine[]> {
        const response = await (async () => {
            try {
                return await axios.get(
                    `${configuration.apiUrl}/cli/machines`,
                    {
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 30_000
                    }
                )
            } catch (error) {
                const info = extractErrorInfo(error)
                throw new Error(info.responseErrorText || info.message)
            }
        })()

        const parsed = CliMachinesResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw apiValidationError('Invalid /cli/machines response', response)
        }

        return parsed.data.machines.map((raw) => {
            const metadata = (() => {
                if (raw.metadata == null) return null
                const parsedMetadata = MachineMetadataSchema.safeParse(raw.metadata)
                return parsedMetadata.success ? parsedMetadata.data : null
            })()

            const runnerState = (() => {
                if (raw.runnerState == null) return null
                const parsedRunnerState = RunnerStateSchema.safeParse(raw.runnerState)
                return parsedRunnerState.success ? parsedRunnerState.data : null
            })()

            return {
                id: raw.id,
                seq: raw.seq,
                createdAt: raw.createdAt,
                updatedAt: raw.updatedAt,
                active: raw.active,
                activeAt: raw.activeAt,
                metadata,
                metadataVersion: raw.metadataVersion,
                runnerState,
                runnerStateVersion: raw.runnerStateVersion
            }
        })
    }

    async spawnSessionOnMachine(options: {
        machineId: string
        directory: string
        agent?: 'claude' | 'codex' | 'gemini' | 'opencode'
        model?: string
        yolo?: boolean
        sessionType?: 'simple' | 'worktree'
        worktreeName?: string
        worktreeBranch?: string
    }): Promise<CliSpawnSessionResponse> {
        const response = await (async () => {
            try {
                return await axios.post(
                    `${configuration.apiUrl}/cli/machines/${encodeURIComponent(options.machineId)}/spawn`,
                    {
                        directory: options.directory,
                        agent: options.agent,
                        model: options.model,
                        yolo: options.yolo,
                        sessionType: options.sessionType,
                        worktreeName: options.worktreeName,
                        worktreeBranch: options.worktreeBranch
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 60_000
                    }
                )
            } catch (error) {
                const info = extractErrorInfo(error)
                throw new Error(info.responseErrorText || info.message)
            }
        })()

        const parsed = CliSpawnSessionResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw apiValidationError('Invalid /cli/machines/:id/spawn response', response)
        }

        return parsed.data
    }

    sendClaudeSessionMessage(body: RawJSONLines): void {
        let content: MessageContent

        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        }

        this.emitSocketSafely('message', {
            sid: this.sessionId,
            message: content
        })

        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }))
        }
    }

    sendUserMessage(text: string, meta?: MessageMeta): void {
        if (!text) {
            return
        }

        // Local transcript scanners can echo messages that were already sent through hub.
        // Suppress one matching echo to avoid duplicate persisted messages and SSE events.
        if (this.consumePendingUserEcho(text)) {
            logger.debug('[API] Suppressed echoed user message from local transcript scanner')
            return
        }

        const content: MessageContent = {
            role: 'user',
            content: {
                type: 'text',
                text
            },
            meta: {
                sentFrom: 'cli',
                ...(meta ?? {})
            }
        }

        this.emitSocketSafely('message', {
            sid: this.sessionId,
            message: content
        })
    }

    sendCodexMessage(body: unknown): void {
        const content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        }
        this.emitSocketSafely('message', {
            sid: this.sessionId,
            message: content
        })
    }

    sendSessionEvent(event: {
        type: 'switch'
        mode: 'local' | 'remote'
    } | {
        type: 'message'
        message: string
    } | {
        type: 'permission-mode-changed'
        mode: SessionPermissionMode
    } | {
        type: 'ready'
    }, id?: string): void {
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        }

        this.emitSocketSafely('message', {
            sid: this.sessionId,
            message: content
        })
    }

    keepAlive(
        thinking: boolean,
        mode: 'local' | 'remote',
        runtime?: { permissionMode?: SessionPermissionMode; modelMode?: SessionModelMode },
        options?: { volatile?: boolean }
    ): void {
        this._lastThinking = thinking
        this.emitSocketSafely('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode,
            ...(runtime ?? {})
        }, { volatile: options?.volatile ?? true })
    }

    sendSessionDeath(): void {
        void cleanupUploadDir(this.sessionId)
        this.emitSocketSafely('session-end', { sid: this.sessionId, time: Date.now() }, { allowWhenDisconnected: true })
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata): void {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata ?? ({} as Metadata)
                const updated = handler(current)

                const answer = await this.emitWithAckWhenConnected('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: updated
                }) as unknown

                applyVersionedAck(answer, {
                    valueKey: 'metadata',
                    parseValue: (value) => {
                        const parsed = MetadataSchema.safeParse(value)
                        return parsed.success ? parsed.data : null
                    },
                    applyValue: (value) => {
                        this.metadata = value
                    },
                    applyVersion: (version) => {
                        this.metadataVersion = version
                    },
                    logInvalidValue: (context, version) => {
                        const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                        logger.debug(`[API] Ignoring invalid metadata value from ${suffix}`, { version })
                    },
                    invalidResponseMessage: 'Invalid update-metadata response',
                    errorMessage: 'Metadata update failed',
                    versionMismatchMessage: 'Metadata version mismatch'
                })
            })
        })
    }

    updateAgentState(handler: (state: AgentState) => AgentState): void {
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                const current = this.agentState ?? ({} as AgentState)
                const updated = handler(current)

                const answer = await this.emitWithAckWhenConnected('update-state', {
                    sid: this.sessionId,
                    expectedVersion: this.agentStateVersion,
                    agentState: updated
                }) as unknown

                applyVersionedAck(answer, {
                    valueKey: 'agentState',
                    parseValue: (value) => {
                        const parsed = AgentStateSchema.safeParse(value)
                        return parsed.success ? parsed.data : null
                    },
                    applyValue: (value) => {
                        this.agentState = value
                    },
                    applyVersion: (version) => {
                        this.agentStateVersion = version
                    },
                    logInvalidValue: (context, version) => {
                        const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                        logger.debug(`[API] Ignoring invalid agentState value from ${suffix}`, { version })
                    },
                    invalidResponseMessage: 'Invalid update-state response',
                    errorMessage: 'Agent state update failed',
                    versionMismatchMessage: 'Agent state version mismatch'
                })
            })
        })
    }

    private async emitWithAckWhenConnected(event: string, payload: unknown, timeoutMs: number = 15_000): Promise<unknown> {
        const connected = await this.waitForConnected(timeoutMs)
        if (!connected) {
            throw new Error(`Socket not connected for '${event}'`)
        }
        return await (this.socket as any).timeout(timeoutMs).emitWithAck(event, payload)
    }

    private async waitForConnected(timeoutMs: number): Promise<boolean> {
        if (this.socket.connected) {
            return true
        }

        this.socket.connect()

        return await new Promise<boolean>((resolve) => {
            let settled = false

            const cleanup = () => {
                this.socket.off('connect', onConnect)
                clearTimeout(timeout)
            }

            const onConnect = () => {
                if (settled) return
                settled = true
                cleanup()
                resolve(true)
            }

            const timeout = setTimeout(() => {
                if (settled) return
                settled = true
                cleanup()
                resolve(false)
            }, Math.max(0, timeoutMs))

            this.socket.on('connect', onConnect)
        })
    }

    private async drainLock(lock: AsyncLock, timeoutMs: number): Promise<boolean> {
        if (timeoutMs <= 0) {
            return false
        }

        return await new Promise<boolean>((resolve) => {
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | null = null

            const finish = (value: boolean) => {
                if (settled) return
                settled = true
                if (timeout) {
                    clearTimeout(timeout)
                }
                resolve(value)
            }

            timeout = setTimeout(() => finish(false), timeoutMs)

            lock.inLock(async () => { })
                .then(() => finish(true))
                .catch(() => finish(false))
        })
    }

    async flush(options?: { timeoutMs?: number }): Promise<void> {
        const deadlineMs = Date.now() + (options?.timeoutMs ?? 5_000)

        const remainingMs = () => Math.max(0, deadlineMs - Date.now())

        await this.drainLock(this.metadataLock, remainingMs())
        await this.drainLock(this.agentStateLock, remainingMs())

        if (remainingMs() === 0) {
            return
        }

        const connected = await this.waitForConnected(remainingMs())
        if (!connected) {
            return
        }

        const pingTimeoutMs = remainingMs()
        if (pingTimeoutMs === 0) {
            return
        }

        try {
            await this.socket.timeout(pingTimeoutMs).emitWithAck('ping')
        } catch {
            // best effort
        }
    }

    close(): void {
        this.rpcHandlerManager.onSocketDisconnect()
        this.terminalManager.closeAll()
        this.socket.disconnect()
    }
}
