/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import { CODEX_DESKTOP_SYNC_SOURCE, getExecutionControl, getProviderSelectionIssue, isCcApiEffortAllowedForModel, isClaudeDeepSeekEffortAllowedForModel, isCodexDesktopMirrorSession } from '@hapi/protocol'
import type { CodexCollaborationMode, CodexServiceTier, DecryptedMessage, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import type { ManagedResumeOperation } from '../store/managedSessionStore'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService, type RecentUserMessage } from './messageService'
import type { MessagePageOptions, MessagePageResult } from './messagePage'
import {
    RpcGateway,
    type PermissionApproveDecision,
    type PermissionDenyDecision,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcListDirectoryResponse,
    type RpcPathExistsResponse,
    type RpcReadFileResponse,
    type RpcSpawnSessionResult,
    type RpcQuerySpawnSessionResult,
    type RpcSpawnSessionLookupOptions,
    type RpcUploadFileResponse
} from './rpcGateway'
import { acquireRunnerControl, releaseRunnerControl } from './sessionControlService'
import { SessionCache } from './sessionCache'
import { ManagedSessionOutcomeService, type ManagedResumeContext } from './managedSessionOutcome'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type {
    RpcCommandResponse,
    RpcDeleteUploadResponse,
    RpcListDirectoryResponse,
    RpcPathExistsResponse,
    RpcReadFileResponse,
    RpcSpawnSessionResult,
    RpcUploadFileResponse
} from './rpcGateway'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

type ResumeAttemptResult =
    | Extract<ResumeSessionResult, { type: 'success' }>
    | (Extract<ResumeSessionResult, { type: 'error' }> & { preserveSpawnRequest?: boolean })

class ResumeSessionError extends Error {
    constructor(
        readonly result: Extract<ResumeSessionResult, { type: 'error' }>,
        readonly preserveSpawnRequest: boolean = false
    ) {
        super(result.message)
    }
}

type TakeoverSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'access_denied' | 'session_not_found' | 'resume_unavailable' | 'resume_failed' | 'no_machine_online' | 'takeover_busy' }

function formatSessionConfigValue(value: unknown): string {
    return value === undefined ? 'missing' : JSON.stringify(value)
}

function assertCodexSessionConfigApplied(
    config: {
        model?: string | null
        modelReasoningEffort?: string | null
        serviceTier?: CodexServiceTier | null
    },
    applied: {
        model?: Session['model']
        modelReasoningEffort?: Session['modelReasoningEffort']
        serviceTier?: Session['serviceTier']
    }
): void {
    for (const key of ['model', 'modelReasoningEffort', 'serviceTier'] as const) {
        if (config[key] === undefined) {
            continue
        }
        if (applied[key] !== config[key]) {
            throw new Error(
                `Session config was not applied by the running agent (${key}: requested ${formatSessionConfigValue(config[key])}, got ${formatSessionConfigValue(applied[key])}). Restart or resume this session to load the latest HAPI CLI.`
            )
        }
    }
}

export function isIgnorableKillSessionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false
    }
    return error.message.startsWith('RPC handler not registered:')
        || error.message.startsWith('RPC socket disconnected:')
}

export class SyncEngine {
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private readonly managedSessionOutcomes: ManagedSessionOutcomeService
    private inactivityTimer: NodeJS.Timeout | null = null

