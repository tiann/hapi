/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-server is the server (Socket.IO + REST)
 * - hapi CLI connects directly to the server (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import { z } from 'zod'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { extractTodoWriteTodosFromMessageContent, TodosSchema, type TodoItem } from './todos'

export type ConnectionStatus = 'disconnected' | 'connected'

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    tools: z.array(z.string()).optional(),
    flavor: z.string().nullish(),
    worktree: z.object({
        basePath: z.string(),
        branch: z.string(),
        name: z.string(),
        worktreePath: z.string().optional(),
        createdAt: z.number().optional()
    }).optional()
}).passthrough()

export type Metadata = z.infer<typeof MetadataSchema>

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.unknown(),
        createdAt: z.number().nullish()
    }).passthrough()).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.unknown(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().optional(),
        mode: z.string().optional(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
        allowTools: z.array(z.string()).optional(),
        answers: z.record(z.string(), z.array(z.string())).optional()
    }).passthrough()).nullish()
}).passthrough()

export type AgentState = z.infer<typeof AgentStateSchema>

const machineMetadataSchema = z.object({
    host: z.string().optional(),
    platform: z.string().optional(),
    happyCliVersion: z.string().optional(),
    displayName: z.string().optional()
}).passthrough()

export interface Session {
    id: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    metadata: Metadata | null
    metadataVersion: number
    agentState: AgentState | null
    agentStateVersion: number
    thinking: boolean
    thinkingAt: number
    todos?: TodoItem[]
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | null
    modelMode?: 'default' | 'sonnet' | 'opus' | null
}

export interface Machine {
    id: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    metadata: {
        host: string
        platform: string
        happyCliVersion: string
        displayName?: string
        [key: string]: unknown
    } | null
    metadataVersion: number
    daemonState: unknown | null
    daemonStateVersion: number
}

export interface DecryptedMessage {
    id: string
    seq: number
    localId: string | null
    content: unknown
    createdAt: number
}

export type FetchMessagesResult =
    | { ok: true; messages: DecryptedMessage[] }
    | { ok: false; status: number | null; error: string }

export type RpcCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type RpcReadFileResponse = {
    success: boolean
    content?: string
    error?: string
}

export type RpcPathExistsResponse = {
    exists: Record<string, boolean>
}

export type SyncEventType =
    | 'session-added'
    | 'session-updated'
    | 'session-removed'
    | 'message-received'
    | 'machine-updated'
    | 'connection-changed'

export interface SyncEvent {
    type: SyncEventType
    sessionId?: string
    machineId?: string
    data?: unknown
    message?: DecryptedMessage
}

export type SyncEventListener = (event: SyncEvent) => void

function clampAliveTime(t: number): number | null {
    if (!Number.isFinite(t)) return null
    const now = Date.now()
    if (t > now) return now
    if (t < now - 1000 * 60 * 10) return null
    return t
}

