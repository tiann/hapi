/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import { isKnownFlavor, type LocalResumeTarget, type ResumableSession, type SessionEndReason } from '@hapi/protocol'
import type { CursorChatStoreStatus, CursorMigrateOutcome, CursorMigrateToAcpRequest, MessageDeliveryMode, MessagesResponse, QueuedStateResponse, SlashCommandsResponse } from '@hapi/protocol/apiTypes'
import type { AgentFlavor, CodexCollaborationMode, CopilotAgentMode, DecryptedMessage, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import type { Store, CancelQueuedMessageResult } from '../store'
import type { HapiSessionExportResult } from '@hapi/protocol/sessionExport'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { clearAgentTerminalBuffer } from '../socket/agentTerminalBuffer'
import type { SSEManager } from '../sse/sseManager'
import { CursorLegacyMigrator, type CursorLegacyMigratorOptions } from '../cursor/cursorLegacyMigrator'

import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import { selectForkTranscriptPrefix } from './forkTranscript'
import {
    RpcGateway,
    RpcTargetMissingError,
    type RpcCodexModel,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcGeneratedImageResponse,
    type RpcListDirectoryResponse,
    type RpcStatFilesResponse,
    type RpcListAgyModelsResponse,
    type RpcListCodexModelsResponse,
    type RpcListPiSessionsResponse,
    type RpcArchiveCodexSessionResponse,
    type RpcListCursorModelsResponse,
    type RpcListOpencodeModelsResponse,
    type RpcListGrokModelsResponse,
    type RpcListCopilotModelsResponse,
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

type PiResumeAttempt = NonNullable<NonNullable<Session['metadata']>['piResumeAttempt']>
type PtyResumeAttempt = NonNullable<NonNullable<Session['metadata']>['ptyResumeAttempt']>

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type {
    RpcCodexModel,
    RpcCommandResponse,
    RpcDeleteUploadResponse,
    RpcGeneratedImageResponse,
    RpcListDirectoryResponse,
    RpcStatFilesResponse,
    RpcListAgyModelsResponse,
    RpcListCodexModelsResponse,
    RpcListPiSessionsResponse,
    RpcListCursorModelsResponse,
    RpcListOpencodeModelsResponse,
    RpcListGrokModelsResponse,
    RpcListCopilotModelsResponse,
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
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed'; rollbackSafe?: boolean }

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

export type ClearOpencodeSessionResult =
    | { type: 'success'; sessionId: string }
    | {
        type: 'error'
        message: string
        code: 'session_not_found' | 'access_denied' | 'clear_unavailable' | 'spawn_failed' | 'replacement_link_failed'
    }

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
    /** Sessions that emitted `session-ready` (Cursor ACP or validated Pi get_state). */
    private readonly sessionReadyIds = new Set<string>()
    /** Same-ID PTY rows with a resume currently in flight. */
    private readonly ptyResumeInFlightIds = new Set<string>()
    /** PTY rows kept fail-closed after a metadata write/clear failure. */
    private readonly ptyResumeQuarantinedIds = new Set<string>()
    /** Original Pi rows with a native resume currently in flight. */
    private readonly piResumeInFlightIds = new Set<string>()
    /** Pi rows whose runner child could not be confirmed terminated. */
    private readonly piResumeQuarantinedIds = new Set<string>()
    /** Unexpected version-skew temp child -> original row whose retry is blocked until child ends. */
    private readonly piUnexpectedTempOriginalIds = new Map<string, string>()
    /** Serialize scratchlist uploads per session so disk-byte caps cannot race. */
    private readonly scratchlistUploadTails = new Map<string, Promise<unknown>>()
    /** Coalesce duplicate clear requests so retries cannot spawn two fresh sessions. */
    private readonly opencodeClearTails = new Map<string, Promise<ClearOpencodeSessionResult>>()
    /** Serialize fork/rewind per session so concurrent native rollbacks cannot stack. */
    private readonly historyActionsInFlight = new Set<string>()

    constructor(
        private readonly store: Store,
        private readonly io: Server,
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

    async renameMachine(machineId: string, displayName: string): Promise<void> {
        return this.machineCache.renameMachine(machineId, displayName)
    }

    getMessagesPage(
        sessionId: string,
        options: {
            limit: number
            before?: { at: number; seq: number } | null
            after?: { at: number; seq: number } | null
            until?: { at: number; seq: number } | null
            epoch?: number | null
        }
    ): MessagesResponse {
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
            // Closes the second half of #884: when a CLI handler emits a
            // structured patch (todos / teamState / metadata / agentState),
            // apply it in place and forward the patch as-is. This skips both
            // the DB re-read AND the full-Session SSE broadcast that the
            // legacy no-data path went through. Web clients hit
            // getSessionPatch's truthy path and patch the cache instead of
            // falling through to the per-session REST invalidation that drove
            // the refetch storm.
            //
            // `applySessionPatch` MUTATES the cached Session in place (it
            // reassigns `session.metadata = patch.metadata.value`), so we
            // MUST snapshot the metadata reference BEFORE calling it.
            // Reading `before?.metadata` after the mutation would see the
            // new value and `hasSameAgentSessionIds` would always return
            // true — breaking the dedup-on-metadata-id-change trigger that
            // the legacy `refreshSession` path got for free (refresh
            // REPLACES the cache entry, leaving the old object reference
            // intact for the caller). Use the snapshot for BOTH branches
            // so the comparison contract is identical.
            const before = this.sessionCache.getSession(event.sessionId)
            const beforeMetadata = before?.metadata ?? null
            const patchApplied = event.data
                ? this.sessionCache.applySessionPatch(event.sessionId, event.data, event.namespace)
                : false

            if (patchApplied) {
                this.eventPublisher.emit(event)
                const after = this.sessionCache.getSession(event.sessionId)
                if (after?.metadata && !this.hasSameAgentSessionIds(beforeMetadata, after.metadata)) {
                    if (!this.canRunCursorDedup(after)) {
                        return
                    }
                    void this.sessionCache.deduplicateByAgentSessionId(event.sessionId).catch(() => {
                        // best-effort: dedup failure is harmless, web-side safety net hides remaining duplicates
                    })
                }
                return
            }

            // No-data event (or data we can't apply directly, e.g. full
            // Session payload from a different emitter): fall back to the
            // legacy refresh-from-DB-and-broadcast path.
            this.sessionCache.refreshSession(event.sessionId)
            const after = this.sessionCache.getSession(event.sessionId)
            if (after?.metadata && !this.hasSameAgentSessionIds(beforeMetadata, after.metadata)) {
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
        this.messageService.replayImmediateQueuedMessages(payload.sid)
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleSessionReady(payload: { sid: string; time: number }): void {
        this.sessionReadyIds.add(payload.sid)
        const session = this.sessionCache.getSession(payload.sid)
        if (session?.metadata?.piResumeAttempt) {
            void this.writePiResumeAttempt(payload.sid, session.namespace, null)
                .then(() => {
                    this.piResumeQuarantinedIds.delete(payload.sid)
                    this.triggerDedupIfNeeded(payload.sid)
                })
                .catch(() => {})
        }
        this.triggerDedupIfNeeded(payload.sid)
    }

    clearQueuedThinkingGrace(sessionId: string): void {
        this.sessionCache.clearQueuedThinkingGrace(sessionId)
    }

    handleSessionEnd(payload: { sid: string; time: number; reason?: SessionEndReason }): void {
        const before = this.sessionCache.getSession(payload.sid)
        if (before?.metadata?.opencodeClearOperation?.state === 'reserved' && payload.reason !== 'cleared') {
            const operation = before.metadata.opencodeClearOperation
            if (this.transitionClearOperation(payload.sid, before.namespace, operation, 'abort-needed')) {
                this.abortOpenCodeClearSession(payload.sid, before.namespace, operation.replacementSessionId, 'abort-needed')
            }
        }
        const ownsPiAttempt = before?.metadata?.piResumeAttempt !== undefined
        const ownsPtyAttempt = before?.metadata?.ptyResumeAttempt !== undefined
        const isPiAttemptChild = this.sessionCache.getSessions().some(
            (session) => session.metadata?.piResumeAttempt?.childSessionId === payload.sid
        )
        const restorePiArchive = ownsPiAttempt && !this.sessionReadyIds.has(payload.sid)
        const isCursorAcp = before?.metadata?.flavor === 'cursor'
            && before.metadata.cursorSessionProtocol === 'acp'
        const shouldRetryDedup = !ownsPiAttempt && !isPiAttemptChild && (!isCursorAcp || this.sessionReadyIds.has(payload.sid))

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
        this.piResumeQuarantinedIds.delete(payload.sid)
        this.piUnexpectedTempOriginalIds.delete(payload.sid)
        if (ownsPiAttempt || isPiAttemptChild) {
            void this.clearPiAttemptForEndedSession(payload.sid, restorePiArchive)
        }
        if (ownsPtyAttempt) {
            void this.writePtyResumeAttempt(payload.sid, before!.namespace, null).catch(() => {})
        }

        // Notify agent-terminal subscribers so the web UI shows a clear
        // termination message instead of staying connected with stale output.
        if (typeof this.io.of === 'function') {
            this.io.of('/terminal').to(`agent-session:${payload.sid}`).emit('agent-terminal:output', {
                sessionId: payload.sid,
                terminalId: 'agent',
                data: '\r\n[Session terminated]\r\n'
            })
        }
        clearAgentTerminalBuffer(payload.sid)
    }

    handleBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        this.sessionCache.applyBackgroundTaskDelta(sessionId, delta)
    }

    recordSessionActivity(sessionId: string, updatedAt: number): void {
        this.sessionCache.recordSessionActivity(sessionId, updatedAt)
    }

    /**
     * tiann/hapi#893 (scratchlist v2). Read-side: list entries for a
     * session. Auth / namespace check is the route layer's job (via
     * `requireSessionFromParam`); by the time we get here the caller
     * already proved access.
     */
    listScratchlistEntries(sessionId: string): Array<{
        entryId: string
        text: string
        createdAt: number
        updatedAt: number
        attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
    }> {
        return this.store.scratchlist.list(sessionId).map((row) => ({
            entryId: row.entryId,
            text: row.text,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            attachments: row.attachments,
        }))
    }

    countScratchlistEntries(sessionId: string): number {
        return this.store.scratchlist.count(sessionId)
    }

    sumScratchlistAttachmentBytes(sessionId: string): number {
        return this.store.scratchlist.sumAttachmentBytes(sessionId)
    }

    /**
     * Read a single entry by id. The route layer uses this to short-
     * circuit duplicate POSTs (migration retry) BEFORE running the
     * server-side cap check; otherwise an idempotent retry against a
     * session that has hit `SCRATCHLIST_MAX_ENTRIES` would 409 when it
     * should 200 with the existing row.
     */
    getScratchlistEntry(
        sessionId: string,
        entryId: string
    ): {
        entryId: string
        text: string
        createdAt: number
        updatedAt: number
        attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
    } | null {
        const row = this.store.scratchlist.get(sessionId, entryId)
        if (!row) return null
        return {
            entryId: row.entryId,
            text: row.text,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            attachments: row.attachments,
        }
    }

    /**
     * Insert a scratchlist entry. Returns the canonical row on success
     * (so the route layer can serialise it without a follow-up read).
     * Emits a `session-updated` SSE patch carrying `scratchlistUpdatedAt`
     * so other clients viewing the same session refetch.
     *
     * `outcome: 'duplicate'` covers the migration path's idempotency:
     * the web client may retry pushing a localStorage entry after a
     * partial failure; the second attempt should be a no-op rather than
     * a hard error. Route layer maps duplicate → 200/conflict per its
     * own contract; this layer just reports it.
     */
    createScratchlistEntry(
        sessionId: string,
        text: string,
        options?: {
            entryId?: string
            createdAt?: number
            attachments?: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    ): {
        outcome: 'created' | 'duplicate'
        entry: {
            entryId: string
            text: string
            createdAt: number
            updatedAt: number
            attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    } | { outcome: 'session-not-found' } {
        const result = this.store.scratchlist.create(sessionId, text, options)
        if (result.outcome === 'session-not-found') {
            return result
        }
        if (result.outcome === 'created') {
            this.sessionCache.emitScratchlistChanged(sessionId, result.entry.updatedAt)
        }
        return {
            outcome: result.outcome,
            entry: {
                entryId: result.entry.entryId,
                text: result.entry.text,
                createdAt: result.entry.createdAt,
                updatedAt: result.entry.updatedAt,
                attachments: result.entry.attachments,
            }
        }
    }

    updateScratchlistEntry(
        sessionId: string,
        entryId: string,
        patch: {
            text?: string
            attachments?: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    ): {
        entryId: string
        text: string
        createdAt: number
        updatedAt: number
        attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
    } | null {
        const updated = this.store.scratchlist.update(sessionId, entryId, patch)
        if (!updated) return null
        this.sessionCache.emitScratchlistChanged(sessionId, updated.updatedAt)
        return {
            entryId: updated.entryId,
            text: updated.text,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
            attachments: updated.attachments,
        }
    }

    deleteScratchlistEntry(sessionId: string, entryId: string): boolean {
        const existing = this.store.scratchlist.get(sessionId, entryId)
        const removed = this.store.scratchlist.delete(sessionId, entryId)
        if (removed && existing) {
            // Attachment ids may be shared across entries (direct REST).
            // Only delete blobs that no remaining entry still references.
            const remainingIds = new Set(
                this.store.scratchlist
                    .list(sessionId)
                    .flatMap((entry) => entry.attachments.map((att) => att.id))
            )
            const orphaned = existing.attachments.filter((att) => !remainingIds.has(att.id))
            if (orphaned.length > 0) {
                void import('../scratchlistAttachments/storage').then(({ deleteScratchlistAttachmentFiles, getHapiHomeDir }) =>
                    deleteScratchlistAttachmentFiles(getHapiHomeDir(), orphaned)
                )
            }
            this.sessionCache.emitScratchlistChanged(sessionId, Date.now())
        }
        return removed
    }

    private async withScratchlistUploadLock<T>(
        namespace: string,
        sessionId: string,
        fn: () => Promise<T>
    ): Promise<T> {
        const key = `${namespace}:${sessionId}`
        const previous = this.scratchlistUploadTails.get(key) ?? Promise.resolve()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.catch(() => undefined).then(() => gate)
        this.scratchlistUploadTails.set(key, tail)
        await previous.catch(() => undefined)
        try {
            return await fn()
        } finally {
            release()
            if (this.scratchlistUploadTails.get(key) === tail) {
                this.scratchlistUploadTails.delete(key)
            }
        }
    }

async uploadScratchlistAttachment(
        sessionId: string,
        namespace: string,
        filename: string,
        contentBase64: string,
        mimeType: string
    ): Promise<{ success: true; attachment: import('@hapi/protocol').ScratchlistAttachmentMetadata } | { success: false; error: string; code?: string }> {
        const { loadScratchlistAttachmentLimitsFromEnv, isAllowedScratchlistMime } = await import('../config/scratchlistAttachmentLimits')
        const {
            estimateBase64Bytes,
            writeScratchlistAttachmentFile,
            getHapiHomeDir,
            sumScratchlistAttachmentBytesOnDisk,
        } = await import('../scratchlistAttachments/storage')
        const { validateScratchlistAttachmentsForWrite } = await import('../scratchlistAttachments/validate')

        const limits = loadScratchlistAttachmentLimitsFromEnv()
        const estimated = estimateBase64Bytes(contentBase64)
        if (estimated > limits.maxBytesPerFile) {
            return { success: false, error: 'File too large', code: 'scratchlist_attachment_too_large' }
        }
        if (!isAllowedScratchlistMime(mimeType, limits)) {
            return { success: false, error: 'Mime type not allowed', code: 'scratchlist_attachment_mime' }
        }

        const hapiHome = getHapiHomeDir()
        const buffer = Buffer.from(contentBase64, 'base64')
        return await this.withScratchlistUploadLock(namespace, sessionId, async () => {
            const sessionBytes = await sumScratchlistAttachmentBytesOnDisk(hapiHome, namespace, sessionId)
            const provisional = {
                id: 'pending',
                filename,
                mimeType,
                size: buffer.length,
                path: 'pending',
            }
            const validation = validateScratchlistAttachmentsForWrite([provisional], limits, sessionBytes)
            if (!validation.ok) {
                return { success: false, error: validation.error, code: validation.code }
            }

            const attachment = await writeScratchlistAttachmentFile(
                hapiHome,
                namespace,
                sessionId,
                filename,
                mimeType,
                buffer
            )
            return { success: true, attachment }
        })
    }

    async resolveScratchlistAttachmentsForSession(
        sessionId: string,
        namespace: string,
        claimed: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
    ): Promise<
        | { ok: true; attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[] }
        | { ok: false; error: string }
    > {
        const {
            resolveScratchlistAttachmentsForSession: resolveAttachments,
            getHapiHomeDir,
        } = await import('../scratchlistAttachments/storage')
        return resolveAttachments(getHapiHomeDir(), namespace, sessionId, claimed)
    }

    async sumScratchlistAttachmentBytesOnDisk(sessionId: string, namespace: string): Promise<number> {
        const {
            sumScratchlistAttachmentBytesOnDisk: sumOnDisk,
            getHapiHomeDir,
        } = await import('../scratchlistAttachments/storage')
        return sumOnDisk(getHapiHomeDir(), namespace, sessionId)
    }

    async deleteScratchlistAttachmentById(
        sessionId: string,
        namespace: string,
        attachmentId: string
    ): Promise<boolean> {
        const {
            deleteScratchlistAttachmentById: deleteById,
            getHapiHomeDir,
        } = await import('../scratchlistAttachments/storage')
        return deleteById(getHapiHomeDir(), namespace, sessionId, attachmentId)
    }

    async readScratchlistAttachment(
        hubPath: string
    ): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
        const { readScratchlistAttachmentFile, getHapiHomeDir } = await import('../scratchlistAttachments/storage')
        const read = await readScratchlistAttachmentFile(getHapiHomeDir(), hubPath)
        if (!read) return null
        return { buffer: read.buffer, mimeType: 'application/octet-stream', filename: 'attachment' }
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
        this.machineCache.expireInactive?.()
        // Piggybacked on the inactivity tick; not a logical part of expireInactive
        // but shares its 5s cadence (avoids a second timer).
        this.messageService.releaseMatureScheduledMessages(Date.now(), this.historyActionsInFlight)
        void this.reconcileOpenCodeClears()
    }

    private async reconcileOpenCodeClears(): Promise<void> {
        for (let session of this.sessionCache.getSessions()) {
            const operation = session.metadata?.opencodeClearOperation
            if (session.active || !operation) continue
            if (operation.state === 'reserved') continue
            if (operation.state === 'abort-needed') {
                this.abortOpenCodeClearSession(session.id, session.namespace, operation.replacementSessionId, 'abort-needed')
                continue
            }
            if (!['cleanup-confirmed', 'finalizing', 'pending', 'failed'].includes(operation.state)) continue
            if (session.metadata?.lifecycleState !== 'archived' || session.metadata.archiveReason !== 'Cleared by /clear') {
                const result = this.store.sessions.updateSessionMetadata(session.id, {
                    ...session.metadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archiveReason: 'Cleared by /clear'
                }, session.metadataVersion, session.namespace, { touchUpdatedAt: false })
                if (result.result !== 'success') continue
                session = this.sessionCache.refreshSession(session.id) ?? session
            }
            await this.clearOpenCodeSession(session.id, session.namespace).catch(() => {})
        }
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
            deliveryMode?: MessageDeliveryMode
        }
    ): Promise<void> {
        if (this.historyActionsInFlight.has(sessionId)) {
            throw new Error('Conversation history action already in progress')
        }
        const { actualSessionId, createdAt: activeTurnStartedAt } = await this.messageService.sendMessage(sessionId, payload)
        this.sessionCache.markMessageQueued(actualSessionId, Date.now(), activeTurnStartedAt)
        this.sessionCache.recordSessionActivity(actualSessionId, Date.now())
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

    private assertConversationHistoryIdle(session: Session): void {
        if (!session.active) {
            throw new Error('Session must be active')
        }
        if (session.agentState?.controlledByUser === true) {
            throw new Error('Conversation history actions require a remote session')
        }
        if (session.thinking) {
            throw new Error('Session is busy')
        }
        if (session.metadata?.conversationHistoryDiverged === true) {
            throw new Error('Conversation history is diverged; refuse further fork/rewind')
        }
        const queued = this.store.messages.getUninvokedLocalMessages(session.id)
        if (queued.length > 0) {
            throw new Error('Session has queued messages')
        }
    }

    /** Stale localIds must fail before native fork/rewind mutates agent history. */
    private assertInvokedHistoryBoundary(sessionId: string, messageLocalId: string): void {
        const boundary = this.store.messages.getAllMessages(sessionId).find(
            (message) => message.localId === messageLocalId && message.invokedAt != null
        )
        if (!boundary) {
            throw new Error('History boundary message not found or not yet invoked')
        }
    }

    /**
     * Claude `--fork-session` materializes only after the child process starts.
     * Poll until the child metadata has a native id distinct from the source.
     */
    private async waitForClaudeForkBound(
        childId: string,
        sourceNativeSessionId: string,
        timeoutMs: number = 60_000
    ): Promise<boolean> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            this.sessionCache.refreshSession(childId)
            const child = this.sessionCache.getSession(childId)
            const boundId = child?.metadata?.claudeSessionId
            if (
                typeof boundId === 'string'
                && boundId.length > 0
                && boundId !== sourceNativeSessionId
            ) {
                return true
            }
            // Give the runner a few seconds to come up before treating inactivity as failure.
            if (child && !child.active && Date.now() - startedAt > 5_000) {
                return false
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    /**
     * A native fork may be created before its runner child has loaded it. Wait
     * for the exact persisted native id; Pi additionally requires its
     * validated `session-ready` event before the fork is visible to callers.
     */
    private async waitForExactNativeForkBound(
        childId: string,
        expectedNativeSessionId: string,
        metadataKey: 'grokSessionId' | 'piSessionId',
        requireSessionReady: boolean,
        timeoutMs: number = 60_000
    ): Promise<boolean> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            this.sessionCache.refreshSession(childId)
            const child = this.sessionCache.getSession(childId)
            const boundId = child?.metadata?.[metadataKey]
            if (typeof boundId === 'string' && boundId.length > 0) {
                if (boundId !== expectedNativeSessionId) return false
                if (!requireSessionReady || this.sessionReadyIds.has(childId)) return true
            }
            if (child && !child.active && Date.now() - startedAt > 5_000) {
                return false
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    /** Drop history locators that no longer have a corresponding message row. */
    private scrubHistoryLocators(sessionId: string, namespace: string): void {
        const remainingLocalIds = new Set(
            this.store.messages.getAllMessages(sessionId)
                .flatMap((message) => (message.localId ? [message.localId] : []))
        )
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!session?.metadata) return

            const nextMetadata: Record<string, unknown> = { ...session.metadata }
            let changed = false

            const points = session.metadata.conversationHistoryPoints
            if (points) {
                const nextPoints = Object.fromEntries(
                    Object.entries(points).filter(([localId]) => remainingLocalIds.has(localId))
                )
                if (Object.keys(nextPoints).length !== Object.keys(points).length) {
                    changed = true
                    if (Object.keys(nextPoints).length > 0) {
                        nextMetadata.conversationHistoryPoints = nextPoints
                    } else {
                        delete nextMetadata.conversationHistoryPoints
                    }
                }
            }

            const indexes = session.metadata.conversationHistoryIndexes
            if (indexes) {
                const nextIndexes = Object.fromEntries(
                    Object.entries(indexes).filter(([localId]) => remainingLocalIds.has(localId))
                )
                if (Object.keys(nextIndexes).length !== Object.keys(indexes).length) {
                    changed = true
                    if (Object.keys(nextIndexes).length > 0) {
                        nextMetadata.conversationHistoryIndexes = nextIndexes
                    } else {
                        delete nextMetadata.conversationHistoryIndexes
                    }
                }
            }

            const turns = session.metadata.conversationHistoryTurns
            if (turns) {
                const nextTurns = Object.fromEntries(
                    Object.entries(turns).filter(([localId]) => remainingLocalIds.has(localId))
                )
                if (Object.keys(nextTurns).length !== Object.keys(turns).length) {
                    changed = true
                    if (Object.keys(nextTurns).length > 0) {
                        nextMetadata.conversationHistoryTurns = nextTurns
                    } else {
                        delete nextMetadata.conversationHistoryTurns
                    }
                }
            }

            const entryIds = session.metadata.conversationHistoryEntryIds
            if (entryIds) {
                const nextEntryIds = Object.fromEntries(
                    Object.entries(entryIds).filter(([localId]) => remainingLocalIds.has(localId))
                )
                if (Object.keys(nextEntryIds).length !== Object.keys(entryIds).length) {
                    changed = true
                    if (Object.keys(nextEntryIds).length > 0) {
                        nextMetadata.conversationHistoryEntryIds = nextEntryIds
                    } else {
                        delete nextMetadata.conversationHistoryEntryIds
                    }
                }
            }

            if (!changed) return

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                nextMetadata,
                session.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result !== 'version-mismatch') return
            this.sessionCache.refreshSession(sessionId)
        }
    }

    private markConversationHistoryDiverged(sessionId: string, namespace: string): void {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!session?.metadata) return
            if (session.metadata.conversationHistoryDiverged === true) return

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                { ...session.metadata, conversationHistoryDiverged: true },
                session.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result !== 'version-mismatch') return
            this.sessionCache.refreshSession(sessionId)
        }
    }

    async forkConversation(
        sessionId: string,
        namespace: string,
        messageLocalId?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        if (this.historyActionsInFlight.has(sessionId)) {
            return { type: 'error', message: 'Conversation history action already in progress' }
        }
        this.historyActionsInFlight.add(sessionId)
        try {
            return await this.forkConversationUnlocked(sessionId, namespace, messageLocalId)
        } finally {
            this.historyActionsInFlight.delete(sessionId)
        }
    }

    private async forkConversationUnlocked(
        sessionId: string,
        namespace: string,
        messageLocalId?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        const access = this.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return { type: 'error', message: access.reason === 'not-found' ? 'Session not found' : 'Access denied' }
        }
        let source = access.session
        try {
            this.assertConversationHistoryIdle(source)
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }

        const history = source.metadata?.capabilities?.conversationHistory
        if (messageLocalId) {
            if (history?.forkAtMessage !== true) {
                return { type: 'error', message: 'Historical fork is not supported for this session' }
            }
            try {
                this.assertInvokedHistoryBoundary(sessionId, messageLocalId)
            } catch (error) {
                return { type: 'error', message: error instanceof Error ? error.message : String(error) }
            }
        } else if (history?.forkCurrent !== true) {
            return { type: 'error', message: 'Fork current is not supported for this session' }
        }

        const machineId = source.metadata?.machineId
        const directory = source.metadata?.path
        if (!machineId || !directory) {
            return { type: 'error', message: 'Session is missing machine or path metadata' }
        }

        let rpcResult: Awaited<ReturnType<RpcGateway['forkConversation']>>
        try {
            rpcResult = await this.rpcGateway.forkConversation(
                sessionId,
                messageLocalId ? { messageLocalId } : {}
            )
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }

        if (!rpcResult?.nativeSessionId) {
            return { type: 'error', message: 'Native fork did not return a session id' }
        }

        // Native fork RPC can race CLI metadata/transcript updates. Construct
        // the child only from a fresh source snapshot, never the pre-RPC row.
        const refreshedSource = this.sessionCache.refreshSession(sessionId)
        if (!refreshedSource || refreshedSource.namespace !== namespace) {
            return { type: 'error', message: 'Source session disappeared after native fork' }
        }
        source = refreshedSource

        const flavor = this.resolveFlavor(source)
        const childId = randomUUID()
        let prefix
        try {
            prefix = selectForkTranscriptPrefix(this.store.messages.getAllMessages(sessionId), messageLocalId)
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
        const copiedLocalIds = new Set(
            prefix.flatMap((message) => (message.localId ? [message.localId] : []))
        )
        const childMetadata: Record<string, unknown> = {
            path: directory,
            host: source.metadata?.host ?? 'unknown',
            machineId,
            flavor,
            forkedFrom: sessionId,
            startedBy: 'runner',
            capabilities: source.metadata?.capabilities,
            conversationHistoryPoints: Object.fromEntries(
                Object.entries(source.metadata?.conversationHistoryPoints ?? {})
                    .filter(([localId]) => copiedLocalIds.has(localId))
            ),
            conversationHistoryIndexes: Object.fromEntries(
                Object.entries(source.metadata?.conversationHistoryIndexes ?? {})
                    .filter(([localId]) => copiedLocalIds.has(localId))
            ),
            conversationHistoryTurns: Object.fromEntries(
                Object.entries(source.metadata?.conversationHistoryTurns ?? {})
                    .filter(([localId]) => copiedLocalIds.has(localId))
            ),
            conversationHistoryEntryIds: Object.fromEntries(
                Object.entries(source.metadata?.conversationHistoryEntryIds ?? {})
                    .filter(([localId]) => copiedLocalIds.has(localId))
            )
        }
        if (flavor === 'codex') {
            childMetadata.codexSessionId = rpcResult.nativeSessionId
        } else if (flavor === 'grok') {
            childMetadata.grokSessionId = rpcResult.nativeSessionId
        } else if (flavor === 'pi') {
            childMetadata.piSessionId = rpcResult.nativeSessionId
        } else if (flavor === 'claude') {
            // Child will bind the forked Claude id after --fork-session starts.
            childMetadata.claudeSessionId = rpcResult.forkSession ? undefined : rpcResult.nativeSessionId
        }

        // A Pi native fork already carries the branch's authoritative model and
        // thinking state. Do not replay the source wrapper's current overrides
        // onto the child; the resumed child will report its own get_state.
        const forkModel = flavor === 'pi' ? undefined : source.model ?? undefined
        const forkEffort = flavor === 'pi' ? undefined : source.effort ?? undefined

        let childCreated = false
        let spawnAttempted = false
        try {
            this.sessionCache.getOrCreateSession(
                `fork:${childId}`,
                childMetadata,
                null,
                namespace,
                forkModel,
                forkEffort,
                source.modelReasoningEffort ?? undefined,
                childId
            )
            childCreated = true

            // Native fork keeps agent context, but the new HAPI row starts empty.
            // Hydrate the transcript prefix so web navigation is not a blank thread.
            this.store.messages.copyMessagesToSession(
                childId,
                prefix.map((message) => ({
                    content: message.content,
                    createdAt: message.createdAt,
                    localId: message.localId,
                    invokedAt: message.invokedAt,
                    scheduledAt: message.scheduledAt
                }))
            )
            this.sessionCache.rebuildTodosFromTranscript(childId)
            this.sessionCache.refreshSession(childId)

            spawnAttempted = true
            const spawn = await this.rpcGateway.spawnSession(
                machineId,
                directory,
                flavor,
                forkModel,
                source.modelReasoningEffort ?? undefined,
                undefined,
                'simple',
                undefined,
                rpcResult.nativeSessionId,
                forkEffort,
                source.permissionMode,
                source.serviceTier ?? undefined,
                childId,
                source.collaborationMode,
                undefined,
                undefined,
                rpcResult.forkSession === true
            )
            if (spawn.type !== 'success') {
                throw new Error(spawn.message)
            }

            // Claude fork is spawn+flag, not an RPC-time snapshot. Keep the
            // source history lock (caller holds historyActionsInFlight) until
            // the child binds a distinct native id — otherwise the source can
            // advance before --fork-session materializes.
            if (flavor === 'claude' && rpcResult.forkSession === true) {
                const bound = await this.waitForClaudeForkBound(childId, rpcResult.nativeSessionId)
                if (!bound) {
                    throw new Error('Claude fork did not materialize before timeout')
                }
            }

            // Grok forks at RPC time, but spawn may still fall back to a blank
            // session if load fails. Do not report success until the child is
            // bound to the exact forked native id.
            if (flavor === 'grok') {
                const bound = await this.waitForExactNativeForkBound(
                    childId, rpcResult.nativeSessionId, 'grokSessionId', false
                )
                if (!bound) {
                    throw new Error('Grok fork could not load the forked native session')
                }
            }

            if (flavor === 'pi') {
                const bound = await this.waitForExactNativeForkBound(
                    childId, rpcResult.nativeSessionId, 'piSessionId', true
                )
                if (!bound) {
                    throw new Error('Pi fork could not load the exact native session before ready')
                }
            }

            return { type: 'success', sessionId: childId }
        } catch (error) {
            if (childCreated) {
                try {
                    await this.cleanupFailedForkChild(childId, machineId, spawnAttempted)
                } catch (cleanupError) {
                    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                    return { type: 'error', message: `Fork failed; child cleanup was not confirmed: ${message}` }
                }
            }
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
    }

    /** Kill an active fork child (if any) then delete the HAPI row. */
    private async cleanupFailedForkChild(
        childId: string,
        machineId: string,
        spawnAttempted: boolean
    ): Promise<void> {
        if (spawnAttempted) {
            const status = await this.rpcGateway.stopRunnerSession(machineId, childId)
            if (status === 'still_alive') {
                throw new Error('Fork child termination was not confirmed')
            }
        }
        const child = this.sessionCache.refreshSession(childId)
        if (child?.active) {
            this.handleSessionEnd({ sid: childId, time: Date.now(), reason: 'error' })
        }
        await this.deleteSession(childId)
    }

    async rewindConversation(
        sessionId: string,
        namespace: string,
        messageLocalId: string
    ): Promise<{ type: 'success' } | { type: 'error'; message: string; hydrateFailed?: boolean }> {
        if (this.historyActionsInFlight.has(sessionId)) {
            return { type: 'error', message: 'Conversation history action already in progress' }
        }
        this.historyActionsInFlight.add(sessionId)
        try {
            return await this.rewindConversationUnlocked(sessionId, namespace, messageLocalId)
        } finally {
            this.historyActionsInFlight.delete(sessionId)
        }
    }

    private async rewindConversationUnlocked(
        sessionId: string,
        namespace: string,
        messageLocalId: string
    ): Promise<{ type: 'success' } | { type: 'error'; message: string; hydrateFailed?: boolean }> {
        const access = this.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return { type: 'error', message: access.reason === 'not-found' ? 'Session not found' : 'Access denied' }
        }
        const session = access.session
        try {
            this.assertConversationHistoryIdle(session)
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
        if (session.metadata?.capabilities?.conversationHistory?.rewindToMessage !== true) {
            return { type: 'error', message: 'Rewind is not supported for this session' }
        }
        try {
            this.assertInvokedHistoryBoundary(sessionId, messageLocalId)
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }

        let rpcResult: Awaited<ReturnType<RpcGateway['rewindConversation']>>
        try {
            rpcResult = await this.rpcGateway.rewindConversation(sessionId, { messageLocalId })
        } catch (error) {
            if (!(error instanceof RpcTargetMissingError)) {
                this.markConversationHistoryDiverged(sessionId, namespace)
                return {
                    type: 'error',
                    hydrateFailed: true,
                    message: 'Rewind outcome is unknown; session history requires reconciliation'
                }
            }
            return { type: 'error', message: error.message }
        }

        if (rpcResult?.success !== true) {
            return { type: 'error', message: rpcResult?.error ?? 'Native rewind failed' }
        }

        try {
            this.store.messages.truncateMessagesFromLocalId(
                sessionId,
                rpcResult.truncateFromLocalId ?? messageLocalId,
                rpcResult.messages ?? []
            )
            this.scrubHistoryLocators(sessionId, namespace)
            this.sessionCache.rebuildTodosFromTranscript(sessionId)
            this.eventPublisher.emit({ type: 'messages-invalidated', sessionId, namespace })
            this.sessionCache.refreshSession(sessionId)
            return { type: 'success' }
        } catch (error) {
            // Native history already changed; refuse further history actions until repaired.
            this.markConversationHistoryDiverged(sessionId, namespace)
            return {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
                hydrateFailed: true
            }
        }
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
        if (this.historyActionsInFlight.has(sessionId)) {
            throw new Error('Conversation history action already in progress')
        }
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
            copilotAgentMode?: CopilotAgentMode
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
                copilotAgentMode?: Session['copilotAgentMode']
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
        existingSessionId?: string,
        collaborationMode?: CodexCollaborationMode,
        copilotAgentMode?: CopilotAgentMode,
        startingMode?: 'remote' | 'pty'
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
            existingSessionId,
            collaborationMode,
            copilotAgentMode,
            startingMode
        )
    }

    /**
     * Spawn a fresh OpenCode HAPI session from a source that its own CLI has
     * already archived with the `cleared` lifecycle. Deliberately accepts only
     * that post-cleanup state: a target must never become active while the
     * source still owns an in-flight OpenCode turn or native compaction.
     */
    async clearOpenCodeSession(sessionId: string, namespace: string): Promise<ClearOpencodeSessionResult> {
        const clearTailKey = `${namespace}:${sessionId}`
        const existing = this.opencodeClearTails.get(clearTailKey)
        if (existing) {
            return await existing
        }

        const task = this.clearOpenCodeSessionOnce(sessionId, namespace)
        this.opencodeClearTails.set(clearTailKey, task)
        try {
            return await task
        } finally {
            if (this.opencodeClearTails.get(clearTailKey) === task) {
                this.opencodeClearTails.delete(clearTailKey)
            }
        }
    }

    reserveOpenCodeClearSession(sessionId: string, namespace: string): ClearOpencodeSessionResult {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return { type: 'error', message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found', code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found' }
        }
        const source = access.session
        const metadata = source.metadata
        if (!source.active || metadata?.flavor !== 'opencode' || metadata.startedBy !== 'runner' || !metadata.machineId || !metadata.path) {
            return { type: 'error', message: 'Session is not an active runner-backed OpenCode session', code: 'clear_unavailable' }
        }
        const existing = metadata.opencodeClearOperation
        const operation = !existing || existing.state === 'aborted'
            ? { replacementSessionId: randomUUID(), state: 'reserved' as const, updatedAt: Date.now() }
            : existing
        if (operation !== existing && !this.persistClearOperation(sessionId, namespace, operation)) {
            return { type: 'error', message: 'Could not persist the OpenCode clear reservation', code: 'replacement_link_failed' }
        }
        const replacementMetadata = { ...metadata }
        delete replacementMetadata.opencodeSessionId
        delete replacementMetadata.supersededBySessionId
        delete replacementMetadata.opencodeClearOperation
        delete replacementMetadata.lifecycleState
        delete replacementMetadata.lifecycleStateSince
        delete replacementMetadata.archivedBy
        delete replacementMetadata.archiveReason
        replacementMetadata.startedFromRunner = true
        replacementMetadata.startedBy = 'runner'
        this.getOrCreateSession(`opencode-clear-replacement:${operation.replacementSessionId}`, replacementMetadata, null, namespace,
            source.model ?? undefined, source.effort ?? undefined, source.modelReasoningEffort ?? undefined, operation.replacementSessionId)
        return { type: 'success', sessionId: operation.replacementSessionId }
    }

    abortOpenCodeClearSession(
        sessionId: string,
        namespace: string,
        replacementSessionId: string,
        expectedState: 'reserved' | 'abort-needed' = 'reserved',
        requireInactive: boolean = false
    ): ClearOpencodeSessionResult {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) return { type: 'error', message: 'Session not found', code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found' }
        const operation = access.session.metadata?.opencodeClearOperation
        if (!operation) return { type: 'error', message: 'Clear reservation not found', code: 'clear_unavailable' }
        if (operation.state === 'aborted') {
            return replacementSessionId === operation.replacementSessionId
                ? { type: 'success', sessionId }
                : { type: 'error', message: 'Clear reservation not found', code: 'clear_unavailable' }
        }
        const required = { replacementSessionId, state: expectedState, requireInactive }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace) ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) break
            const current = latest.metadata.opencodeClearOperation
            if (!current) break
            if (current.replacementSessionId === required.replacementSessionId && current.state === 'aborted') {
                return { type: 'success', sessionId }
            }
            if ((required.requireInactive && latest.active)
                || current.replacementSessionId !== required.replacementSessionId
                || current.state !== required.state) break
            const result = this.store.abortOpenCodeClearOperation(sessionId, current.replacementSessionId, {
                ...latest.metadata,
                opencodeClearOperation: { ...current, state: 'aborted', updatedAt: Date.now(), error: undefined }
            }, latest.metadataVersion, namespace, required)
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return { type: 'success', sessionId }
            }
            if (result.result !== 'version-mismatch') break
            this.sessionCache.refreshSession(sessionId)
        }
        return { type: 'error', message: 'Could not abort clear reservation', code: 'replacement_link_failed' }
    }

    confirmOpenCodeClearCleanup(sessionId: string, namespace: string, replacementSessionId: string): ClearOpencodeSessionResult {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) return { type: 'error', message: 'Session not found', code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found' }
        const operation = access.session.metadata?.opencodeClearOperation
        if (!operation) return { type: 'error', message: 'Clear reservation not found', code: 'clear_unavailable' }
        if (operation.state === 'cleanup-confirmed' && operation.replacementSessionId === replacementSessionId) {
            return { type: 'success', sessionId: operation.replacementSessionId }
        }
        if (operation.state !== 'reserved') return { type: 'error', message: 'Clear reservation not found', code: 'clear_unavailable' }
        if (operation.replacementSessionId !== replacementSessionId) return { type: 'error', message: 'Clear reservation not found', code: 'clear_unavailable' }
        if (!this.transitionClearOperation(sessionId, namespace, operation, 'cleanup-confirmed')) {
            return { type: 'error', message: 'Could not confirm native cleanup', code: 'replacement_link_failed' }
        }
        return { type: 'success', sessionId: operation.replacementSessionId }
    }

    private async clearOpenCodeSessionOnce(sessionId: string, namespace: string): Promise<ClearOpencodeSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const source = access.session
        const metadata = source.metadata
        if (source.active
            || metadata?.flavor !== 'opencode'
            || metadata.lifecycleState !== 'archived'
            || metadata.archiveReason !== 'Cleared by /clear') {
            return {
                type: 'error',
                message: 'Session must be an archived OpenCode clear source',
                code: 'clear_unavailable'
            }
        }

        // A completed first request is the durable idempotency record used by
        // reconnecting/retrying CLI processes after their source socket closed.
        if (metadata.supersededBySessionId) {
            return { type: 'success', sessionId: metadata.supersededBySessionId }
        }

        if (!metadata.machineId || !metadata.path) {
            return {
                type: 'error',
                message: 'OpenCode clear source is missing machine or directory metadata',
                code: 'clear_unavailable'
            }
        }
        // The source metadata is client-controlled, so validate the recorded
        // machine through the namespace-scoped cache before any persistent or
        // runner-facing action.
        if (!this.getMachineByNamespace(metadata.machineId, namespace)) {
            return {
                type: 'error',
                message: 'OpenCode clear source machine is unavailable in this namespace',
                code: 'clear_unavailable'
            }
        }

        // Persist the replacement identity *before* asking a runner to create
        // a process. A retry after a lost RPC response therefore uses this same
        // HAPI id rather than accidentally spawning a second fresh session.
        let operation = metadata.opencodeClearOperation
        if (!operation) {
            operation = {
                replacementSessionId: randomUUID(),
                state: 'pending' as const,
                updatedAt: Date.now()
            }
            if (!this.persistClearOperation(sessionId, namespace, operation)) {
                return {
                    type: 'error',
                    message: 'Could not persist the OpenCode clear replacement operation',
                    code: 'replacement_link_failed'
                }
            }
        } else if (operation.state === 'failed') {
            operation = { ...operation, state: 'pending', updatedAt: Date.now(), error: undefined }
            if (!this.persistClearOperation(sessionId, namespace, operation)) {
                return {
                    type: 'error',
                    message: 'Could not resume the OpenCode clear replacement operation',
                    code: 'replacement_link_failed'
                }
            }
        }

        if (operation.state === 'reserved') {
            return { type: 'error', message: 'Native OpenCode cleanup is not confirmed', code: 'clear_unavailable' }
        }
        if (operation.state === 'cleanup-confirmed') {
            operation = { ...operation, state: 'finalizing', updatedAt: Date.now() }
            if (!this.persistClearOperation(sessionId, namespace, operation)) {
                return { type: 'error', message: 'Could not finalize the OpenCode clear reservation', code: 'replacement_link_failed' }
            }
        }

        const replacementMetadata = { ...metadata }
        delete replacementMetadata.opencodeSessionId
        delete replacementMetadata.supersededBySessionId
        delete replacementMetadata.opencodeClearOperation
        delete replacementMetadata.lifecycleState
        delete replacementMetadata.lifecycleStateSince
        delete replacementMetadata.archivedBy
        delete replacementMetadata.archiveReason
        replacementMetadata.startedFromRunner = true
        replacementMetadata.startedBy = 'runner'

        // bootstrapExistingSession requires an existing row. The stable id lets
        // a runner coalesce retries only while its spawned child remains alive;
        // replacement.active is the durable cross-runner reconciliation signal.
        const replacement = this.getOrCreateSession(
            `opencode-clear-replacement:${operation.replacementSessionId}`,
            replacementMetadata,
            null,
            namespace,
            source.model ?? undefined,
            source.effort ?? undefined,
            source.modelReasoningEffort ?? undefined,
            operation.replacementSessionId
        )

        // A previous request can have spawned the target but lost the source
        // link acknowledgement. Do not ask the runner again in that case.
        if (replacement.active) {
            return this.finishOpenCodeClear(sessionId, namespace, operation.replacementSessionId, operation)
        }

        // Do not supply a native OpenCode resume id. existingSessionId is only
        // the preallocated HAPI row; OpenCode starts a brand-new native thread.
        const spawned = await this.spawnSession(
            metadata.machineId,
            metadata.path,
            'opencode',
            source.model ?? undefined,
            source.modelReasoningEffort ?? undefined,
            false,
            undefined,
            undefined,
            undefined,
            source.effort ?? undefined,
            source.permissionMode ?? metadata.preferredPermissionMode,
            source.serviceTier ?? undefined,
            operation.replacementSessionId,
            source.collaborationMode
        )
        if (spawned.type === 'error') {
            this.persistClearOperationState(sessionId, namespace, operation, spawned.message)
            return { type: 'error', message: spawned.message, code: 'spawn_failed' }
        }
        if (spawned.sessionId !== operation.replacementSessionId) {
            const message = 'Runner returned an unexpected OpenCode clear replacement id'
            this.persistClearOperationState(sessionId, namespace, operation, message)
            return { type: 'error', message, code: 'spawn_failed' }
        }

        return this.finishOpenCodeClear(sessionId, namespace, operation.replacementSessionId, operation)
    }

    private finishOpenCodeClear(
        sessionId: string,
        namespace: string,
        replacementSessionId: string,
        operation: NonNullable<Session['metadata']>['opencodeClearOperation']
    ): ClearOpencodeSessionResult {
        if (!operation) {
            return {
                type: 'error',
                message: 'OpenCode clear operation was not persisted',
                code: 'replacement_link_failed'
            }
        }
        try {
            const moved = this.store.messages.moveUninvokedMessages(sessionId, replacementSessionId)
            if (moved > 0) {
                this.eventPublisher.emit({ type: 'messages-invalidated', sessionId })
                this.eventPublisher.emit({ type: 'messages-invalidated', sessionId: replacementSessionId })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Could not move scheduled prompts to the fresh OpenCode session'
            this.persistClearOperationState(sessionId, namespace, operation, message)
            return { type: 'error', message, code: 'replacement_link_failed' }
        }
        if (!this.persistClearReplacement(sessionId, namespace, replacementSessionId, operation)) {
            const message = 'Fresh OpenCode session started but the archived source could not be linked'
            this.persistClearOperationState(sessionId, namespace, operation, message)
            return {
                type: 'error',
                message,
                code: 'replacement_link_failed'
            }
        }
        this.messageService.releaseDeliverableQueuedMessages(replacementSessionId)
        return { type: 'success', sessionId: replacementSessionId }
    }

    private transitionClearOperation(
        sessionId: string,
        namespace: string,
        expected: NonNullable<NonNullable<Session['metadata']>['opencodeClearOperation']>,
        state: 'abort-needed' | 'cleanup-confirmed'
    ): boolean {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return false
            const current = latest.metadata.opencodeClearOperation
            if (current?.replacementSessionId === expected.replacementSessionId && current.state === state) return true
            if (current?.replacementSessionId !== expected.replacementSessionId || current.state !== expected.state) return false
            const result = this.store.transitionOpenCodeClearOperation(sessionId, {
                ...latest.metadata,
                opencodeClearOperation: { ...expected, state, updatedAt: Date.now(), error: undefined }
            }, latest.metadataVersion, namespace, {
                replacementSessionId: expected.replacementSessionId,
                state: expected.state
            })
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return true
            }
            if (result.result !== 'version-mismatch') return false
            this.sessionCache.refreshSession(sessionId)
        }
        return false
    }

    private persistClearOperation(
        sessionId: string,
        namespace: string,
        operation: NonNullable<Session['metadata']>['opencodeClearOperation']
    ): boolean {
        if (!operation) return false
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return false
            if (latest.metadata.supersededBySessionId) {
                return latest.metadata.supersededBySessionId === operation.replacementSessionId
            }
            const existing = latest.metadata.opencodeClearOperation
            if (existing && existing.replacementSessionId !== operation.replacementSessionId && existing.state !== 'aborted') return false
            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                { ...latest.metadata, opencodeClearOperation: operation },
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return true
            }
            if (result.result !== 'version-mismatch') return false
            this.sessionCache.refreshSession(sessionId)
        }
        return false
    }

    private persistClearOperationState(
        sessionId: string,
        namespace: string,
        operation: NonNullable<Session['metadata']>['opencodeClearOperation'],
        error: string
    ): void {
        if (!operation) return
        this.persistClearOperation(sessionId, namespace, {
            ...operation,
            state: 'failed',
            updatedAt: Date.now(),
            error: error.slice(0, 500)
        })
    }

    private persistClearReplacement(
        sessionId: string,
        namespace: string,
        replacementSessionId: string,
        operation: NonNullable<Session['metadata']>['opencodeClearOperation']
    ): boolean {
        if (!operation) return false
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return false
            if (latest.metadata.supersededBySessionId) {
                return latest.metadata.supersededBySessionId === replacementSessionId
            }
            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                {
                    ...latest.metadata,
                    supersededBySessionId: replacementSessionId,
                    opencodeClearOperation: {
                        ...operation,
                        state: 'completed',
                        updatedAt: Date.now(),
                        error: undefined
                    }
                },
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return true
            }
            if (result.result !== 'version-mismatch') return false
            this.sessionCache.refreshSession(sessionId)
        }
        return false
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
        if (flavor === 'codex') {
            return metadata.codexSessionId ?? this.recoverCodexSessionIdFromMessages(session.id, namespace)
        }
        if (flavor === 'gemini') return metadata.geminiSessionId ?? null
        if (flavor === 'opencode') return metadata.opencodeSessionId ?? null
        if (flavor === 'grok') return metadata.grokSessionId ?? null
        if (flavor === 'agy') return metadata.agySessionId ?? null
        if (flavor === 'cursor') return metadata.cursorSessionId ?? null
        if (flavor === 'kimi') return metadata.kimiSessionId ?? null
        if (flavor === 'copilot') return metadata.copilotSessionId ?? null
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
                collaborationMode: session.collaborationMode,
                copilotAgentMode: session.copilotAgentMode
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
                    copilotAgentMode: target.copilotAgentMode,
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

    private isOpenCodeClearSource(session: Session): boolean {
        const metadata = session.metadata
        return metadata?.flavor === 'opencode'
            && (metadata.archiveReason === 'Cleared by /clear'
                || (metadata.opencodeClearOperation !== undefined && metadata.opencodeClearOperation.state !== 'aborted')
                || metadata.supersededBySessionId !== undefined)
    }

    private async recoverInactiveReservedClear(session: Session, namespace: string): Promise<boolean> {
        const operation = session.metadata?.opencodeClearOperation
        const machineId = session.metadata?.machineId
        if (session.active || operation?.state !== 'reserved' || !machineId) return false
        try {
            const status = await this.rpcGateway.stopRunnerSession(machineId, session.id)
            if (status === 'still_alive') return false
            return this.abortOpenCodeClearSession(
                session.id, namespace, operation.replacementSessionId, 'reserved', true
            ).type === 'success'
        } catch {
            return false
        }
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

        let initialSession = access.session
        if (await this.recoverInactiveReservedClear(initialSession, namespace)) {
            initialSession = this.sessionCache.getSessionByNamespace(sessionId, namespace) ?? initialSession
        }
        if (this.isOpenCodeClearSource(initialSession)) {
            return {
                type: 'error',
                message: 'This OpenCode session was replaced by /clear',
                code: 'resume_unavailable'
            }
        }
        const initialPtyMode =
            (initialSession.agentState as { startingMode?: 'local' | 'remote' | 'pty' } | null)?.startingMode === 'pty'
        if (initialPtyMode && this.ptyResumeInFlightIds.has(access.sessionId)) {
            return { type: 'error', message: 'PTY resume is already in progress', code: 'resume_failed' }
        }
        if (
            initialPtyMode
            && this.ptyResumeQuarantinedIds.has(access.sessionId)
            && !initialSession.metadata?.ptyResumeAttempt
        ) {
            return { type: 'error', message: 'PTY resume cleanup is incomplete', code: 'resume_failed', rollbackSafe: false }
        }
        if (initialSession.metadata?.ptyResumeAttempt) {
            const reconciled = await this.reconcilePersistedPtyResumeAttempt(initialSession)
            if (!reconciled) {
                return {
                    type: 'error',
                    message: 'PTY resume timed out and the child is still active',
                    code: 'resume_failed',
                    rollbackSafe: false,
                }
            }
            this.ptyResumeQuarantinedIds.delete(access.sessionId)
            initialSession = this.sessionCache.getSessionByNamespace(access.sessionId, namespace) ?? initialSession
        }
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
            { strictMachineId: flavor === 'cursor' || (flavor === 'pi' && resumeToken !== undefined) }
        )
        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        if (flavor === 'pi' && resumeToken && targetMachine.runnerState?.capabilities?.piExistingSessionResume !== true) {
            return { type: 'error', message: 'Pi resume requires an upgraded runner', code: 'resume_failed' }
        }

        const requiresPiNativeReady = flavor === 'pi' && resumeToken !== undefined
        if (requiresPiNativeReady) {
            if (this.isPiResumeBlocked(access.sessionId)) {
                return { type: 'error', message: 'Pi resume is already in progress', code: 'resume_failed' }
            }
            this.piResumeInFlightIds.add(access.sessionId)
            this.sessionReadyIds.delete(access.sessionId)
            try {
                await this.writePiResumeAttempt(access.sessionId, namespace, {
                    state: 'resuming',
                    machineId: targetMachine.id,
                    startedAt: Date.now(),
                    archiveSnapshot: {
                        lifecycleState: metadata.lifecycleState,
                        lifecycleStateSince: metadata.lifecycleStateSince,
                        archivedBy: metadata.archivedBy,
                        archiveReason: metadata.archiveReason,
                    },
                })
            } catch {
                this.piResumeInFlightIds.delete(access.sessionId)
                return { type: 'error', message: 'Failed to record Pi resume attempt', code: 'resume_failed' }
            }
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
        const resumedStartingMode =
            (session.agentState as { startingMode?: 'local' | 'remote' | 'pty' } | null)?.startingMode === 'pty'
                ? 'pty'
                : undefined
        if (resumedStartingMode === 'pty') {
            if (this.ptyResumeInFlightIds.has(access.sessionId)) {
                return { type: 'error', message: 'PTY resume is already in progress', code: 'resume_failed' }
            }
            this.ptyResumeInFlightIds.add(access.sessionId)
            // Persist before spawn so a Hub restart cannot forget an in-place
            // child whose readiness outcome is still unknown.
            try {
                await this.writePtyResumeAttempt(access.sessionId, namespace, {
                    state: 'resuming',
                    machineId: targetMachine.id,
                    startedAt: Date.now(),
                })
            } catch {
                this.ptyResumeInFlightIds.delete(access.sessionId)
                return { type: 'error', message: 'Failed to record PTY resume attempt', code: 'resume_failed' }
            }
            // PTY reopen intentionally reuses the archived session id. Any
            // readiness bit from the previous process must not satisfy the
            // replacement process's readiness barrier.
            this.sessionReadyIds.delete(access.sessionId)
        }
        let piResumeSucceeded = false
        try {
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
                access.sessionId,
                session.collaborationMode ?? undefined,
                session.copilotAgentMode ?? undefined,
                resumedStartingMode
            )

            if (spawnResult.type !== 'success') {
                if (requiresPiNativeReady) {
                    const stopped = await this.terminateInPlacePiResume(
                        targetMachine.id,
                        access.sessionId,
                        namespace
                    )
                    if (!stopped) {
                        await this.quarantinePiResume(access.sessionId, namespace, targetMachine.id)
                        return {
                            type: 'error',
                            message: spawnResult.message,
                            code: 'resume_failed',
                            rollbackSafe: false,
                        }
                    }
                }
                return { type: 'error', message: spawnResult.message, code: 'resume_failed' }
            }

            if (requiresPiNativeReady && spawnResult.sessionId !== access.sessionId) {
                const removed = await this.terminateUnexpectedPiTemp(
                    targetMachine.id,
                    spawnResult.sessionId,
                    access.sessionId,
                    namespace
                )
                return {
                    type: 'error',
                    message: removed
                        ? 'Pi runner created an unexpected session; upgrade the runner and retry'
                        : 'Pi runner created an unexpected live session; upgrade the runner and retry',
                    code: 'resume_failed'
                }
            }

            const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
            if (!becameActive) {
                if (resumedStartingMode === 'pty') {
                    const current = this.sessionCache.getSessionByNamespace(access.sessionId, namespace)
                    const stopped = current
                        ? await this.reconcilePersistedPtyResumeAttempt(current)
                        : false
                    if (!stopped) {
                        this.ptyResumeQuarantinedIds.add(access.sessionId)
                        return {
                            type: 'error',
                            message: 'PTY resume failed and the child is still active',
                            code: 'resume_failed',
                            rollbackSafe: false,
                        }
                    }
                }
                if (requiresPiNativeReady) {
                    const inactive = await this.terminateInPlacePiResume(
                        targetMachine.id,
                        access.sessionId,
                        namespace
                    )
                    if (!inactive) {
                        await this.quarantinePiResume(access.sessionId, namespace, targetMachine.id)
                        return { type: 'error', message: 'Pi resume failed and the child is still active', code: 'resume_failed', rollbackSafe: false }
                    }
                }
                return { type: 'error', message: 'Session failed to become active', code: 'resume_failed' }
            }

            const needsReadyBeforeSuccess = resumedStartingMode === 'pty'
                || requiresPiNativeReady
                || (
                    spawnResult.sessionId !== access.sessionId
                    && flavor === 'cursor'
                    && metadata.cursorSessionProtocol === 'acp'
                )
            if (needsReadyBeforeSuccess) {
                const readyResult = await this.waitForSessionReady(spawnResult.sessionId)
                if (readyResult !== 'ready') {
                    if (resumedStartingMode === 'pty' && readyResult === 'timeout') {
                        let status: 'stopped' | 'already_gone' | 'still_alive'
                        try {
                            status = await this.rpcGateway.stopRunnerSession(
                                targetMachine.id,
                                spawnResult.sessionId
                            )
                        } catch {
                            status = 'still_alive'
                        }
                        let inactive = false
                        if (status === 'already_gone') {
                            const current = this.sessionCache.getSession(spawnResult.sessionId)
                            if (current?.active) {
                                this.handleSessionEnd({ sid: spawnResult.sessionId, time: Date.now(), reason: 'error' })
                            }
                            inactive = true
                        } else if (status === 'stopped') {
                            inactive = await this.waitForSessionInactive(spawnResult.sessionId)
                        }
                        if (!inactive) {
                            this.ptyResumeQuarantinedIds.add(access.sessionId)
                            try {
                                await this.writePtyResumeAttempt(access.sessionId, namespace, {
                                    state: 'quarantined',
                                    machineId: targetMachine.id,
                                    startedAt: Date.now(),
                                })
                            } catch {
                                // The durable pre-spawn `resuming` marker remains
                                // the restart-safe fail-closed source of truth.
                            }
                            return {
                                type: 'error',
                                message: 'PTY resume timed out and the child is still active',
                                code: 'resume_failed',
                                rollbackSafe: false,
                            }
                        }
                    }
                    if (requiresPiNativeReady && readyResult !== 'ended') {
                        const inactive = await this.terminateInPlacePiResume(
                            targetMachine.id,
                            access.sessionId,
                            namespace
                        )
                        if (!inactive) {
                            await this.quarantinePiResume(access.sessionId, namespace, targetMachine.id)
                            return { type: 'error', message: 'Pi native resume timed out and the child is still active', code: 'resume_failed', rollbackSafe: false }
                        }
                    }
                    if (resumedStartingMode === 'pty') {
                        try {
                            await this.writePtyResumeAttempt(access.sessionId, namespace, null)
                        } catch {
                            this.ptyResumeQuarantinedIds.add(access.sessionId)
                            return {
                                type: 'error',
                                message: 'PTY resume failed and cleanup metadata could not be cleared',
                                code: 'resume_failed',
                                rollbackSafe: false,
                            }
                        }
                    }
                    const message = flavor === 'pi'
                        ? readyResult === 'ended'
                            ? 'Pi session ended before native resume completed'
                            : 'Pi session failed to become native-ready'
                        : resumedStartingMode === 'pty'
                            ? readyResult === 'ended'
                                ? 'Session ended before the agent PTY became ready'
                                : 'Session failed to become ready'
                        : readyResult === 'ended'
                            ? 'Session ended before Cursor ACP load completed'
                            : 'Session failed to become ready'
                    return { type: 'error', message, code: 'resume_failed' }
                }
            }

            if (spawnResult.sessionId !== access.sessionId) {
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
            piResumeSucceeded = true
            if (requiresPiNativeReady) await this.writePiResumeAttempt(access.sessionId, namespace, null)
            if (resumedStartingMode === 'pty') {
                try {
                    await this.writePtyResumeAttempt(access.sessionId, namespace, null)
                    this.ptyResumeQuarantinedIds.delete(access.sessionId)
                } catch {
                    this.ptyResumeQuarantinedIds.add(access.sessionId)
                    return {
                        type: 'error',
                        message: 'PTY resumed but cleanup metadata could not be cleared',
                        code: 'resume_failed',
                        rollbackSafe: false,
                    }
                }
            }
            return { type: 'success', sessionId: spawnResult.sessionId }
        } finally {
            if (resumedStartingMode === 'pty') {
                this.ptyResumeInFlightIds.delete(access.sessionId)
            }
            if (requiresPiNativeReady) {
                this.piResumeInFlightIds.delete(access.sessionId)
                if (!piResumeSucceeded && this.sessionCache.getSession(access.sessionId)?.metadata?.piResumeAttempt?.state === 'resuming') {
                    await this.writePiResumeAttempt(access.sessionId, namespace, null, true).catch(() => {})
                }
                if (piResumeSucceeded) {
                    this.triggerDedupIfNeeded(access.sessionId)
                }
            }
        }
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

        let session = access.session
        if (await this.recoverInactiveReservedClear(session, namespace)) {
            session = this.sessionCache.getSessionByNamespace(sessionId, namespace) ?? session
        }
        let metadata = session.metadata
        const isPtyResume =
            (session.agentState as { startingMode?: 'local' | 'remote' | 'pty' } | null)?.startingMode === 'pty'
        if (isPtyResume && this.ptyResumeInFlightIds.has(access.sessionId)) {
            return { type: 'error', message: 'PTY resume is already in progress', code: 'resume_failed' }
        }

        if (
            this.ptyResumeQuarantinedIds.has(access.sessionId)
            && !metadata?.ptyResumeAttempt
        ) {
            return { type: 'error', message: 'PTY resume cleanup is incomplete', code: 'resume_failed' }
        }
        if (metadata?.ptyResumeAttempt) {
            const reconciled = await this.reconcilePersistedPtyResumeAttempt(session)
            if (!reconciled) {
                return {
                    type: 'error',
                    message: 'PTY resume timed out and the child is still active',
                    code: 'resume_failed',
                }
            }
            this.ptyResumeQuarantinedIds.delete(access.sessionId)
            session = this.sessionCache.getSessionByNamespace(access.sessionId, namespace) ?? session
            metadata = session.metadata
        }

        if (this.isOpenCodeClearSource(session)) {
            return {
                type: 'error',
                message: 'This OpenCode session was replaced by /clear',
                code: 'resume_unavailable'
            }
        }

        if (metadata?.flavor === 'pi' && this.isPiResumeBlocked(access.sessionId)) {
            if (session.active) {
                return { type: 'error', message: 'Pi resume is already in progress', code: 'resume_failed' }
            }
            if (metadata.piResumeAttempt && !this.piResumeInFlightIds.has(access.sessionId)) {
                const reconciled = await this.reconcilePersistedPiResumeAttempt(session)
                return {
                    type: 'error',
                    message: reconciled
                        ? 'Previous Pi resume attempt was cleaned up; retry'
                        : 'Pi resume is already in progress',
                    code: 'resume_failed'
                }
            }
            return { type: 'error', message: 'Pi resume is already in progress', code: 'resume_failed' }
        }

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

            let applied: { cursorSessionProtocol?: 'acp' | 'stream-json' } = {}
            // Pi and PTY resumes both reuse the original HAPI row. Keep the archive
            // snapshot persisted until the CLI successfully bootstraps that row as
            // running; this avoids an inactive, non-archived gap if the Hub restarts
            // before spawn — the in-memory snapshot below cannot survive that, and
            // ptyResumeAttempt carries no copy of it. The CLI's sessionFactory
            // re-stamps lifecycleState='running' on boot and does not carry over
            // archivedBy/archiveReason, so the row still leaves the archived state.
            if (metadata.flavor !== 'pi' && !isPtyResume) {
                try {
                    applied = await this.sessionCache.clearSessionArchiveMetadata(access.sessionId)
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Failed to clear archive metadata'
                    return { type: 'error', message, code: 'metadata_conflict' }
                }
            }

            const resumeResult = await this.resumeSession(access.sessionId, namespace)
            if (resumeResult.type === 'error') {
                // Never restore archived metadata over a live Pi child. A live
                // row blocks retry by itself and must remain visible as active.
                const current = this.sessionCache.getSessionByNamespace(access.sessionId, namespace)
                if (resumeResult.rollbackSafe !== false && !current?.active) {
                    try {
                        await this.sessionCache.restoreSessionArchiveMetadata(access.sessionId, archiveSnapshot)
                    } catch {
                        // Swallow restore failures - the resume error is the more important signal.
                    }
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

            return this.persistRecoveredAgentSessionId(sessionId, namespace, 'claudeSessionId', found)
        }
        return null
    }

    private recoverCodexSessionIdFromMessages(sessionId: string, namespace: string): string | null {
        const messages = this.messageService.getMessages(sessionId, 200)
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const content = messages[i].content
            if (this.isCodexContextResetMessage(content)) return null

            const found = this.extractCodexParentThreadId(content)
            if (!found) continue

            return this.persistRecoveredAgentSessionId(sessionId, namespace, 'codexSessionId', found)
        }
        return null
    }

    private isCodexContextResetMessage(value: unknown): boolean {
        const message = asRecord(value)
        const content = asRecord(message?.content)
        const event = asRecord(content?.data)
        return message?.role === 'agent'
            && content?.type === 'event'
            && event?.type === 'message'
            && event.message === 'Context was reset'
    }

    private extractCodexParentThreadId(value: unknown): string | null {
        const message = asRecord(value)
        const content = asRecord(message?.content)
        const event = asRecord(content?.data)
        if (message?.role !== 'agent' || content?.type !== 'codex' || !event) {
            return null
        }

        const scope = asRecord(event.scope)
        const roles = [event.scope_role, event.scopeRole, scope?.role]
            .filter((role) => role !== undefined)
        if (roles.length === 0 || roles.some((role) => role !== 'parent')) {
            return null
        }

        const threadIds: string[] = []
        for (const threadId of [event.thread_id, event.threadId, scope?.thread_id, scope?.threadId]) {
            if (threadId === undefined) continue

            const normalized = this.normalizeAgentSessionId(threadId)
            if (!normalized) return null
            threadIds.push(normalized)
        }
        const uniqueThreadIds = [...new Set(threadIds)]
        return uniqueThreadIds.length === 1 ? uniqueThreadIds[0] : null
    }

    private extractClaudeSessionId(value: unknown): string | null {
        if (!value || typeof value !== 'object') {
            return null
        }

        const obj = value as Record<string, unknown>
        const direct = this.normalizeAgentSessionId(obj.session_id) ?? this.normalizeAgentSessionId(obj.sessionId)
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

    private normalizeAgentSessionId(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null
        }
        const trimmed = value.trim()
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
            ? trimmed
            : null
    }

    private persistRecoveredAgentSessionId(
        sessionId: string,
        namespace: string,
        field: 'claudeSessionId' | 'codexSessionId',
        agentSessionId: string
    ): string {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return agentSessionId

            const existingAgentSessionId = latest.metadata[field]
            if (typeof existingAgentSessionId === 'string') {
                return existingAgentSessionId
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                { ...latest.metadata, [field]: agentSessionId },
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return agentSessionId
            }
            if (result.result !== 'version-mismatch') {
                return agentSessionId
            }

            this.sessionCache.refreshSession(sessionId)
            const refreshed = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            const authoritativeAgentSessionId = refreshed?.metadata?.[field]
            if (typeof authoritativeAgentSessionId === 'string') {
                return authoritativeAgentSessionId
            }
        }
        return agentSessionId
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
            && (prev?.agySessionId ?? null) === (next.agySessionId ?? null)
            && (prev?.copilotSessionId ?? null) === (next.copilotSessionId ?? null)
    }

    private canRunCursorDedup(session: Session): boolean {
        if (this.piResumeInFlightIds.has(session.id) || this.piResumeQuarantinedIds.has(session.id)) return false
        if (session.metadata?.piResumeAttempt) return false
        if (this.sessionCache.getSessions().some((candidate) => candidate.metadata?.piResumeAttempt?.childSessionId === session.id)) return false
        const piSessionId = session.metadata?.piSessionId
        if (piSessionId && this.sessionCache.getSessions().some((candidate) =>
            candidate.id !== session.id
            && candidate.namespace === session.namespace
            && candidate.metadata?.piResumeAttempt !== undefined
            && candidate.metadata.piSessionId === piSessionId
        )) return false
        if (session.metadata?.flavor !== 'cursor') {
            return true
        }
        if (session.metadata?.cursorSessionProtocol !== 'acp') {
            return true
        }
        return this.sessionReadyIds.has(session.id)
    }

    private async terminateInPlacePiResume(
        machineId: string,
        sessionId: string,
        namespace: string
    ): Promise<boolean> {
        const existingAttempt = this.sessionCache.getSession(sessionId)?.metadata?.piResumeAttempt
        await this.writePiResumeAttempt(sessionId, namespace, {
            ...existingAttempt,
            state: 'terminating',
            machineId,
            startedAt: Date.now(),
        })
        let status: 'stopped' | 'already_gone' | 'still_alive'
        try {
            status = await this.rpcGateway.stopRunnerSession(machineId, sessionId)
        } catch {
            status = 'still_alive'
        }

        await new Promise((resolve) => setTimeout(resolve, 0))
        const session = this.sessionCache.refreshSession(sessionId) ?? this.sessionCache.getSession(sessionId)
        const attemptClearedByEnd = session?.metadata?.piResumeAttempt === undefined
        if (status === 'still_alive') {
            if (attemptClearedByEnd) return true
            return false
        }
        if (session?.active) this.handleSessionEnd({ sid: sessionId, time: Date.now(), reason: 'error' })
        await this.writePiResumeAttempt(sessionId, namespace, null, true).catch(() => {})
        return true
    }

    private async terminateUnexpectedPiTemp(
        machineId: string,
        sessionId: string,
        originalSessionId: string,
        namespace: string
    ): Promise<boolean> {
        this.piUnexpectedTempOriginalIds.set(sessionId, originalSessionId)
        const existingAttempt = this.sessionCache.getSession(originalSessionId)?.metadata?.piResumeAttempt
        await this.writePiResumeAttempt(originalSessionId, namespace, {
            ...existingAttempt,
            state: 'terminating',
            machineId,
            startedAt: Date.now(),
            childSessionId: sessionId,
        })
        let status: 'stopped' | 'already_gone' | 'still_alive'
        try {
            status = await this.rpcGateway.stopRunnerSession(machineId, sessionId)
        } catch {
            status = 'still_alive'
        }

        await new Promise((resolve) => setTimeout(resolve, 0))
        const session = this.sessionCache.refreshSession(sessionId) ?? this.sessionCache.getSession(sessionId)
        const original = this.sessionCache.refreshSession(originalSessionId) ?? this.sessionCache.getSession(originalSessionId)
        const attemptClearedByEnd = original?.metadata?.piResumeAttempt === undefined
        if (status === 'still_alive' && !attemptClearedByEnd) {
            await this.writePiResumeAttempt(originalSessionId, namespace, {
                ...existingAttempt,
                state: 'quarantined',
                machineId,
                startedAt: Date.now(),
                childSessionId: sessionId,
            })
            return false
        }
        if (session?.active) this.handleSessionEnd({ sid: sessionId, time: Date.now(), reason: 'error' })
        const remaining = this.sessionCache.getSession(sessionId)
        if (remaining && !remaining.active) await this.sessionCache.deleteSession(sessionId)
        this.piUnexpectedTempOriginalIds.delete(sessionId)
        await this.writePiResumeAttempt(originalSessionId, namespace, null, true).catch(() => {})
        return true
    }

    private async quarantinePiResume(sessionId: string, namespace: string, machineId: string): Promise<void> {
        this.piResumeQuarantinedIds.add(sessionId)
        const existingAttempt = this.sessionCache.getSession(sessionId)?.metadata?.piResumeAttempt
        await this.writePiResumeAttempt(sessionId, namespace, {
            ...existingAttempt,
            state: 'quarantined',
            machineId,
            startedAt: Date.now(),
        })
    }

    private isPiResumeBlocked(sessionId: string): boolean {
        const metadataAttempt = this.sessionCache.getSession(sessionId)?.metadata?.piResumeAttempt
        return this.piResumeInFlightIds.has(sessionId)
            || this.piResumeQuarantinedIds.has(sessionId)
            || metadataAttempt !== undefined
            || [...this.piUnexpectedTempOriginalIds.values()].includes(sessionId)
    }

    private async writePiResumeAttempt(
        sessionId: string,
        namespace: string,
        attempt: PiResumeAttempt | null,
        restoreArchive = false
    ): Promise<void> {
        for (let i = 0; i < 5; i += 1) {
            const current = this.sessionCache.getSessionByNamespace(sessionId, namespace) ?? this.sessionCache.refreshSession(sessionId)
            if (!current?.metadata) return
            const next = { ...current.metadata }
            if (attempt) next.piResumeAttempt = attempt
            else {
                const snapshot = current.metadata.piResumeAttempt?.archiveSnapshot
                delete next.piResumeAttempt
                if (restoreArchive && snapshot) {
                    if (snapshot.lifecycleState === undefined) delete next.lifecycleState
                    else next.lifecycleState = snapshot.lifecycleState
                    if (snapshot.lifecycleStateSince === undefined) delete next.lifecycleStateSince
                    else next.lifecycleStateSince = snapshot.lifecycleStateSince
                    if (snapshot.archivedBy === undefined) delete next.archivedBy
                    else next.archivedBy = snapshot.archivedBy
                    if (snapshot.archiveReason === undefined) delete next.archiveReason
                    else next.archiveReason = snapshot.archiveReason
                }
            }
            const result = this.store.sessions.updateSessionMetadata(sessionId, next, current.metadataVersion, namespace, { touchUpdatedAt: false })
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result !== 'version-mismatch') throw new Error('Failed to update Pi resume attempt')
            this.sessionCache.refreshSession(sessionId)
        }
        throw new Error('Pi resume attempt metadata was modified concurrently')
    }

    private async clearPiAttemptForEndedSession(endedSessionId: string, restoreArchive: boolean): Promise<void> {
        const ended = this.sessionCache.getSession(endedSessionId)
        if (ended?.metadata?.piResumeAttempt) {
            await this.writePiResumeAttempt(endedSessionId, ended.namespace, null, restoreArchive).catch(() => {})
            return
        }
        for (const session of this.sessionCache.getSessions()) {
            if (session.metadata?.piResumeAttempt?.childSessionId === endedSessionId) {
                await this.writePiResumeAttempt(session.id, session.namespace, null, true).catch(() => {})
            }
        }
    }

    private async writePtyResumeAttempt(
        sessionId: string,
        namespace: string,
        attempt: PtyResumeAttempt | null
    ): Promise<void> {
        for (let i = 0; i < 5; i += 1) {
            const current = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? this.sessionCache.refreshSession(sessionId)
            if (!current?.metadata) throw new Error('PTY resume attempt session metadata is unavailable')
            const next = { ...current.metadata }
            if (attempt) next.ptyResumeAttempt = attempt
            else delete next.ptyResumeAttempt
            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                next,
                current.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result !== 'version-mismatch') throw new Error('Failed to update PTY resume attempt')
            this.sessionCache.refreshSession(sessionId)
        }
        throw new Error('PTY resume attempt metadata was modified concurrently')
    }

    private async reconcilePersistedPtyResumeAttempt(session: Session): Promise<boolean> {
        const attempt = session.metadata?.ptyResumeAttempt
        if (!attempt) return true
        let status: 'stopped' | 'already_gone' | 'still_alive'
        try {
            status = await this.rpcGateway.stopRunnerSession(attempt.machineId, session.id)
        } catch {
            return false
        }
        if (status === 'still_alive') return false

        const current = this.sessionCache.getSession(session.id)
        if (current?.active) {
            this.handleSessionEnd({ sid: session.id, time: Date.now(), reason: 'error' })
        }
        try {
            await this.writePtyResumeAttempt(session.id, session.namespace, null)
            this.ptyResumeQuarantinedIds.delete(session.id)
            return true
        } catch {
            this.ptyResumeQuarantinedIds.add(session.id)
            return false
        }
    }

    private async reconcilePersistedPiResumeAttempt(session: Session): Promise<boolean> {
        const attempt = session.metadata?.piResumeAttempt
        if (!attempt) return true
        const childSessionId = attempt.childSessionId ?? session.id
        let status: 'stopped' | 'already_gone' | 'still_alive'
        try {
            status = await this.rpcGateway.stopRunnerSession(attempt.machineId, childSessionId)
        } catch {
            return false
        }
        if (status === 'still_alive') return false

        const child = this.sessionCache.getSession(childSessionId)
        if (child?.active) this.handleSessionEnd({ sid: childSessionId, time: Date.now(), reason: 'error' })
        if (childSessionId !== session.id) {
            const remaining = this.sessionCache.getSession(childSessionId)
            if (remaining && !remaining.active) await this.sessionCache.deleteSession(childSessionId)
        }
        await this.writePiResumeAttempt(session.id, session.namespace, null, true)
        this.piResumeQuarantinedIds.delete(session.id)
        this.piUnexpectedTempOriginalIds.delete(childSessionId)
        return true
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

    async listMachineDirectory(machineId: string, path: string, includeHidden?: boolean): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listMachineDirectory(machineId, path, includeHidden)
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

    async statFiles(sessionId: string, paths: string[]): Promise<RpcStatFilesResponse> {
        return await this.rpcGateway.statFiles(sessionId, paths)
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

    async listAgyModelsForMachine(machineId: string): Promise<RpcListAgyModelsResponse> {
        return await this.rpcGateway.listAgyModelsForMachine(machineId)
    }

    async listCodexModelsForMachine(machineId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForMachine(machineId)
    }

    async listCodexSessionsForMachine(machineId: string, cwd?: string | null, sessionIds?: string[]) {
        return await this.rpcGateway.listCodexSessionsForMachine(machineId, cwd, sessionIds)
    }

    async listPiSessionsForMachine(machineId: string, cwd?: string | null, sessionIds?: string[]): Promise<RpcListPiSessionsResponse> {
        return await this.rpcGateway.listPiSessionsForMachine(machineId, cwd, sessionIds)
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

    async listCopilotModelsForCwd(machineId: string, cwd: string): Promise<RpcListCopilotModelsResponse> {
        return await this.rpcGateway.listCopilotModelsForCwd(machineId, cwd)
    }

    async listCopilotModelsForSession(sessionId: string): Promise<RpcListCopilotModelsResponse> {
        return await this.rpcGateway.listCopilotModelsForSession(sessionId)
    }

    /** Generic Pi RPC — delegates to rpcGateway.callPiRpc. */
    async callPiRpc<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
        return await this.rpcGateway.callPiRpc<T>(sessionId, method, params, timeoutMs)
    }

    async listOpencodeReasoningEffortOptionsForSession(sessionId: string): Promise<RpcListOpencodeReasoningEffortOptionsResponse> {
        return await this.rpcGateway.listOpencodeReasoningEffortOptionsForSession(sessionId)
    }
}
