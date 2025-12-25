import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import type { ZodType } from 'zod'
import { logger } from '@/ui/logger'
import { backoff } from '@/utils/time'
import { AsyncLock } from '@/utils/lock'
import type { RawJSONLines } from '@/claude/types'
import { configuration } from '@/configuration'
import type { AgentState, ClientToServerEvents, MessageContent, MessageMeta, Metadata, ServerToClientEvents, Session, Update, UserMessage } from './types'
import { AgentStateSchema, MetadataSchema, UserMessageSchema } from './types'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import { TerminalManager } from '@/terminal/TerminalManager'
import {
    TerminalClosePayloadSchema,
    TerminalOpenPayloadSchema,
    TerminalResizePayloadSchema,
    TerminalWritePayloadSchema
} from '@/terminal/types'

export class ApiSessionClient extends EventEmitter {
    private readonly token: string
    readonly sessionId: string
    private metadata: Metadata | null
    private metadataVersion: number
    private agentState: AgentState | null
    private agentStateVersion: number
    private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>
    private pendingMessages: UserMessage[] = []
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null
    readonly rpcHandlerManager: RpcHandlerManager
    private readonly terminalManager: TerminalManager
    private agentStateLock = new AsyncLock()
    private metadataLock = new AsyncLock()

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

        this.socket = io(`${configuration.serverUrl}/cli`, {
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
            onReady: (payload) => this.socket.emit('terminal:ready', payload),
            onOutput: (payload) => this.socket.emit('terminal:output', payload),
            onExit: (payload) => this.socket.emit('terminal:exit', payload),
            onError: (payload) => this.socket.emit('terminal:error', payload)
        })

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully')
            this.rpcHandlerManager.onSocketConnect(this.socket)
        })

        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason)
            this.rpcHandlerManager.onSocketDisconnect()
            this.terminalManager.closeAll()
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error)
            this.rpcHandlerManager.onSocketDisconnect()
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
                    const content = data.body.message.content

                    const userResult = UserMessageSchema.safeParse(content)
                    if (userResult.success) {
                        if (this.pendingMessageCallback) {
                            this.pendingMessageCallback(userResult.data)
                        } else {
                            this.pendingMessages.push(userResult.data)
                        }
                        return
                    }

                    this.emit('message', content)
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

        this.socket.emit('message', {
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

        this.socket.emit('message', {
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
        this.socket.emit('message', {
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
        mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
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

        this.socket.emit('message', {
            sid: this.sessionId,
            message: content
        })
    }

    keepAlive(thinking: boolean, mode: 'local' | 'remote'): void {
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        })
    }

    sendSessionDeath(): void {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() })
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata): void {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata ?? ({} as Metadata)
                const updated = handler(current)

                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: updated
                }) as unknown

                if (!answer || typeof answer !== 'object') {
                    throw new Error('Invalid update-metadata response')
                }

                const obj = answer as { result?: unknown; version?: unknown; metadata?: unknown }
                if (obj.result === 'success' && typeof obj.version === 'number') {
                    const next = obj.metadata
                    if (next == null) {
                        this.metadata = null
                    } else {
                        const parsed = MetadataSchema.safeParse(next)
                        if (parsed.success) {
                            this.metadata = parsed.data
                        } else {
                            logger.debug('[API] Ignoring invalid metadata value from ack', { version: obj.version })
                        }
                    }
                    this.metadataVersion = obj.version
                    return
                }

                if (obj.result === 'version-mismatch' && typeof obj.version === 'number') {
                    const next = obj.metadata
                    if (next == null) {
                        this.metadata = null
                    } else {
                        const parsed = MetadataSchema.safeParse(next)
                        if (parsed.success) {
                            this.metadata = parsed.data
                        } else {
                            logger.debug('[API] Ignoring invalid metadata value from version-mismatch ack', { version: obj.version })
                        }
                    }
                    this.metadataVersion = obj.version
                    throw new Error('Metadata version mismatch')
                }
            })
        })
    }

    updateAgentState(handler: (state: AgentState) => AgentState): void {
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                const current = this.agentState ?? ({} as AgentState)
                const updated = handler(current)

                const answer = await this.socket.emitWithAck('update-state', {
                    sid: this.sessionId,
                    expectedVersion: this.agentStateVersion,
                    agentState: updated
                }) as unknown

                if (!answer || typeof answer !== 'object') {
                    throw new Error('Invalid update-state response')
                }

                const obj = answer as { result?: unknown; version?: unknown; agentState?: unknown }
                if (obj.result === 'success' && typeof obj.version === 'number') {
                    const next = obj.agentState
                    if (next == null) {
                        this.agentState = null
                    } else {
                        const parsed = AgentStateSchema.safeParse(next)
                        if (parsed.success) {
                            this.agentState = parsed.data
                        } else {
                            logger.debug('[API] Ignoring invalid agentState value from ack', { version: obj.version })
                        }
                    }
                    this.agentStateVersion = obj.version
                    return
                }

                if (obj.result === 'version-mismatch' && typeof obj.version === 'number') {
                    const next = obj.agentState
                    if (next == null) {
                        this.agentState = null
                    } else {
                        const parsed = AgentStateSchema.safeParse(next)
                        if (parsed.success) {
                            this.agentState = parsed.data
                        } else {
                            logger.debug('[API] Ignoring invalid agentState value from version-mismatch ack', { version: obj.version })
                        }
                    }
                    this.agentStateVersion = obj.version
                    throw new Error('Agent state version mismatch')
                }
            })
        })
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
