/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import type { CodexCollaborationMode, DecryptedMessage, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store, CancelQueuedMessageResult } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import {
    RpcGateway,
    type RpcCodexModel,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcListDirectoryResponse,
    type RpcListCodexModelsResponse,
    type RpcListOpencodeModelsResponse,
    type RpcOpencodeModel,
    type RpcPathExistsResponse,
    type RpcReadFileResponse,
    type RpcUploadFileResponse
} from './rpcGateway'
import { SessionCache } from './sessionCache'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type {
    RpcCodexModel,
    RpcCommandResponse,
    RpcDeleteUploadResponse,
    RpcListDirectoryResponse,
    RpcListCodexModelsResponse,
    RpcListOpencodeModelsResponse,
    RpcOpencodeModel,
    RpcPathExistsResponse,
    RpcReadFileResponse,
    RpcUploadFileResponse
} from './rpcGateway'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

export class SyncEngine {
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private inactivityTimer: NodeJS.Timeout | null = null

    constructor(
        store: Store,
        io: Server,
        rpcRegistry: RpcRegistry,
        sseManager: SSEManager
    ) {
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
        this.machineCache = new MachineCache(store, this.eventPublisher)
        this.messageService = new MessageService(
            store,
            io,
            this.eventPublisher,
            (sessionId, updatedAt) => this.recordSessionActivity(sessionId, updatedAt)
        )
        this.rpcGateway = new RpcGateway(io, rpcRegistry)
        this.reloadAll()
        this.inactivityTimer = setInterval(() => this.expireInactive(), 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    subscribe(listener: SyncEventListener): () => void {
        return this.eventPublisher.subscribe(listener)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) {
            return event.namespace
        }
        if ('sessionId' in event) {
            return this.getSession(event.sessionId)?.namespace
        }
        if ('machineId' in event) {
            return this.machineCache.getMachine(event.machineId)?.namespace
        }
        return undefined
    }

    getSessions(): Session[] {
        return this.sessionCache.getSessions()
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.sessionCache.getSessionsByNamespace(namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessionCache.getSession(sessionId) ?? this.sessionCache.refreshSession(sessionId) ?? undefined
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            ?? this.sessionCache.refreshSession(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        return this.sessionCache.resolveSessionAccess(sessionId, namespace)
    }

    getActiveSessions(): Session[] {
        return this.sessionCache.getActiveSessions()
    }

    getMachines(): Machine[] {
        return this.machineCache.getMachines()
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getMachinesByNamespace(namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machineCache.getMachine(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        return this.machineCache.getMachineByNamespace(machineId, namespace)
    }

    getOnlineMachines(): Machine[] {
        return this.machineCache.getOnlineMachines()
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getOnlineMachinesByNamespace(namespace)
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
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getMessagesPageByPosition(
        sessionId: string,
        options: { limit: number; before?: { at: number; seq: number } | null }
    ): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            nextBeforeSeq: number | null
            nextBeforeAt: number | null
            hasMore: boolean
        }
    } {
        return this.messageService.getMessagesPageByPosition(sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getMessagesAfter(sessionId, options)
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            // Snapshot agent session IDs before refresh — safe because JS is single-threaded
            // and refreshSession replaces the Map entry with a new object.
            const before = this.sessionCache.getSession(event.sessionId)
            this.sessionCache.refreshSession(event.sessionId)
            const after = this.sessionCache.getSession(event.sessionId)
            if (after?.metadata && !this.hasSameAgentSessionIds(before?.metadata ?? null, after.metadata)) {
                void this.sessionCache.deduplicateByAgentSessionId(event.sessionId).catch(() => {
                    // best-effort: dedup failure is harmless, web-side safety net hides remaining duplicates
                })
            }
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            this.machineCache.refreshMachine(event.machineId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (!this.getSession(event.sessionId)) {
                this.sessionCache.refreshSession(event.sessionId)
            }
        }

        this.eventPublisher.emit(event)
    }

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        model?: string | null
        modelReasoningEffort?: string | null
        effort?: string | null
        collaborationMode?: CodexCollaborationMode
    }): void {
        this.sessionCache.handleSessionAlive(payload)
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleSessionEnd(payload: { sid: string; time: number; reason?: 'completed' | 'terminated' | 'error' }): void {
        this.sessionCache.handleSessionEnd(payload)
        this.eventPublisher.emit({
            type: 'session-ended',
            sessionId: payload.sid,
            reason: payload.reason
        })
        // Retry dedup now that this session is inactive — a prior dedup may have
        // skipped it because it was still active at the time.
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        this.sessionCache.applyBackgroundTaskDelta(sessionId, delta)
    }

    recordSessionActivity(sessionId: string, updatedAt: number): void {
        this.sessionCache.recordSessionActivity(sessionId, updatedAt)
    }

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        this.machineCache.handleMachineAlive(payload)
    }

    private expireInactive(): void {
        const expired = this.sessionCache.expireInactive()
        // Sort by most recent first so dedup keeps the newest session when multiple
        // duplicates for the same agent thread expire in the same sweep.
        const sorted = expired
            .map((id) => this.sessionCache.getSession(id))
            .filter((s): s is NonNullable<typeof s> => s != null)
            .sort((a, b) => (b.activeAt - a.activeAt) || (b.updatedAt - a.updatedAt))
        for (const session of sorted) {
            this.triggerDedupIfNeeded(session.id)
        }
        this.machineCache.expireInactive()
    }

    private reloadAll(): void {
        this.sessionCache.reloadAll()
        this.machineCache.reloadAll()
    }

    getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        model?: string,
        effort?: string,
        modelReasoningEffort?: string
    ): Session {
        return this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace, model, effort, modelReasoningEffort)
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Machine {
        return this.machineCache.getOrCreateMachine(id, metadata, runnerState, namespace)
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: Array<{
                id: string
                filename: string
                mimeType: string
                size: number
                path: string
                previewUrl?: string
            }>
            sentFrom?: 'telegram-bot' | 'webapp'
        }
    ): Promise<void> {
        await this.messageService.sendMessage(sessionId, payload)
        this.sessionCache.markMessageQueued(sessionId)
    }

    async cancelQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<CancelQueuedMessageResult> {
        return this.messageService.cancelQueuedMessage(sessionId, messageId)
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.rpcGateway.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.rpcGateway.denyPermission(sessionId, requestId, decision)
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.rpcGateway.abortSession(sessionId)
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.rpcGateway.killSession(sessionId)
        this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.rpcGateway.switchSession(sessionId, to)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.sessionCache.deleteSession(sessionId)
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): Promise<void> {
        const session = this.sessionCache.getSession(sessionId)
        if (!session?.active) {
            // For inactive sessions, update the in-memory cache directly without
            // an RPC call — the CLI is not running yet. The updated value will be
            // passed to the spawned process when the session is resumed.
            this.sessionCache.applySessionConfig(sessionId, config)
            return
        }

        const result = await this.rpcGateway.requestSessionConfig(sessionId, config)
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as {
            applied?: {
                permissionMode?: Session['permissionMode']
                model?: Session['model']
                modelReasoningEffort?: Session['modelReasoningEffort']
                effort?: Session['effort']
                collaborationMode?: Session['collaborationMode']
            }
        }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error('Missing applied session config')
        }

        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        return await this.rpcGateway.spawnSession(
            machineId,
            directory,
            agent,
            model,
            modelReasoningEffort,
            yolo,
            sessionType,
            worktreeName,
            resumeSessionId,
            effort,
            permissionMode
        )
    }