    constructor(
        private readonly store: Store,
        io: Server,
        rpcRegistry: RpcRegistry,
        sseManager: SSEManager
    ) {
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
        this.machineCache = new MachineCache(store, this.eventPublisher)
        this.messageService = new MessageService(store, io, this.eventPublisher)
        this.rpcGateway = new RpcGateway(io, rpcRegistry)
        this.managedSessionOutcomes = new ManagedSessionOutcomeService(store.managedSessions)
        this.reloadAll()
        this.inactivityTimer = setInterval(() => {
            void this.expireInactive()
        }, 5_000)
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

    getSessionUnreadCounts(namespace: string): Map<string, number> {
        return this.store.sessionNotifications.getUnreadCountsByNamespace(namespace)
    }

    getTotalNotificationUnread(namespace: string): number {
        return this.store.sessionNotifications.getTotalUnreadCountByNamespace(namespace)
    }

    incrementSessionNotificationUnread(sessionId: string, namespace: string): number {
        const unreadCount = this.store.sessionNotifications.incrementUnread(sessionId, namespace)
        this.eventPublisher.emit({ type: 'session-updated', sessionId, namespace })
        return unreadCount
    }

    markSessionRead(sessionId: string, namespace: string): void {
        this.store.sessionNotifications.clearUnread(sessionId, namespace)
        this.eventPublisher.emit({ type: 'session-updated', sessionId, namespace })
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

    getMessagesPage(sessionId: string, options: MessagePageOptions): MessagePageResult {
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getMessagesAfter(sessionId, options)
    }

    getRecentUserMessages(sessionId: string, options: { limit: number }): RecentUserMessage[] {
        return this.messageService.getRecentUserMessages(sessionId, options)
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
        source?: 'cli' | 'codex-desktop-sync'
        generation?: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        model?: string | null
        modelReasoningEffort?: string | null
        serviceTier?: CodexServiceTier | null
        effort?: string | null
        collaborationMode?: CodexCollaborationMode
    }): void {
        if (payload.source === CODEX_DESKTOP_SYNC_SOURCE) {
            return
        }
        this.sessionCache.handleSessionAlive(payload)
    }

    handleSessionEnd(payload: { sid: string; time: number; source?: 'cli' | 'codex-desktop-sync'; generation?: number }): void {
        if (payload.source === CODEX_DESKTOP_SYNC_SOURCE) {
            return
        }
        if (!this.sessionCache.handleSessionEnd(payload)) return
        const session = this.sessionCache.getSession(payload.sid)
        const control = getExecutionControl(session?.metadata)
        if (session?.metadata && control?.owner === 'hapi-runner') {
            void this.sessionCache.patchSessionMetadata(payload.sid, session.namespace, (current) => ({
                ...current,
                executionControl: releaseRunnerControl(getExecutionControl(current), payload.time)
            }))
        }
        // Retry dedup now that this session is inactive — a prior dedup may have
        // skipped it because it was still active at the time.
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        this.sessionCache.applyBackgroundTaskDelta(sessionId, delta)
    }

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        this.machineCache.handleMachineAlive(payload)
    }