export class SyncEngine {
    private sessions: Map<string, Session> = new Map()
    private machines: Map<string, Machine> = new Map()
    private sessionMessages: Map<string, DecryptedMessage[]> = new Map()
    private listeners: Set<SyncEventListener> = new Set()
    private connectionStatus: ConnectionStatus = 'connected'

    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly lastBroadcastAtByMachineId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()
    private inactivityTimer: NodeJS.Timeout | null = null

    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly rpcRegistry: RpcRegistry,
        private readonly sseManager: SSEManager
    ) {
        this.reloadAll()
        this.inactivityTimer = setInterval(() => this.expireInactive(), 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    start(): Promise<void> {
        return Promise.resolve()
    }

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    private emit(event: SyncEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event)
            } catch (error) {
                console.error('[SyncEngine] Listener error:', error)
            }
        }

        const webappEvent: SyncEvent = event.type === 'message-received'
            ? {
                type: event.type,
                sessionId: event.sessionId,
                machineId: event.machineId,
                message: event.message
            }
            : {
                type: event.type,
                sessionId: event.sessionId,
                machineId: event.machineId
            }

        this.sseManager.broadcast(webappEvent)
    }

    getConnectionStatus(): ConnectionStatus {
        return this.connectionStatus
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getActiveSessions(): Session[] {
        return this.getSessions().filter(s => s.active)
    }

    getMachines(): Machine[] {
        return Array.from(this.machines.values())
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machines.get(machineId)
    }

    getOnlineMachines(): Machine[] {
        return this.getMachines().filter(m => m.active)
    }

    getSessionMessages(sessionId: string): DecryptedMessage[] {
        return this.sessionMessages.get(sessionId) || []
    }

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            hasMore: boolean
        }
    } {
        const stored = this.store.getMessages(sessionId, options.limit, options.beforeSeq ?? undefined)
        const messages: DecryptedMessage[] = stored.map((m) => ({
            id: m.id,
            seq: m.seq,
            localId: m.localId,
            content: m.content,
            createdAt: m.createdAt
        }))

        let oldestSeq: number | null = null
        for (const message of messages) {
            if (typeof message.seq !== 'number') continue
            if (oldestSeq === null || message.seq < oldestSeq) {
                oldestSeq = message.seq
            }
        }

        const nextBeforeSeq = oldestSeq
        const hasMore = nextBeforeSeq !== null && this.store.getMessages(sessionId, 1, nextBeforeSeq).length > 0

        return {
            messages,
            page: {
                limit: options.limit,
                beforeSeq: options.beforeSeq,
                nextBeforeSeq,
                hasMore
            }
        }
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            this.refreshSession(event.sessionId)
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            this.refreshMachine(event.machineId)
            return
        }

        this.emit(event)
    }

    handleSessionAlive(payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }): void {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        const wasActive = session.active
        const wasThinking = session.thinking

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        session.thinking = Boolean(payload.thinking)
        session.thinkingAt = t

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        const shouldBroadcast = (!wasActive && session.active)
            || (wasThinking !== session.thinking)
            || (now - lastBroadcastAt > 10_000)

        if (shouldBroadcast) {
            this.lastBroadcastAtBySessionId.set(session.id, now)
            this.emit({ type: 'session-updated', sessionId: session.id, data: { activeAt: session.activeAt, thinking: session.thinking } })
        }
    }

    handleSessionEnd(payload: { sid: string; time: number }): void {
        const t = clampAliveTime(payload.time) ?? Date.now()

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        if (!session.active && !session.thinking) {
            return
        }

        session.active = false
        session.thinking = false
        session.thinkingAt = t

        this.emit({ type: 'session-updated', sessionId: session.id, data: { active: false, thinking: false } })
    }

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const machine = this.machines.get(payload.machineId) ?? this.refreshMachine(payload.machineId)
        if (!machine) return

        const wasActive = machine.active
        machine.active = true
        machine.activeAt = Math.max(machine.activeAt, t)

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtByMachineId.get(machine.id) ?? 0
        const shouldBroadcast = (!wasActive && machine.active) || (now - lastBroadcastAt > 10_000)
        if (shouldBroadcast) {
            this.lastBroadcastAtByMachineId.set(machine.id, now)
            this.emit({ type: 'machine-updated', machineId: machine.id, data: { activeAt: machine.activeAt } })
        }
    }

    private expireInactive(): void {
        const now = Date.now()
        const sessionTimeoutMs = 30_000
        const machineTimeoutMs = 45_000

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            session.active = false
            session.thinking = false
            this.emit({ type: 'session-updated', sessionId: session.id, data: { active: false } })
        }

        for (const machine of this.machines.values()) {
            if (!machine.active) continue
            if (now - machine.activeAt <= machineTimeoutMs) continue
            machine.active = false
            this.emit({ type: 'machine-updated', machineId: machine.id, data: { active: false } })
        }
    }

    private refreshSession(sessionId: string): Session | null {
        let stored = this.store.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            if (existed) {
                this.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)

        if (stored.todos === null && !this.todoBackfillAttemptedSessionIds.has(sessionId)) {
            this.todoBackfillAttemptedSessionIds.add(sessionId)
            const messages = this.store.getMessages(sessionId, 200)
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const message = messages[i]
                const todos = extractTodoWriteTodosFromMessageContent(message.content)
                if (todos) {
                    const updated = this.store.setSessionTodos(sessionId, todos, message.createdAt)
                    if (updated) {
                        stored = this.store.getSession(sessionId) ?? stored
                    }
                    break
                }
            }
        }

        const metadata = (() => {
            const parsed = MetadataSchema.safeParse(stored.metadata)
            return parsed.success ? parsed.data : null
        })()

        const agentState = (() => {
            const parsed = AgentStateSchema.safeParse(stored.agentState)
            return parsed.success ? parsed.data : null
        })()

        const todos = (() => {
            if (stored.todos === null) return undefined
            const parsed = TodosSchema.safeParse(stored.todos)
            return parsed.success ? parsed.data : undefined
        })()

        const session: Session = {
            id: stored.id,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: existing?.active ?? stored.active,
            activeAt: existing?.activeAt ?? (stored.activeAt ?? stored.createdAt),
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: existing?.thinking ?? false,
            thinkingAt: existing?.thinkingAt ?? 0,
            todos,
            permissionMode: existing?.permissionMode ?? null,
            modelMode: existing?.modelMode ?? null
        }

        this.sessions.set(sessionId, session)
        this.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: session })
        return session
    }

    private refreshMachine(machineId: string): Machine | null {
        const stored = this.store.getMachine(machineId)
        if (!stored) {
            const existed = this.machines.delete(machineId)
            if (existed) {
                this.emit({ type: 'machine-updated', machineId, data: null })
            }
            return null
        }

        const existing = this.machines.get(machineId)

        const metadata = (() => {
            const parsed = machineMetadataSchema.safeParse(stored.metadata)
            if (!parsed.success) return null
            const data = parsed.data as Record<string, unknown>
            const host = typeof data.host === 'string' ? data.host : 'unknown'
            const platform = typeof data.platform === 'string' ? data.platform : 'unknown'
            const happyCliVersion = typeof data.happyCliVersion === 'string' ? data.happyCliVersion : 'unknown'
            const displayName = typeof data.displayName === 'string' ? data.displayName : undefined
            return { host, platform, happyCliVersion, displayName, ...data }
        })()

        const storedActiveAt = stored.activeAt ?? stored.createdAt
        const existingActiveAt = existing?.activeAt ?? 0
        const useStoredActivity = storedActiveAt > existingActiveAt

        const machine: Machine = {
            id: stored.id,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: useStoredActivity ? stored.active : (existing?.active ?? stored.active),
            activeAt: useStoredActivity ? storedActiveAt : (existingActiveAt || storedActiveAt),
            metadata,
            metadataVersion: stored.metadataVersion,
            daemonState: stored.daemonState,
            daemonStateVersion: stored.daemonStateVersion
        }

        this.machines.set(machineId, machine)
        this.emit({ type: 'machine-updated', machineId, data: machine })
        return machine
    }

    private reloadAll(): void {
        const sessions = this.store.getSessions()
        for (const s of sessions) {
            this.refreshSession(s.id)
        }

        const machines = this.store.getMachines()
        for (const m of machines) {
            this.refreshMachine(m.id)
        }
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown): Session {
        const stored = this.store.getOrCreateSession(tag, metadata, agentState)
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    getOrCreateMachine(id: string, metadata: unknown, daemonState: unknown): Machine {
        const stored = this.store.getOrCreateMachine(id, metadata, daemonState)
        return this.refreshMachine(stored.id) ?? (() => { throw new Error('Failed to load machine') })()
    }

    async fetchMessages(sessionId: string): Promise<FetchMessagesResult> {
        try {
            const stored = this.store.getMessages(sessionId, 200)
            const messages: DecryptedMessage[] = stored.map((m) => ({
                id: m.id,
                seq: m.seq,
                localId: m.localId,
                content: m.content,
                createdAt: m.createdAt
            }))
            this.sessionMessages.set(sessionId, messages)
            return { ok: true, messages }
        } catch (error) {
            return { ok: false, status: null, error: error instanceof Error ? error.message : 'Failed to load messages' }
        }
    }

    async sendMessage(sessionId: string, payload: { text: string; localId?: string | null; sentFrom?: 'telegram-bot' | 'webapp' }): Promise<void> {
        const session = this.sessions.get(sessionId)
        const sentFrom = payload.sentFrom ?? 'webapp'

        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text
            },
            meta: {
                sentFrom,
                permissionMode: session?.permissionMode || 'default',
                model: session?.modelMode === 'default' ? null : session?.modelMode ?? undefined
            }
        }

        const msg = this.store.addMessage(sessionId, content, payload.localId ?? undefined)

        const update = {
            id: msg.id,
            seq: Date.now(),
            createdAt: msg.createdAt,
            body: {
                t: 'new-message' as const,
                sid: sessionId,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)

        // Keep a small in-memory cache for Telegram rendering.
        const cached = this.sessionMessages.get(sessionId) ?? []
        cached.push({ id: msg.id, seq: msg.seq, localId: msg.localId, content: msg.content, createdAt: msg.createdAt })
        this.sessionMessages.set(sessionId, cached.slice(-200))

        this.emit({
            type: 'message-received',
            sessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt
            }
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]>
    ): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: true,
            mode,
            allowTools,
            decision,
            answers
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: false,
            decision
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted via Telegram Bot' })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, 'switch', { to })
    }

    async setPermissionMode(
        sessionId: string,
        mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    ): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (session) {
            session.permissionMode = mode
            this.emit({ type: 'session-updated', sessionId, data: session })
        }
    }

    async setModelMode(sessionId: string, model: 'default' | 'sonnet' | 'opus'): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (session) {
            session.modelMode = model
            this.emit({ type: 'session-updated', sessionId, data: session })
        }
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'codex' | 'gemini' = 'claude',
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const result = await this.machineRpc(
                machineId,
                'spawn-happy-session',
                { type: 'spawn-in-directory', directory, agent, yolo, sessionType, worktreeName }
            )
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                if (obj.type === 'success' && typeof obj.sessionId === 'string') {
                    return { type: 'success', sessionId: obj.sessionId }
                }
                if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                    return { type: 'error', message: obj.errorMessage }
                }
            }
            return { type: 'error', message: 'Unexpected spawn result' }
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        const result = await this.machineRpc(machineId, 'path-exists', { paths }) as RpcPathExistsResponse | unknown
        if (!result || typeof result !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const existsValue = (result as RpcPathExistsResponse).exists
        if (!existsValue || typeof existsValue !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const exists: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(existsValue)) {
            exists[key] = value === true
        }
        return exists
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-status', { cwd }) as RpcCommandResponse
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-numstat', options) as RpcCommandResponse
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-file', options) as RpcCommandResponse
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, 'readFile', { path }) as RpcReadFileResponse
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'ripgrep', { args, cwd }) as RpcCommandResponse
    }

    private async sessionRpc(sessionId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${sessionId}:${method}`, params)
    }

    private async machineRpc(machineId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${machineId}:${method}`, params)
    }

    private async rpcCall(method: string, params: unknown): Promise<unknown> {
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)
        if (!socketId) {
            throw new Error(`RPC handler not registered: ${method}`)
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new Error(`RPC socket disconnected: ${method}`)
        }

        const response = await socket.timeout(30_000).emitWithAck('rpc-request', {
            method,
            params: JSON.stringify(params)
        }) as unknown

        if (typeof response !== 'string') {
            return response
        }

        try {
            return JSON.parse(response) as unknown
        } catch {
            return response
        }
    }
}
