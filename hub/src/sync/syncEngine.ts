/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import { isKnownFlavor, type LocalResumeTarget, type ResumableSession } from '@hapi/protocol'
import type { CursorChatStoreStatus, CursorMigrateOutcome, CursorMigrateToAcpRequest, QueuedStateResponse, SlashCommandsResponse } from '@hapi/protocol/apiTypes'
import type { AgentFlavor, CodexCollaborationMode, DecryptedMessage, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Server } from 'socket.io'
import type { Store, CancelQueuedMessageResult } from '../store'
import type { HapiSessionExportResult } from '@hapi/protocol/sessionExport'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { CursorLegacyMigrator, type CursorLegacyMigratorOptions } from '../cursor/cursorLegacyMigrator'

import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import {
    RpcGateway,
    RpcTargetMissingError,
    type RpcCodexModel,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcGeneratedImageResponse,
    type RpcListDirectoryResponse,
    type RpcListCodexModelsResponse,
    type RpcArchiveCodexSessionResponse,
    type RpcListCursorModelsResponse,
    type RpcListOpencodeModelsResponse,
    type RpcListGrokModelsResponse,
    type RpcListGrokReasoningEffortOptionsResponse,
    type RpcListOpencodeReasoningEffortOptionsResponse,
    type RpcCursorModel,
    type RpcCursorChatStoreStatus,
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
    RpcGeneratedImageResponse,
    RpcListDirectoryResponse,
    RpcListCodexModelsResponse,
    RpcListCursorModelsResponse,
    RpcListOpencodeModelsResponse,
    RpcListGrokModelsResponse,
    RpcListGrokReasoningEffortOptionsResponse,
    RpcListOpencodeReasoningEffortOptionsResponse,
    RpcCursorModel,
    RpcCursorChatStoreStatus,
    RpcOpencodeModel,
    RpcPathExistsResponse,
    RpcReadFileResponse,
    RpcUploadFileResponse
} from './rpcGateway'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

export type ReopenSessionResult =
    | { type: 'success'; sessionId: string; resumed: boolean; cursorSessionProtocol?: 'acp' | 'stream-json' }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' | 'metadata_conflict' }
    | { type: 'incomplete'; message: string; missing: [string, ...string[]] }

export type LocalResumeTargetResult =
    | { type: 'success'; target: LocalResumeTarget }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'resume_unavailable' }

export type LocalHandoffResult =
    | { type: 'success' }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'already_local' | 'handoff_failed' }

export type CursorChatStoreStatusResult =
    | { type: 'success'; status: CursorChatStoreStatus }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'resume_unavailable' | 'no_machine_online' | 'probe_failed' }

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function normalizeUserMessageText(value: string): string | undefined {
    const text = value.trim().replace(/\s+/g, ' ')
    return text.length > 0 ? text : undefined
}

function extractUserMessageText(content: unknown): string | undefined {
    if (typeof content === 'string') {
        return normalizeUserMessageText(content)
    }

    if (Array.isArray(content)) {
        const parts = content
            .map((block) => {
                const record = asRecord(block)
                return record?.type === 'text' && typeof record.text === 'string'
                    ? record.text
                    : null
            })
            .filter((text): text is string => text !== null)
        return normalizeUserMessageText(parts.join(' '))
    }

    const record = asRecord(content)
    if (record?.type === 'text' && typeof record.text === 'string') {
        return normalizeUserMessageText(record.text)
    }

    return undefined
}

function extractClaudeUserMessageTextFromAgentOutput(content: unknown): string | undefined {
    const record = asRecord(content)
    if (record?.type !== 'output') return undefined

    const data = asRecord(record.data)
    if (data?.type !== 'user') return undefined

    const message = asRecord(data.message)
    if (message?.role !== 'user') return undefined

    return extractUserMessageText(message.content)
}

export class SyncEngine {
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private inactivityTimer: NodeJS.Timeout | null = null
    /** Sessions that emitted `session-ready` (Cursor ACP load/newSession complete). */
    private readonly sessionReadyIds = new Set<string>()

    constructor(
        private readonly store: Store,
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

    private resolveOnlineMachineForSession(
        session: Session,
        namespace: string,
        options?: { strictMachineId?: boolean }
    ): Machine | null {
        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (session.metadata?.machineId) {
            const exact = onlineMachines.find((machine) => machine.id === session.metadata?.machineId)
            if (exact) return exact
            if (options?.strictMachineId) return null
        }
        if (session.metadata?.host) {
            const hostMatch = onlineMachines.find((machine) => machine.metadata?.host === session.metadata?.host)
            if (hostMatch) return hostMatch
        }
        return null
    }

    async getCursorChatStoreStatus(sessionId: string, namespace: string): Promise<CursorChatStoreStatusResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const metadata = access.session.metadata
        if (metadata?.flavor !== 'cursor' || !metadata.path || !metadata.cursorSessionId) {
            return {
                type: 'error',
                message: 'Cursor resume metadata is unavailable',
                code: 'resume_unavailable'
            }
        }

        const targetMachine = this.resolveOnlineMachineForSession(
            access.session,
            namespace,
            { strictMachineId: true }
        )
        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        try {
            const status = await this.rpcGateway.getCursorChatStoreStatus(
                targetMachine.id,
                metadata.path,
                metadata.cursorSessionId,
                metadata.homeDir
            )
            return { type: 'success', status }
        } catch (error) {
            return {
                type: 'error',
                message: error instanceof Error ? error.message : 'Failed to inspect Cursor chat store',
                code: 'probe_failed'
            }
        }
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.sessionCache.getSessionsByNamespace(namespace)
    }

    getFutureScheduledMessageCounts(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return this.store.messages.countFutureScheduledBySessionIds(sessionIds, now)
    }

    getNextScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Map<string, number> {
        return this.store.messages.minFutureScheduledAtBySessionIds(sessionIds, now)
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

    getMessagesPage(
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
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getQueuedState(sessionId: string, localIds: string[]): QueuedStateResponse {
        return this.messageService.getQueuedState(sessionId, localIds)
    }

    getSessionExport(sessionId: string, session: Session): HapiSessionExportResult {
        return this.messageService.getSessionExport(sessionId, session)
    }

    getDeliverableMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number; now: number }): DecryptedMessage[] {
        return this.messageService.getDeliverableMessagesAfter(sessionId, options)
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            // Snapshot agent session IDs before refresh — safe because JS is single-threaded
            // and refreshSession replaces the Map entry with a new object.
            const before = this.sessionCache.getSession(event.sessionId)
            this.sessionCache.refreshSession(event.sessionId)
            const after = this.sessionCache.getSession(event.sessionId)
            if (after?.metadata && !this.hasSameAgentSessionIds(before?.metadata ?? null, after.metadata)) {
                if (!this.canRunCursorDedup(after)) {
                    return
                }
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
        serviceTier?: string | null
        collaborationMode?: CodexCollaborationMode
    }): void {
        this.sessionCache.handleSessionAlive(payload)
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleSessionReady(payload: { sid: string; time: number }): void {
        this.sessionReadyIds.add(payload.sid)
        this.triggerDedupIfNeeded(payload.sid)
    }

    clearQueuedThinkingGrace(sessionId: string): void {
        this.sessionCache.clearQueuedThinkingGrace(sessionId)
    }

    handleSessionEnd(payload: { sid: string; time: number; reason?: 'completed' | 'terminated' | 'error' }): void {
        const before = this.sessionCache.getSession(payload.sid)
        const isCursorAcp = before?.metadata?.flavor === 'cursor'
            && before.metadata.cursorSessionProtocol === 'acp'
        const shouldRetryDedup = !isCursorAcp || this.sessionReadyIds.has(payload.sid)

        this.sessionCache.handleSessionEnd(payload)
        this.eventPublisher.emit({
            type: 'session-ended',
            sessionId: payload.sid,
            reason: payload.reason
        })
        // Retry dedup now that this session is inactive — a prior dedup may have
        // skipped it because it was still active at the time. Cursor ACP rows that
        // never reached session-ready must not dedup-merge the original on failure.
        if (shouldRetryDedup) {
            this.triggerDedupIfNeeded(payload.sid)
        }
        this.sessionReadyIds.delete(payload.sid)
    }

    handleBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        this.sessionCache.applyBackgroundTaskDelta(sessionId, delta)
    }

    recordSessionActivity(sessionId: string, updatedAt: number): void {
        this.sessionCache.recordSessionActivity(sessionId, updatedAt)
    }