    private async expireInactive(): Promise<void> {
        const now = Date.now()
        const expired = this.sessionCache.expireInactive(now)
        // Sort by most recent first so dedup keeps the newest session when multiple
        // duplicates for the same agent thread expire in the same sweep.
        const sorted = expired
            .map((id) => this.sessionCache.getSession(id))
            .filter((s): s is NonNullable<typeof s> => s != null)
            .sort((a, b) => (b.activeAt - a.activeAt) || (b.updatedAt - a.updatedAt))
        for (const session of sorted) {
            this.triggerDedupIfNeeded(session.id)
        }
        await Promise.all(
            this.getSessions()
                .filter((session) => {
                    if (session.active) {
                        return false
                    }
                    const control = getExecutionControl(session.metadata)
                    return isCodexDesktopMirrorSession({ metadata: session.metadata, messages: null })
                        && control?.owner === 'hapi-runner'
                })
                .map(async (session) => {
                    try {
                        await this.sessionCache.patchSessionMetadata(session.id, session.namespace, (current) => {
                            const control = getExecutionControl(current)
                            if (!control || control.owner !== 'hapi-runner') {
                                return current
                            }
                            return {
                                ...current,
                                executionControl: releaseRunnerControl(control, now)
                            }
                        })
                    } catch {
                        // best-effort: a concurrent owner update can win; the next sweep will re-check
                    }
                })
        )
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
        modelReasoningEffort?: string,
        serviceTier?: CodexServiceTier
    ): Session {
        return this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace, model, effort, modelReasoningEffort, serviceTier)
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
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: PermissionApproveDecision,
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.rpcGateway.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: PermissionDenyDecision
    ): Promise<void> {
        await this.rpcGateway.denyPermission(sessionId, requestId, decision)
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.rpcGateway.abortSession(sessionId)
    }

    async archiveSession(sessionId: string): Promise<void> {
        try {
            await this.rpcGateway.killSession(sessionId)
        } catch (error) {
            if (!isIgnorableKillSessionError(error)) {
                throw error
            }
            console.warn(`Archive continuing after stale killSession RPC for ${sessionId}: ${(error as Error).message}`)
        }
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
            serviceTier?: CodexServiceTier | null
            effort?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): Promise<void> {
        const result = await this.rpcGateway.requestSessionConfig(sessionId, config)
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as {
            applied?: {
                permissionMode?: Session['permissionMode']
                model?: Session['model']
                modelReasoningEffort?: Session['modelReasoningEffort']
                serviceTier?: Session['serviceTier']
                effort?: Session['effort']
                collaborationMode?: Session['collaborationMode']
            }
        }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error('Missing applied session config')
        }

        assertCodexSessionConfigApplied(config, applied)
        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'claude-deepseek' | 'claude-ark' | 'cc-api' | 'codex' | 'cursor' | 'agy' | 'grok' | 'opencode' | 'hermes-moa' = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: CodexServiceTier,
        spawnRequestId?: string
    ): Promise<RpcSpawnSessionResult> {
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
            permissionMode,
            serviceTier,
            spawnRequestId
        )
    }

    async querySpawnSession(
        machineId: string,
        spawnRequestId: string,
        expectedOptions?: RpcSpawnSessionLookupOptions
    ): Promise<RpcQuerySpawnSessionResult> {
        return await this.rpcGateway.querySpawnSession(machineId, spawnRequestId, expectedOptions)
    }

    async resumeSession(sessionId: string, namespace: string): Promise<ResumeSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        return this.resumeAccessibleSession(access, namespace)
    }

    async takeoverSession(sessionId: string, namespace: string): Promise<TakeoverSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        const metadata = session.metadata
        const sourceExecutionControl = getExecutionControl(metadata)
        const recentMessages = this.getMessagesPage(access.sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
        }).messages
        const isDesktopMirror = isCodexDesktopMirrorSession({ metadata, messages: recentMessages })

        if (!isDesktopMirror) {
            return session.active ? { type: 'success', sessionId: access.sessionId } : await this.resumeAccessibleSession(access, namespace)
        }
        if (session.active && sourceExecutionControl?.owner === 'hapi-runner') {
            return { type: 'success', sessionId: access.sessionId }
        }
        if (session.thinking) {
            return { type: 'error', message: 'Desktop session is still running', code: 'takeover_busy' }
        }

        const resumed = await this.resumeAccessibleSession(access, namespace, { allowActiveSession: true })
        if (resumed.type === 'error') {
            return resumed
        }

        const canonical = this.getSession(resumed.sessionId)
        if (canonical && getExecutionControl(canonical.metadata)?.owner !== 'hapi-runner') {
            const patchResult = await this.patchRunnerOwnership(
                resumed.sessionId,
                namespace,
                resumed.sessionId,
                sourceExecutionControl
            )
            if (patchResult.type === 'error') {
                return patchResult
            }
        }

        return resumed
    }

    private async patchRunnerOwnership(
        sessionId: string,
        namespace: string,
        runnerSessionId: string,
        sourceExecutionControl?: ReturnType<typeof getExecutionControl>
    ): Promise<{ type: 'success' } | { type: 'error'; message: string; code: 'resume_failed' }> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await this.sessionCache.patchSessionMetadata(sessionId, namespace, (current) => ({
                    ...current,
                    mirrorSource: 'codex-desktop-sync',
                    executionControl: acquireRunnerControl(
                        sourceExecutionControl ?? getExecutionControl(current),
                        runnerSessionId,
                        Date.now(),
                        15 * 60_000
                    )
                }))
                return { type: 'success' }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to update session metadata'
                if (message === 'Session was modified concurrently. Please try again.' && attempt === 0) {
                    this.sessionCache.refreshSession(sessionId)
                    continue
                }
                return { type: 'error', message, code: 'resume_failed' }
            }
        }

        return { type: 'error', message: 'Failed to update session metadata', code: 'resume_failed' }
    }

    private async resumeAccessibleSession(
        access: { ok: true; sessionId: string; session: Session },
        namespace: string,
        options?: { allowActiveSession?: boolean }
    ): Promise<ResumeSessionResult> {
        if (access.session.active && !options?.allowActiveSession) {
            return { type: 'success', sessionId: access.sessionId }
        }

        try {
            const canonicalSessionId = await this.managedSessionOutcomes.resumeCanonical(namespace, access.sessionId, async (spawnRequestId, context) => {
                const result = await this.performResumeAccessibleSession(
                    access,
                    namespace,
                    spawnRequestId,
                    context,
                    options
                )
                if (result.type === 'error') {
                    throw new ResumeSessionError({
                        type: 'error',
                        message: result.message,
                        code: result.code
                    }, result.preserveSpawnRequest === true)
                }
                return result.sessionId
            })
            return { type: 'success', sessionId: canonicalSessionId }
        } catch (error) {
            if (error instanceof ResumeSessionError) return error.result
            return { type: 'error', message: error instanceof Error ? error.message : 'Failed to resume session', code: 'resume_failed' }
        }
    }

    private async performResumeAccessibleSession(
        access: { ok: true; sessionId: string; session: Session },
        namespace: string,
        spawnRequestId: string,
        context: ManagedResumeContext,
        options?: { allowActiveSession?: boolean }
    ): Promise<ResumeAttemptResult> {
        const session = access.session
        const metadata = session.metadata
        let operation: ManagedResumeOperation
        let targetMachine: Machine | undefined

        if (context.resumeOperation) {
            operation = context.resumeOperation
            targetMachine = this.machineCache.getOnlineMachinesByNamespace(namespace)
                .find((machine) => machine.id === operation.machineId)
            if (!targetMachine) {
                return {
                    type: 'error',
                    message: 'Original resume machine is not online',
                    code: 'no_machine_online',
                    preserveSpawnRequest: true
                }
            }
        } else {
            if (!metadata || typeof metadata.path !== 'string') {
                return {
                    type: 'error',
                    message: 'Session metadata missing path',
                    code: 'resume_unavailable',
                    preserveSpawnRequest: context.reusedSpawnRequestId
                }
            }

            const flavor = metadata.flavor === 'codex' || metadata.flavor === 'agy' || metadata.flavor === 'grok' || metadata.flavor === 'opencode' || metadata.flavor === 'cursor' || metadata.flavor === 'claude-deepseek' || metadata.flavor === 'claude-ark' || metadata.flavor === 'cc-api' || metadata.flavor === 'hermes-moa'
                ? metadata.flavor
                : 'claude'
            const resumeToken = (() => {
                switch (flavor) {
                    case 'codex': return metadata.codexSessionId
                    case 'agy': return metadata.agySessionId
                    case 'grok': return metadata.grokSessionId
                    case 'opencode': return metadata.opencodeSessionId
                    case 'cursor': return metadata.cursorSessionId
                    case 'hermes-moa': return metadata.hermesSessionId
                    default: return metadata.claudeSessionId
                }
            })()

            if (!resumeToken) {
                return {
                    type: 'error',
                    message: 'Resume session ID unavailable',
                    code: 'resume_unavailable',
                    preserveSpawnRequest: context.reusedSpawnRequestId
                }
            }

            const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
            if (onlineMachines.length === 0) {
                return {
                    type: 'error',
                    message: 'No machine online',
                    code: 'no_machine_online',
                    preserveSpawnRequest: context.reusedSpawnRequestId
                }
            }

            targetMachine = (() => {
                if (metadata.machineId) {
                    const exact = onlineMachines.find((machine) => machine.id === metadata.machineId)
                    if (exact) return exact
                }
                if (metadata.host) {
                    return onlineMachines.find((machine) => machine.metadata?.host === metadata.host)
                }
                return undefined
            })()
            if (!targetMachine) {
                return {
                    type: 'error',
                    message: 'No machine online',
                    code: 'no_machine_online',
                    preserveSpawnRequest: context.reusedSpawnRequestId
                }
            }

            const resumeEffort = (
                (flavor === 'cc-api' && !isCcApiEffortAllowedForModel(
                    session.model,
                    session.effort,
                    { allowUnlistedModel: true }
                ))
                || (flavor === 'claude-deepseek' && !isClaudeDeepSeekEffortAllowedForModel(session.model, session.effort))
            )
                ? undefined
                : session.effort ?? undefined
            operation = {
                version: 1,
                machineId: targetMachine.id,
                spawnOptions: {
                    directory: metadata.path,
                    agent: flavor,
                    ...(session.model != null ? { model: session.model } : {}),
                    ...(session.modelReasoningEffort != null ? { modelReasoningEffort: session.modelReasoningEffort } : {}),
                    yolo: false,
                    sessionType: 'simple',
                    resumeSessionId: resumeToken,
                    ...(resumeEffort !== undefined ? { effort: resumeEffort } : {}),
                    ...(session.permissionMode != null ? { permissionMode: session.permissionMode } : {}),
                    ...(session.serviceTier != null ? { serviceTier: session.serviceTier } : {})
                }
            }
        }

        const expectedSpawnOptions: RpcSpawnSessionLookupOptions = operation.spawnOptions
        const flavor = operation.spawnOptions.agent
        let spawnResult: RpcQuerySpawnSessionResult | null = context.reusedSpawnRequestId
            ? await this.rpcGateway.querySpawnSession(operation.machineId, spawnRequestId, expectedSpawnOptions)
            : null
        const readinessIssue = getProviderSelectionIssue(
            targetMachine.metadata?.providerReadiness,
            flavor,
            {
                model: flavor === 'opencode' ? undefined : operation.spawnOptions.model,
                effort: flavor === 'codex'
                    ? operation.spawnOptions.modelReasoningEffort
                    : operation.spawnOptions.effort,
                mode: operation.spawnOptions.permissionMode,
                yolo: operation.spawnOptions.yolo,
                resume: true
            }
        )
        if ((spawnResult === null || spawnResult.type === 'not_found') && readinessIssue) {
            return {
                type: 'error',
                message: readinessIssue.recoveryCommand
                    ? `${readinessIssue.message} Run: ${readinessIssue.recoveryCommand}`
                    : readinessIssue.message,
                code: 'resume_unavailable',
                preserveSpawnRequest: context.reusedSpawnRequestId
            }
        }

        if ((spawnResult === null || spawnResult.type === 'not_found') && context.resumeOperation === null) {
            operation = context.bindResumeOperation(operation)
        }
        const submitResume = async (): Promise<RpcSpawnSessionResult> => {
            const spawnOptions = operation.spawnOptions
            return await this.rpcGateway.spawnSession(
                operation.machineId,
                spawnOptions.directory,
                spawnOptions.agent,
                spawnOptions.model,
                spawnOptions.modelReasoningEffort,
                spawnOptions.yolo,
                spawnOptions.sessionType,
                spawnOptions.worktreeName,
                spawnOptions.resumeSessionId,
                spawnOptions.effort,
                spawnOptions.permissionMode,
                spawnOptions.serviceTier,
                spawnRequestId
            )
        }
        if (spawnResult === null || spawnResult.type === 'not_found') {
            spawnResult = await submitResume()
        }

        if (spawnResult.type === 'pending') {
            const deadline = Date.now() + 60_000
            while ((spawnResult.type === 'pending' || spawnResult.type === 'not_found') && Date.now() < deadline) {
                if (spawnResult.type === 'not_found') {
                    spawnResult = await submitResume()
                } else {
                    await new Promise((resolve) => setTimeout(resolve, 500))
                    spawnResult = await this.rpcGateway.querySpawnSession(
                        operation.machineId,
                        spawnResult.spawnRequestId,
                        expectedSpawnOptions
                    )
                }
            }
        }

        if (spawnResult.type === 'pending' || spawnResult.type === 'not_found') {
            return {
                type: 'error',
                message: `Session startup is still pending (${spawnResult.spawnRequestId})`,
                code: 'resume_failed',
                preserveSpawnRequest: true
            }
        }
        if (spawnResult.type === 'conflict') {
            return {
                type: 'error',
                message: spawnResult.message,
                code: 'resume_failed',
                preserveSpawnRequest: true
            }
        }
        if (spawnResult.type === 'error') {
            return {
                type: 'error',
                message: spawnResult.recoveryCommand
                    ? `${spawnResult.message} Run: ${spawnResult.recoveryCommand}`
                    : spawnResult.message,
                code: spawnResult.code ? 'resume_unavailable' : 'resume_failed'
            }
        }

        let becameActive: boolean
        try {
            becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        } catch (error) {
            return {
                type: 'error',
                message: error instanceof Error ? error.message : 'Failed while waiting for resumed session',
                code: 'resume_failed',
                preserveSpawnRequest: true
            }
        }
        if (!becameActive) {
            return {
                type: 'error',
                message: 'Session failed to become active',
                code: 'resume_failed',
                preserveSpawnRequest: true
            }
        }

        if (metadata?.mirrorSource === 'codex-desktop-sync' && spawnResult.sessionId !== access.sessionId) {
            const sourceSession = this.sessionCache.getSessionByNamespace(access.sessionId, namespace)
            if (sourceSession) {
                const controlResult = await this.patchRunnerOwnership(
                    access.sessionId,
                    namespace,
                    spawnResult.sessionId
                )
                if (controlResult.type === 'error') {
                    return { ...controlResult, preserveSpawnRequest: true }
                }
            }
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
                    return { type: 'error', message, code: 'resume_failed', preserveSpawnRequest: true }
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
            && (prev?.agySessionId ?? null) === (next.agySessionId ?? null)
            && (prev?.grokSessionId ?? null) === (next.grokSessionId ?? null)
            && (prev?.opencodeSessionId ?? null) === (next.opencodeSessionId ?? null)
            && (prev?.cursorSessionId ?? null) === (next.cursorSessionId ?? null)
            && (prev?.hermesSessionId ?? null) === (next.hermesSessionId ?? null)
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


    async listMentions(machineId: string, agent: string): Promise<{
        success: boolean
        mentions?: Array<{
            name: string
            label: string
            insertText: string
            description?: string
            kind: 'app' | 'plugin'
            pluginName: string
        }>
        error?: string
    }> {
        return await this.rpcGateway.listMentions(machineId, agent)
    }

    async listSkills(sessionId: string, agent: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.rpcGateway.listSkills(sessionId, agent)
    }
}