    async resumeSession(sessionId: string, namespace: string, opts?: { permissionMode?: PermissionMode }): Promise<ResumeSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        if (session.active) {
            return { type: 'success', sessionId: access.sessionId }
        }

        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string') {
            return { type: 'error', message: 'Session metadata missing path', code: 'resume_unavailable' }
        }

        const flavor = metadata.flavor === 'codex' || metadata.flavor === 'gemini' || metadata.flavor === 'opencode' || metadata.flavor === 'cursor'
            ? metadata.flavor
            : 'claude'
        const resumeToken = flavor === 'codex'
            ? metadata.codexSessionId
            : flavor === 'gemini'
                ? metadata.geminiSessionId
                : flavor === 'opencode'
                    ? metadata.opencodeSessionId
                    : flavor === 'cursor'
                        ? metadata.cursorSessionId
                        : metadata.claudeSessionId

        if (!resumeToken) {
            return { type: 'error', message: 'Resume session ID unavailable', code: 'resume_unavailable' }
        }

        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (onlineMachines.length === 0) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const targetMachine = (() => {
            if (metadata.machineId) {
                const exact = onlineMachines.find((machine) => machine.id === metadata.machineId)
                if (exact) return exact
            }
            if (metadata.host) {
                const hostMatch = onlineMachines.find((machine) => machine.metadata?.host === metadata.host)
                if (hostMatch) return hostMatch
            }
            return null
        })()

        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const effectivePermissionMode = opts?.permissionMode ?? session.permissionMode ?? undefined
        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            metadata.path,
            flavor,
            session.model ?? undefined,
            session.modelReasoningEffort ?? undefined,
            undefined,
            undefined,
            undefined,
            resumeToken,
            session.effort ?? undefined,
            effectivePermissionMode
        )

        if (spawnResult.type !== 'success') {
            return { type: 'error', message: spawnResult.message, code: 'resume_failed' }
        }

        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) {
            return { type: 'error', message: 'Session failed to become active', code: 'resume_failed' }
        }

        if (spawnResult.sessionId !== access.sessionId) {
            // The old session may have already been merged by the automatic dedup path
            // (triggered when the spawned CLI sets its agent session ID in metadata).
            // Only attempt the explicit merge if the old session still exists.
            const oldSession = this.sessionCache.getSessionByNamespace(access.sessionId, namespace)
            if (oldSession) {
                try {
                    await this.sessionCache.mergeSessions(access.sessionId, spawnResult.sessionId, namespace)
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Failed to merge resumed session'
                    return { type: 'error', message, code: 'resume_failed' }
                }
            }
        }

        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    private hasSameAgentSessionIds(
        prev: Session['metadata'] | null,
        next: NonNullable<Session['metadata']>
    ): boolean {
        return (prev?.codexSessionId ?? null) === (next.codexSessionId ?? null)
            && (prev?.claudeSessionId ?? null) === (next.claudeSessionId ?? null)
            && (prev?.geminiSessionId ?? null) === (next.geminiSessionId ?? null)
            && (prev?.opencodeSessionId ?? null) === (next.opencodeSessionId ?? null)
            && (prev?.cursorSessionId ?? null) === (next.cursorSessionId ?? null)
    }

    private triggerDedupIfNeeded(sessionId: string): void {
        const session = this.sessionCache.getSession(sessionId)
        if (session?.metadata) {
            void this.sessionCache.deduplicateByAgentSessionId(sessionId).catch(() => {
                // best-effort: web-side safety net hides remaining duplicates
            })
        }
    }

    async waitForSessionActive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const session = this.getSession(sessionId)
            if (session?.active) {
                return true
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.rpcGateway.checkPathsExist(machineId, paths)
    }

    async listMachineDirectory(machineId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listMachineDirectory(machineId, path)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitStatus(sessionId, cwd)
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffNumstat(sessionId, options)
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffFile(sessionId, options)
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.rpcGateway.readSessionFile(sessionId, path)
    }

    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listDirectory(sessionId, path)
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.rpcGateway.uploadFile(sessionId, filename, content, mimeType)
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.rpcGateway.deleteUploadFile(sessionId, path)
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.runRipgrep(sessionId, args, cwd)
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<{
        success: boolean
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' | 'plugin' | 'project' }>
        error?: string
    }> {
        return await this.rpcGateway.listSlashCommands(sessionId, agent)
    }

    async listSkills(sessionId: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.rpcGateway.listSkills(sessionId)
    }

    async listCodexModelsForSession(sessionId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForSession(sessionId)
    }

    async listCodexModelsForMachine(machineId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForMachine(machineId)
    }

    async listOpencodeModelsForSession(sessionId: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForSession(sessionId)
    }

    async listOpencodeModelsForCwd(machineId: string, cwd: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForCwd(machineId, cwd)
    }
}