    handleMachineAlive(payload: { machineId: string; time: number; health?: unknown }): void {
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
        // Piggybacked on the inactivity tick; not a logical part of expireInactive
        // but shares its 5s cadence (avoids a second timer).
        this.messageService.releaseMatureScheduledMessages(Date.now())
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
        requestedId?: string
    ): Session {
        return this.sessionCache.getOrCreateSession(
            tag,
            metadata,
            agentState,
            namespace,
            model,
            effort,
            modelReasoningEffort,
            requestedId
        )
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
            scheduledAt?: number | null
        }
    ): Promise<void> {
        await this.messageService.sendMessage(sessionId, payload)
        this.sessionCache.markMessageQueued(sessionId)
        this.sessionCache.recordSessionActivity(sessionId, Date.now())
    }

    async cancelQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<CancelQueuedMessageResult> {
        return this.messageService.cancelQueuedMessage(sessionId, messageId)
    }

    sweepImmediateQueuedOnSessionEnd(sessionId: string, invokedAt: number): void {
        this.messageService.sweepImmediateQueuedOnSessionEnd(sessionId, invokedAt)
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
        // tiann/hapi#916: when the CLI is already gone (e.g. after a
        // hub-restart cascade SIGTERMed the runner but the in-memory
        // `active` flag has not been reconciled yet) the kill-RPC throws
        // and the route used to surface that as HTTP 500. Treat the
        // missing target as a benign condition: still flip the session's
        // lifecycleState to `archived` in the hub-side metadata so the
        // UI does not see a half-cleaned zombie, and continue to mark
        // it inactive in the cache. Real RPC errors (timeout, protocol
        // failure) still propagate as 5xx.
        try {
            await this.rpcGateway.killSession(sessionId)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                this.sessionCache.markSessionArchivedFromHub(sessionId, 'Archived from hub (CLI unreachable)')
            } else {
                throw error
            }
        }
        this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }

    /**
     * Apply the post-migration metadata flip in hapi.db:
     *   - metadata.cursorSessionProtocol = 'acp'
     *   - session.model = lastUsedModel (if provided)
     *
     * Returns 'success' on a clean write, 'version-mismatch' if the metadata
     * version moved underneath us (caller retries) or 'not-found' if the row
     * is gone.
     *
     * Used by CursorLegacyMigrator after the on-disk transplant + verify
     * succeeds. Kept on the engine (not on the migrator) so that all hapi.db
     * writes funnel through the existing cache-refresh path.
     */
    flipCursorSessionProtocolToAcp(
        sessionId: string,
        namespace: string,
        lastUsedModel: string | null
    ): { result: 'success' | 'version-mismatch' | 'not-found' | 'session-active' } {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) {
                return { result: 'not-found' }
            }
            // Combined SSE-event payload contract (UX A++): clear the
            // `cursorMigrationState='in_progress'` flag in the SAME metadata
            // write that flips `cursorSessionProtocol` to 'acp'. The web
            // banner keys off `cursorMigrationState`, so a single SSE
            // session-updated event swaps both atomically — banner gone,
            // protocol flipped — preventing a flicker window where the
            // banner has already disappeared but the chat hasn't re-rendered
            // to the ACP transport yet.
            const carriedMigrationState = latest.metadata.cursorMigrationState
            // Atomic active-check inside the same synchronous flip op so
            // that a resume cannot land between the migrator's recheck
            // and the actual DB update. Bun is single-threaded — once
            // we've read `latest` and the row is inactive, no other JS
            // can mutate active=true until this method returns. Codex
            // review #34 P1 v2: the migrator's recheck is best-effort;
            // this is the authoritative gate.
            //
            // Codex review #34 P2 v5: only block on `active === true`,
            // NOT on lifecycleState === 'running'. After a force-archive
            // flow archiveSession() synchronously sets active=false but
            // the cleanup metadata write that flips lifecycleState
            // 'running' → 'archived' may still be in-flight, and that
            // is OUR archive completing, not a resume race. The active
            // flag is the authoritative live-runner signal.
            if (latest.active === true) {
                return { result: 'session-active' }
            }
            // Codex review #34 P2 v7: ALSO clear a stale lifecycleState
            // value if it still says 'running'. The migrator now skips
            // archiveSession() for stale-running rows (active=false but
            // lifecycle=running with --force-archive-running) because
            // there's no live runner to archive. Without this fixup,
            // successfully migrated stale rows would retain lifecycle=
            // running forever and any downstream code that filters by
            // lifecycleState (not the cache active flag) would keep
            // treating archived ACP sessions as live.
            const oldLifecycle = typeof latest.metadata.lifecycleState === 'string' ? latest.metadata.lifecycleState : undefined
            const nextMetadata: typeof latest.metadata = {
                ...latest.metadata,
                cursorSessionProtocol: 'acp' as const,
                ...(oldLifecycle === 'running' ? { lifecycleState: 'archived' as const } : {})
            }
            // Drop the migration-in-progress flag in the same write (see
            // header comment). Safe whether or not it was set.
            if (carriedMigrationState !== undefined) {
                delete nextMetadata.cursorMigrationState
            }
            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                nextMetadata,
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'version-mismatch') {
                this.sessionCache.refreshSession(sessionId)
                continue
            }
            if (result.result !== 'success') {
                return { result: 'not-found' }
            }
            this.sessionCache.refreshSession(sessionId)
            if (lastUsedModel && lastUsedModel.trim().length > 0) {
                this.store.sessions.setSessionModel(sessionId, lastUsedModel.trim(), namespace, { touchUpdatedAt: false })
                this.sessionCache.refreshSession(sessionId)
            }
            return { result: 'success' }
        }
        return { result: 'version-mismatch' }
    }

    /**
     * Migrate a single legacy cursor session to ACP. Hub-side; runs on the
     * operator's machine (the hub host); see tiann/hapi#824 design.
     * Returns a structured outcome (ok or refusal); does not throw.
     */
    async migrateLegacyCursorSession(
        sessionId: string,
        namespace: string,
        request: CursorMigrateToAcpRequest
    ): Promise<CursorMigrateOutcome> {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            ?? this.sessionCache.refreshSession(sessionId)
        if (!session) {
            return { ok: false, sessionId, reason: 'internal_error', message: 'session not found in namespace', durationMs: 0 }
        }
        const migrator = this.buildMigratorForRequest(request)
        return migrator.migrateOne(session, {
            keepSource: request.keepSource,
            forceArchiveRunning: request.forceArchiveRunning,
            skipVerify: request.skipVerify
        })
    }

    private buildMigratorForRequest(_request: CursorMigrateToAcpRequest): CursorLegacyMigrator {
        const migratorOpts: CursorLegacyMigratorOptions = {}
        return new CursorLegacyMigrator(migratorOpts, {
            archiveSession: async (sessionId) => {
                await this.archiveSession(sessionId)
            },
            // NOTE: no awaitSessionInactive injection — handleSessionEnd()
            // synchronously sets cache.active=false inside archiveSession,
            // so any cache-based poll would return immediately and provide
            // false reassurance. The migrator now relies on
            // awaitLockRelease's minimum-dwell + SQLite busy-probe +
            // size-stability combination instead. Codex review #34 P1 v3.
            getCurrentSession: (sessionId, namespace) => {
                const s = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                if (!s) return null
                return {
                    active: s.active === true,
                    lifecycleState: typeof s.metadata?.lifecycleState === 'string' ? s.metadata.lifecycleState : undefined,
                    cursorSessionProtocol: typeof s.metadata?.cursorSessionProtocol === 'string' ? s.metadata.cursorSessionProtocol : undefined
                }
            },
            updateSessionAfterMigrate: (sessionId, namespace, lastUsedModel) => {
                const result = this.flipCursorSessionProtocolToAcp(sessionId, namespace, lastUsedModel)
                if (result.result === 'success') return { ok: true }
                if (result.result === 'session-active') return { ok: false, reason: 'session_active' as const }
                return { ok: false, reason: 'version_mismatch_or_missing' as const }
            },
            // tiann/hapi#872: size sanity check needs to compare HAPI's known
            // message history against the candidate legacy store's blob
            // count. The store-handle stays on the engine; we only thread
            // the count through so the migrator stays free of a direct
            // hub.Store dependency.
            getHapiMessageCount: (sessionId, _namespace) => {
                try {
                    return this.store.messages.countMessages(sessionId)
                } catch (err) {
                    // tiann/hapi#873 cold review: a silent 0 here trips
                    // the migrator's "skip sanity" branch and chronically
                    // disables the floor. Warn so a broken countMessages
                    // (lock contention pattern, schema drift) is visible
                    // in journalctl.
                    console.warn('[auto-migrate] countMessages threw; size sanity skipped', {
                        sessionId,
                        err: err instanceof Error ? err.message : String(err)
                    })
                    return 0
                }
            }
        })
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
            model?: { provider: string; modelId: string } | string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            serviceTier?: string | null
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

        const result = await this.rpcGateway.requestSessionConfig(sessionId, config) as Record<string, unknown>
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as {
            error?: string
            applied?: {
                permissionMode?: Session['permissionMode']
                model?: Session['model']
                modelReasoningEffort?: Session['modelReasoningEffort']
                effort?: Session['effort']
                serviceTier?: Session['serviceTier']
                collaborationMode?: Session['collaborationMode']
            }
        }
        if (typeof obj.error === 'string' && obj.error.trim().length > 0) {
            throw new Error(obj.error)
        }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error(`Missing applied session config, got: ${JSON.stringify(result)}`)
        }

        const requestedKeys = Object.keys(config) as Array<keyof typeof config>
        for (const key of requestedKeys) {
            if (!(key in applied)) {
                throw new Error(`Session did not apply ${key}`)
            }
        }

        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: AgentFlavor = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: string,
        existingSessionId?: string
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
            permissionMode,
            serviceTier,
            existingSessionId
        )
    }

    private resolveFlavor(session: Session): AgentFlavor {
        const flavor = session.metadata?.flavor
        return isKnownFlavor(flavor) ? flavor : 'claude'
    }

    private resolveAgentResumeId(session: Session, namespace: string): string | null {
        const metadata = session.metadata
        if (!metadata) {
            return null
        }

        const flavor = this.resolveFlavor(session)
        if (flavor === 'codex') return metadata.codexSessionId ?? null
        if (flavor === 'gemini') return metadata.geminiSessionId ?? null
        if (flavor === 'opencode') return metadata.opencodeSessionId ?? null
        if (flavor === 'grok') return metadata.grokSessionId ?? null
        if (flavor === 'cursor') return metadata.cursorSessionId ?? null
        if (flavor === 'kimi') return metadata.kimiSessionId ?? null
        if (flavor === 'pi') return metadata.piSessionId ?? null

        return metadata.claudeSessionId ?? this.recoverClaudeSessionIdFromMessages(session.id, namespace)
    }

    resolveLocalResumeTarget(sessionId: string, namespace: string): LocalResumeTargetResult {
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
        if (!metadata || typeof metadata.path !== 'string' || metadata.path.length === 0) {
            return { type: 'error', message: 'Session metadata missing path', code: 'resume_unavailable' }
        }

        const agentSessionId = this.resolveAgentResumeId(session, namespace)
        if (!agentSessionId) {
            return {
                type: 'error',
                message: 'Resume session ID unavailable. Start a new session in this directory, or retry after the agent has initialized.',
                code: 'resume_unavailable'
            }
        }

        return {
            type: 'success',
            target: {
                sessionId: access.sessionId,
                flavor: this.resolveFlavor(session),
                directory: metadata.path,
                machineId: metadata.machineId,
                host: metadata.host,
                active: session.active,
                thinking: session.thinking,
                controlledByUser: session.agentState?.controlledByUser === true,
                agentSessionId,
                model: session.model ?? null,
                effort: session.effort ?? null,
                modelReasoningEffort: session.modelReasoningEffort ?? null,
                permissionMode: session.permissionMode,
                collaborationMode: session.collaborationMode
            }
        }
    }

    listLocalResumableSessions(namespace: string, opts?: { machineId?: string }): ResumableSession[] {
        return this.getSessionsByNamespace(namespace)
            .map((session) => this.resolveLocalResumeTarget(session.id, namespace))
            .filter((result): result is { type: 'success'; target: LocalResumeTarget } => result.type === 'success')
            .map(({ target }) => {
                const session = this.getSessionByNamespace(target.sessionId, namespace)
                return {
                    sessionId: target.sessionId,
                    flavor: target.flavor,
                    directory: target.directory,
                    machineId: target.machineId,
                    host: target.host,
                    active: target.active,
                    thinking: target.thinking,
                    controlledByUser: target.controlledByUser,
                    agentSessionId: target.agentSessionId,
                    model: target.model,
                    effort: target.effort,
                    modelReasoningEffort: target.modelReasoningEffort,
                    permissionMode: target.permissionMode,
                    collaborationMode: target.collaborationMode,
                    updatedAt: session?.updatedAt ?? 0,
                    name: session?.metadata?.name,
                    summary: session?.metadata?.summary?.text,
                    firstUserMessage: this.resolveFirstUserMessage(target.sessionId)
                }
            })
            .filter((session) => !opts?.machineId || session.machineId === opts.machineId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    private resolveFirstUserMessage(sessionId: string): string | undefined {
        for (const message of this.store.messages.getFirstMessages(sessionId, 50)) {
            const roleWrapped = unwrapRoleWrappedRecordEnvelope(message.content)
            const text = roleWrapped?.role === 'user'
                ? extractUserMessageText(roleWrapped.content)
                : roleWrapped?.role === 'agent'
                    ? extractClaudeUserMessageTextFromAgentOutput(roleWrapped.content)
                    : undefined
            if (text) return text
        }

        return undefined
    }

    /**
     * tiann/hapi#824 — sync-on-open auto-migration. Returns the (possibly
     * refreshed-from-cache) session. If the session is a legacy stream-json
     * Cursor session AND the env flag is on, attempts a transplant migration
     * synchronously before the caller spawns the runner.
     *
     * The migrator's verify probe runs in an isolated HAPI_HOME (see
     * verifyInTempHome), so this method is safe to call even when other ACP
     * transports are alive on the host: per tiann/hapi#832, two `agent acp`
     * processes coexist on the same host without conflict, and swear01's
     * tiann/hapi#835 refactors the agent-acp-active lock into a cross-process
     * refcount that explicitly supports this. We rely on #835 landing before
     * this PR — see manifest layer ordering and the dependency note in
     * PR #34's body.
     *
     * Failure modes are all soft — the session is returned unchanged and the
     * caller proceeds with the legacy launcher.
     */
    private async maybeAutoMigrateLegacyCursorSession(session: Session, namespace: string): Promise<Session> {
        const md = session.metadata
        const flagRaw = process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE?.trim().toLowerCase() ?? ''
        console.info('[auto-migrate] considering', {
            sessionId: session.id,
            flavor: md?.flavor ?? null,
            proto: md?.cursorSessionProtocol ?? null,
            hasCursorId: typeof md?.cursorSessionId === 'string' && md.cursorSessionId.length > 0,
            envFlag: flagRaw === '' ? '(unset; default on)' : flagRaw
        })

        if (flagRaw === '0' || flagRaw === 'false' || flagRaw === 'no' || flagRaw === 'off') {
            console.info('[auto-migrate] skipped: env flag disabled', { sessionId: session.id })
            return session
        }
        if (!md || md.flavor !== 'cursor') {
            console.info('[auto-migrate] skipped: not a cursor session', { sessionId: session.id, flavor: md?.flavor ?? null })
            return session
        }
        if (md.cursorSessionProtocol === 'acp') {
            console.info('[auto-migrate] skipped: already ACP', { sessionId: session.id })
            return session
        }
        if (typeof md.cursorSessionId !== 'string' || md.cursorSessionId.length === 0) {
            console.info('[auto-migrate] skipped: no cursorSessionId', { sessionId: session.id })
            return session
        }

        console.info('[auto-migrate] starting transplant', { sessionId: session.id, cursorSessionId: md.cursorSessionId })
        // UX A++: surface the migration to the user via a banner in the
        // web UI. We set `cursorMigrationState='in_progress'` on the row
        // BEFORE the long-running transplant; the sessionCache.refresh()
        // call emits a `session-updated` SSE event the web client uses to
        // render the banner. The flag is cleared on success by the same
        // metadata write that flips cursorSessionProtocol to 'acp' (see
        // flipCursorSessionProtocolToAcp) so the banner disappears in the
        // same render tick the chat re-renders as ACP — no flicker. On
        // failure we clear the flag explicitly in the catch path below.
        const flagSet = this.setCursorMigrationStateInProgress(session.id, namespace)
        let bannerCleanupNeeded = flagSet
        try {
            const migrator = this.buildMigratorForRequest({})
            // Codex #34 P2 (round 13): for inactive rows whose metadata
            // still reads `lifecycleState === 'running'` (e.g. orphaned by
            // a hub crash where the lifecycle transition didn't land), the
            // migrator's preflight refuses with `running_refused` unless
            // `forceArchiveRunning` is true. resumeSession's caller-side
            // guard already ensured `session.active === false` (see the
            // early-return above), so we know there's no runner to yank;
            // the `running` lifecycle is stale metadata, not a live agent.
            // This is exactly the stale-row case the sync-on-open path is
            // meant to clean up — refusing here would defeat the whole
            // point and silently fall back to the legacy launcher forever.
            const outcome = await migrator.migrateOne(session, { forceArchiveRunning: true })
            if (outcome.ok) {
                console.info('[auto-migrate] success', {
                    sessionId: session.id,
                    cursorSessionId: md.cursorSessionId,
                    acpSessionId: outcome.acpSessionId,
                    durationMs: outcome.durationMs,
                    sourceRemoved: outcome.sourceRemoved,
                    replayNotifications: outcome.replayNotifications,
                    lastUsedModelPreserved: outcome.lastUsedModelPreserved
                })
                // Successful migration already cleared the flag atomically
                // in flipCursorSessionProtocolToAcp; skip the cleanup write.
                bannerCleanupNeeded = false
                const refreshed = this.sessionCache.getSessionByNamespace(session.id, namespace)
                if (refreshed) return refreshed
                return session
            }
            // tiann/hapi#872: ambiguous source store OR size-mismatch
            // means the migrator refused to transplant likely-alien
            // content. Surface this to the UI banner instead of silently
            // clearing the in-progress flag, so the operator can act
            // (verify which workspace-hash drawer holds the real history,
            // delete the stale siblings, retry) rather than have us
            // silently fall back to the legacy launcher and pretend the
            // ambiguity never happened.
            if (outcome.reason === 'ambiguous_legacy_store' || outcome.reason === 'size_mismatch') {
                console.warn('[auto-migrate] refusing to transplant; surfacing ambiguous banner', {
                    sessionId: session.id,
                    reason: outcome.reason,
                    message: outcome.message
                })
                const promoted = this.setCursorMigrationStateAmbiguous(session.id, namespace)
                if (promoted) {
                    // We replaced the in-progress flag with the
                    // ambiguous flag; the cleanup write below would
                    // wipe both, so suppress it.
                    bannerCleanupNeeded = false
                } else {
                    // Promotion to 'ambiguous' failed (cache miss, repeated
                    // version-mismatch, or non-version write failure). The
                    // operator-facing warning above already fired; the
                    // finally{} block will fall through to clear the
                    // in-progress flag so the user is not left with a
                    // permanent "Upgrading..." banner. Log so the gap is
                    // diagnosable from journalctl. tiann/hapi#872.
                    console.warn('[auto-migrate] failed to promote cursorMigrationState to "ambiguous"; banner will clear via cleanup', {
                        sessionId: session.id,
                        reason: outcome.reason
                    })
                }
                return session
            }
            // Soft fail — log and let the legacy launcher handle it.
            console.info('[auto-migrate] legacy cursor session left as stream-json', {
                sessionId: session.id,
                reason: outcome.reason,
                message: outcome.message
            })
        } catch (err) {
            console.warn('[auto-migrate] unexpected error; falling back to legacy launcher', {
                sessionId: session.id,
                err: err instanceof Error ? err.message : String(err)
            })
        } finally {
            // Failure or exception path: clear the in-progress banner flag
            // so the user isn't left with a permanent "Upgrading..." banner
            // even though we silently fell back to the legacy launcher.
            if (bannerCleanupNeeded) {
                this.clearCursorMigrationState(session.id, namespace)
            }
        }
        return session
    }

    /**
     * Replace `cursorMigrationState='in_progress'` with `'ambiguous'` so
     * the web banner can switch from "Upgrading..." to "Manual resolution
     * needed". Returns true if the new flag persisted. tiann/hapi#872.
     */
    private setCursorMigrationStateAmbiguous(sessionId: string, namespace: string): boolean {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return false
            if (latest.metadata.cursorMigrationState === 'ambiguous') return true
            const nextMetadata = { ...latest.metadata, cursorMigrationState: 'ambiguous' as const }
            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                nextMetadata,
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return true
            }
            if (result.result === 'version-mismatch') {
                this.sessionCache.refreshSession(sessionId)
                continue
            }
            return false
        }
        return false
    }

    /**
     * Set `metadata.cursorMigrationState='in_progress'` on the session row
     * with a single retry on version-mismatch. Returns true if the flag was
     * persisted (so the caller knows the finally-cleanup is required), false
     * if the write failed entirely — in which case the banner never appeared
     * and there's nothing to clean up. UX A++ helper for the auto-migrate
     * banner; see maybeAutoMigrateLegacyCursorSession.
     */
    private setCursorMigrationStateInProgress(sessionId: string, namespace: string): boolean {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return false
            if (latest.metadata.cursorMigrationState === 'in_progress') return true
            const nextMetadata = { ...latest.metadata, cursorMigrationState: 'in_progress' as const }
            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                nextMetadata,
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return true
            }
            if (result.result === 'version-mismatch') {
                this.sessionCache.refreshSession(sessionId)
                continue
            }
            return false
        }
        return false
    }

    /**
     * Clear `metadata.cursorMigrationState` (failure / exception cleanup).
     * Idempotent; safe to call when the flag was never set. UX A++ helper.
     */
    private clearCursorMigrationState(sessionId: string, namespace: string): void {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return
            if (latest.metadata.cursorMigrationState === undefined) return
            const nextMetadata: typeof latest.metadata = { ...latest.metadata }
            delete nextMetadata.cursorMigrationState
            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                nextMetadata,
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result === 'version-mismatch') {
                this.sessionCache.refreshSession(sessionId)
                continue
            }
            return
        }
    }

    /** Inactive session with directory path but no agent thread and no prior user turn. */
    private canFreshSpawnNeverStartedSession(session: Session, sessionId: string, namespace: string): boolean {
        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string' || metadata.path.length === 0) {
            return false
        }
        if (this.resolveAgentResumeId(session, namespace)) {
            return false
        }
        return this.store.messages.getFirstMessages(sessionId, 1).length === 0
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

        const initialSession = access.session
        if (initialSession.active) {
            return { type: 'success', sessionId: access.sessionId }
        }

        // tiann/hapi#824 — invisible, automatic, per-session ACP migration on
        // first open. If this is a legacy stream-json Cursor session and we
        // can safely migrate it right now (no other agent acp transport
        // would block the post-migration ACP launcher), run the transplant
        // synchronously before resuming. The user sees the regular session
        // loading state for ~3–5s longer; the session opens as ACP.
        const session = await this.maybeAutoMigrateLegacyCursorSession(initialSession, namespace)

        const targetResult = this.resolveLocalResumeTarget(access.sessionId, namespace)
        let flavor: AgentFlavor
        let resumeToken: string | undefined
        let directory: string

        if (targetResult.type === 'success') {
            flavor = targetResult.target.flavor
            resumeToken = targetResult.target.agentSessionId
            directory = targetResult.target.directory
        } else if (
            targetResult.code === 'resume_unavailable'
            && this.canFreshSpawnNeverStartedSession(session, access.sessionId, namespace)
        ) {
            const metadata = session.metadata!
            flavor = this.resolveFlavor(session)
            resumeToken = undefined
            directory = metadata.path
        } else {
            return targetResult
        }

        const metadata = session.metadata!

        const targetMachine = this.resolveOnlineMachineForSession(
            session,
            namespace,
            { strictMachineId: flavor === 'cursor' }
        )
        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        if (flavor === 'cursor' && resumeToken) {
            try {
                const chatStatus = await this.rpcGateway.getCursorChatStoreStatus(
                    targetMachine.id,
                    directory,
                    resumeToken,
                    metadata.homeDir
                )
                if (!chatStatus.onDisk) {
                    return {
                        type: 'error',
                        message: 'Cursor chat data is no longer available on the recorded machine',
                        code: 'resume_unavailable'
                    }
                }
            } catch (error) {
                return {
                    type: 'error',
                    message: error instanceof Error ? error.message : 'Failed to inspect Cursor chat store',
                    code: 'resume_failed'
                }
            }
        }

        const metadataPermissionMode = session.metadata?.preferredPermissionMode
        const preferredPermissionMode = metadataPermissionMode === 'yolo' && opts?.permissionMode === 'default'
            ? metadataPermissionMode
            : opts?.permissionMode
                ?? session.permissionMode
                ?? metadataPermissionMode
        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            directory,
            flavor,
            session.model ?? undefined,
            session.modelReasoningEffort ?? undefined,
            undefined,
            undefined,
            undefined,
            resumeToken,
            session.effort ?? undefined,
            preferredPermissionMode,
            session.serviceTier ?? undefined,
            access.sessionId
        )

        if (spawnResult.type !== 'success') {
            return { type: 'error', message: spawnResult.message, code: 'resume_failed' }
        }

        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) {
            return { type: 'error', message: 'Session failed to become active', code: 'resume_failed' }
        }

        // permissionMode is passed to spawnSession above; do not call set-session-config here.
        // session-alive can arrive before the CLI registers that RPC handler, which caused resume_failed.

        const needsReadyBeforeMerge = spawnResult.sessionId !== access.sessionId
            && flavor === 'cursor'
            && metadata.cursorSessionProtocol === 'acp'
        if (needsReadyBeforeMerge) {
            const readyResult = await this.waitForSessionReady(spawnResult.sessionId)
            if (readyResult !== 'ready') {
                const message = readyResult === 'ended'
                    ? 'Session ended before Cursor ACP load completed'
                    : 'Session failed to become ready'
                return { type: 'error', message, code: 'resume_failed' }
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
                    return { type: 'error', message, code: 'resume_failed' }
                }
            }
        }

        this.sessionCache.markSessionActive(spawnResult.sessionId)
        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    /**
     * Revive an archived session so the web UI can reach it again.
     *
     * Behaviour:
     * - Active session: idempotent no-op (`resumed: false`).
     * - Non-archived inactive session: forwards to `resumeSession` without touching metadata.
     * - Archived session: validates that the agent has enough metadata to resume (Cursor
     *   sessions require a `cursorSessionId` once they have any messages), clears the
     *   archive metadata (`lifecycleState`, `archivedBy`, `archiveReason`), defaults the
     *   Cursor protocol to `stream-json` for pre-#799 sessions, then forwards to
     *   `resumeSession`. The CLI's `sessionFactory` will re-stamp `lifecycleState='running'`
     *   when it boots, so we do not pre-write that here.
     *
     * Failure rollback: if `resumeSession` fails (no machine online, spawn timeout, etc.)
     * the archive snapshot is restored so the operator can retry without losing
     * `archiveReason`/`archivedBy`/`lifecycleState` and the UI still shows the row as
     * archived rather than a dangling inactive non-archived ghost.
     *
     * Returns `incomplete` (HTTP 422 from the route layer) when the agent metadata
     * needed to resume is missing.
     */
    async reopenSession(sessionId: string, namespace: string): Promise<ReopenSessionResult> {
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

        if (session.active) {
            return { type: 'success', sessionId: access.sessionId, resumed: false }
        }

        const isArchived = metadata?.lifecycleState === 'archived'

        if (isArchived && metadata) {
            if (metadata.flavor === 'cursor' && !metadata.cursorSessionId) {
                const hasMessages = this.store.messages.getFirstMessages(access.sessionId, 1).length > 0
                if (hasMessages) {
                    return {
                        type: 'incomplete',
                        message: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                        missing: ['cursorSessionId']
                    }
                }
            }

            const archiveSnapshot = {
                lifecycleState: metadata.lifecycleState,
                archivedBy: metadata.archivedBy,
                archiveReason: metadata.archiveReason,
                lifecycleStateSince: metadata.lifecycleStateSince
            }

            let applied: { cursorSessionProtocol?: 'acp' | 'stream-json' }
            try {
                applied = await this.sessionCache.clearSessionArchiveMetadata(access.sessionId)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to clear archive metadata'
                return { type: 'error', message, code: 'metadata_conflict' }
            }

            const resumeResult = await this.resumeSession(access.sessionId, namespace)
            if (resumeResult.type === 'error') {
                // Resume failed - put the archive flags back so the row stays archived in the UI
                // and the operator can retry. Best-effort: a concurrent metadata write that
                // succeeded between clear and restore (e.g. an unrelated rename) wins, in
                // which case we surface the original resume error rather than masking it.
                try {
                    await this.sessionCache.restoreSessionArchiveMetadata(access.sessionId, archiveSnapshot)
                } catch {
                    // Swallow restore failures - the resume error is the more important signal.
                }
                return resumeResult
            }

            return {
                type: 'success',
                sessionId: resumeResult.sessionId,
                resumed: true,
                ...(applied.cursorSessionProtocol ? { cursorSessionProtocol: applied.cursorSessionProtocol } : {})
            }
        }

        // Not active and not archived (e.g. brand-new session that has not yet connected,
        // or one that ended without writing archive metadata). Forward to resume so the
        // operator still gets one-click revival.
        const resumeResult = await this.resumeSession(access.sessionId, namespace)
        if (resumeResult.type === 'error') {
            return resumeResult
        }

        return { type: 'success', sessionId: resumeResult.sessionId, resumed: true }
    }

    async handoffSessionToLocal(sessionId: string, namespace: string): Promise<LocalHandoffResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        if (!access.session.active) {
            return { type: 'success' }
        }

        if (access.session.agentState?.controlledByUser === true) {
            return {
                type: 'error',
                message: 'Session is already controlled by a local terminal',
                code: 'already_local'
            }
        }

        try {
            await this.rpcGateway.handoffSessionToLocal(access.sessionId)
        } catch (error) {
            return {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
                code: 'handoff_failed'
            }
        }

        const inactive = await this.waitForSessionInactive(access.sessionId)
        if (!inactive) {
            return {
                type: 'error',
                message: 'Timed out waiting for remote session to hand off',
                code: 'handoff_failed'
            }
        }

        return { type: 'success' }
    }

    private recoverClaudeSessionIdFromMessages(sessionId: string, namespace: string): string | null {
        const messages = this.messageService.getMessages(sessionId, 200)
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const found = this.extractClaudeSessionId(messages[i].content)
            if (!found) continue

            this.persistRecoveredClaudeSessionId(sessionId, namespace, found)
            return found
        }
        return null
    }

    private extractClaudeSessionId(value: unknown): string | null {
        if (!value || typeof value !== 'object') {
            return null
        }

        const obj = value as Record<string, unknown>
        const direct = this.normalizeClaudeSessionId(obj.session_id) ?? this.normalizeClaudeSessionId(obj.sessionId)
        if (direct) {
            return direct
        }

        const content = obj.content
        if (content && typeof content === 'object') {
            const found = this.extractClaudeSessionId(content)
            if (found) return found
        }

        const data = obj.data
        if (data && typeof data === 'object') {
            const found = this.extractClaudeSessionId(data)
            if (found) return found
        }

        return null
    }

    private normalizeClaudeSessionId(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null
        }
        const trimmed = value.trim()
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
            ? trimmed
            : null
    }

    private persistRecoveredClaudeSessionId(sessionId: string, namespace: string, claudeSessionId: string): void {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return
            if (latest.metadata.claudeSessionId === claudeSessionId) return

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                { ...latest.metadata, claudeSessionId },
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result !== 'version-mismatch') {
                return
            }
        }
    }

    private hasSameAgentSessionIds(
        prev: Session['metadata'] | null,
        next: NonNullable<Session['metadata']>
    ): boolean {
        return (prev?.codexSessionId ?? null) === (next.codexSessionId ?? null)
            && (prev?.claudeSessionId ?? null) === (next.claudeSessionId ?? null)
            && (prev?.geminiSessionId ?? null) === (next.geminiSessionId ?? null)
            && (prev?.opencodeSessionId ?? null) === (next.opencodeSessionId ?? null)
            && (prev?.grokSessionId ?? null) === (next.grokSessionId ?? null)
            && (prev?.cursorSessionId ?? null) === (next.cursorSessionId ?? null)
            && (prev?.piSessionId ?? null) === (next.piSessionId ?? null)
            && (prev?.kimiSessionId ?? null) === (next.kimiSessionId ?? null)
    }

    private canRunCursorDedup(session: Session): boolean {
        if (session.metadata?.flavor !== 'cursor') {
            return true
        }
        if (session.metadata?.cursorSessionProtocol !== 'acp') {
            return true
        }
        return this.sessionReadyIds.has(session.id)
    }

    private triggerDedupIfNeeded(sessionId: string): void {
        const session = this.sessionCache.getSession(sessionId)
        if (session?.metadata) {
            if (!this.canRunCursorDedup(session)) {
                return
            }
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

    async waitForSessionReady(sessionId: string, timeoutMs: number = 60_000): Promise<'ready' | 'ended' | 'timeout'> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (this.sessionReadyIds.has(sessionId)) {
                return 'ready'
            }
            const session = this.getSession(sessionId)
            if (!session?.active) {
                return 'ended'
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return 'timeout'
    }

    async waitForSessionInactive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const session = this.getSession(sessionId)
            if (!session?.active) {
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

    async readGeneratedImage(sessionId: string, imageId: string): Promise<RpcGeneratedImageResponse> {
        return await this.rpcGateway.readGeneratedImage(sessionId, imageId)
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

    async listSlashCommands(sessionId: string, agent: string): Promise<SlashCommandsResponse> {
        return await this.rpcGateway.listSlashCommands(sessionId, agent)
    }

    async listSkills(sessionId: string, flavor?: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.rpcGateway.listSkills(sessionId, flavor)
    }

    async listCodexModelsForSession(sessionId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForSession(sessionId)
    }

    async listCodexModelsForMachine(machineId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForMachine(machineId)
    }

    async listCodexSessionsForMachine(machineId: string, cwd?: string | null, sessionIds?: string[]) {
        return await this.rpcGateway.listCodexSessionsForMachine(machineId, cwd, sessionIds)
    }

    async archiveCodexSessionForMachine(machineId: string, sessionId: string): Promise<RpcArchiveCodexSessionResponse> {
        return await this.rpcGateway.archiveCodexSessionForMachine(machineId, sessionId)
    }

    async listCursorModelsForSession(sessionId: string): Promise<RpcListCursorModelsResponse> {
        return await this.rpcGateway.listCursorModelsForSession(sessionId)
    }

    async listCursorModelsForMachine(machineId: string): Promise<RpcListCursorModelsResponse> {
        return await this.rpcGateway.listCursorModelsForMachine(machineId)
    }

    async listOpencodeModelsForSession(sessionId: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForSession(sessionId)
    }

    async listOpencodeModelsForCwd(machineId: string, cwd: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForCwd(machineId, cwd)
    }

    async listGrokModelsForCwd(machineId: string, cwd: string): Promise<RpcListGrokModelsResponse> {
        return await this.rpcGateway.listGrokModelsForCwd(machineId, cwd)
    }

    async listGrokModelsForSession(sessionId: string): Promise<RpcListGrokModelsResponse> {
        return await this.rpcGateway.listGrokModelsForSession(sessionId)
    }

    async listGrokReasoningEffortOptionsForSession(sessionId: string): Promise<RpcListGrokReasoningEffortOptionsResponse> {
        return await this.rpcGateway.listGrokReasoningEffortOptionsForSession(sessionId)
    }

    /** Generic Pi RPC — delegates to rpcGateway.callPiRpc. */
    async callPiRpc<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
        return await this.rpcGateway.callPiRpc<T>(sessionId, method, params, timeoutMs)
    }

    async listOpencodeReasoningEffortOptionsForSession(sessionId: string): Promise<RpcListOpencodeReasoningEffortOptionsResponse> {
        return await this.rpcGateway.listOpencodeReasoningEffortOptionsForSession(sessionId)
    }
}
