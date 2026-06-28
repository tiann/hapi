import { AgentStateSchema, MetadataSchema, TeamStateSchema } from '@hapi/protocol/schemas'
import type { CodexCollaborationMode, PermissionMode, Session, SessionPatch } from '@hapi/protocol/types'
import type { Store } from '../store'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'
import { extractTodoWriteTodosFromMessageContent, TodosSchema } from './todos'
import { extractBackgroundTaskDelta } from './backgroundTasks'

const QUEUED_MESSAGE_THINKING_GRACE_MS = 15_000
// tiann/hapi#919: metadata writers (renameSession, clearSessionArchiveMetadata,
// restoreSessionArchiveMetadata) retry on version-mismatch with a fresh cache
// snapshot. Cap retries so genuine concurrent contention still surfaces to the
// HTTP caller as 409 instead of spinning forever.
const METADATA_RETRY_ATTEMPTS = 5
type RuntimeConfigKey = 'permissionMode' | 'model' | 'modelReasoningEffort' | 'effort' | 'serviceTier' | 'collaborationMode'

export class SessionCache {
    private readonly sessions: Map<string, Session> = new Map()
    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()
    private readonly deduplicateInProgress: Set<string> = new Set()
    private readonly deduplicatePending: Set<string> = new Set()
    private readonly pendingThinkingUntilBySessionId: Map<string, number> = new Map()
    private readonly runtimeConfigUpdatedAtBySessionId: Map<string, Partial<Record<RuntimeConfigKey, number>>> = new Map()

    constructor(
        private readonly store: Store,
        private readonly publisher: EventPublisher
    ) {
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.getSessions().filter((session) => session.namespace === namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessions.get(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (session) {
            if (session.namespace !== namespace) {
                return { ok: false, reason: 'access-denied' }
            }
            return { ok: true, sessionId, session }
        }

        return { ok: false, reason: 'not-found' }
    }

    getActiveSessions(): Session[] {
        return this.getSessions().filter((session) => session.active)
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
        const stored = this.store.sessions.getOrCreateSession(
            tag,
            metadata,
            agentState,
            namespace,
            model,
            effort,
            modelReasoningEffort,
            requestedId
        )
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    refreshSession(sessionId: string): Session | null {
        let stored = this.store.sessions.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            this.pendingThinkingUntilBySessionId.delete(sessionId)
            this.runtimeConfigUpdatedAtBySessionId.delete(sessionId)
            if (existed) {
                this.publisher.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)

        if (stored.todos === null && !this.todoBackfillAttemptedSessionIds.has(sessionId)) {
            this.todoBackfillAttemptedSessionIds.add(sessionId)
            const messages = this.store.messages.getMessages(sessionId, 200)
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const message = messages[i]
                const todos = extractTodoWriteTodosFromMessageContent(message.content)
                if (todos) {
                    const updated = this.store.sessions.setSessionTodos(sessionId, todos, message.createdAt, stored.namespace)
                    if (updated) {
                        stored = this.store.sessions.getSession(sessionId) ?? stored
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

        const teamState = (() => {
            if (stored.teamState === null || stored.teamState === undefined) return undefined
            const parsed = TeamStateSchema.safeParse(stored.teamState)
            return parsed.success ? parsed.data : undefined
        })()

        const session: Session = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: existing?.active ?? stored.active,
            // Legacy / idle rows may still have active_at NULL in SQLite.
            // Public Session.activeAt is always a number for CLI Zod parse.
            activeAt: existing?.activeAt
                ?? stored.activeAt
                ?? stored.updatedAt
                ?? stored.createdAt
                ?? 0,
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: existing?.thinking ?? false,
            thinkingAt: existing?.thinkingAt ?? 0,
            backgroundTaskCount: existing?.backgroundTaskCount ?? 0,
            todos,
            teamState,
            model: stored.model,
            modelReasoningEffort: stored.modelReasoningEffort,
            effort: stored.effort,
            serviceTier: stored.serviceTier,
            permissionMode: existing?.permissionMode ?? metadata?.preferredPermissionMode,
            collaborationMode: existing?.collaborationMode
        }

        this.sessions.set(sessionId, session)
        this.publisher.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: session })
        return session
    }

    reloadAll(): void {
        const sessions = this.store.sessions.getSessions()
        for (const session of sessions) {
            this.refreshSession(session.id)
        }
    }

    markSessionActive(sessionId: string, time: number = Date.now()): void {
        const t = clampAliveTime(time) ?? Date.now()
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) return

        const wasActive = session.active
        session.active = true
        session.activeAt = Math.max(session.activeAt, t)

        this.lastBroadcastAtBySessionId.set(session.id, Date.now())
        this.publisher.emit({
            type: 'session-updated',
            sessionId: session.id,
            namespace: session.namespace,
            data: {
                active: true,
                activeAt: session.activeAt,
                thinking: session.thinking
            } satisfies SessionPatch
        })

        if (!wasActive) {
            this.refreshSession(sessionId)
        }
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
        const t = clampAliveTime(payload.time)
        if (!t) return

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        const wasActive = session.active
        const wasThinking = session.thinking
        const previousPermissionMode = session.permissionMode
        const previousModel = session.model
        const previousModelReasoningEffort = session.modelReasoningEffort
        const previousEffort = session.effort
        const previousServiceTier = session.serviceTier
        const previousCollaborationMode = session.collaborationMode
        const pendingThinkingUntil = this.pendingThinkingUntilBySessionId.get(session.id) ?? 0
        const requestedThinking = Boolean(payload.thinking)
        const hubNow = Date.now()
        const preserveQueuedThinking = !requestedThinking && pendingThinkingUntil > hubNow

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        session.thinking = requestedThinking || preserveQueuedThinking
        session.thinkingAt = t
        if (requestedThinking || pendingThinkingUntil <= hubNow) {
            this.pendingThinkingUntilBySessionId.delete(session.id)
        }
        if (payload.permissionMode !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'permissionMode', t)) {
            session.permissionMode = payload.permissionMode
            this.persistPreferredPermissionMode(session, payload.permissionMode)
        }
        if (payload.model !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'model', t)) {
            if (payload.model !== session.model) {
                this.store.sessions.setSessionModel(payload.sid, payload.model, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.model = payload.model
        }
        if (payload.modelReasoningEffort !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'modelReasoningEffort', t)) {
            if (payload.modelReasoningEffort !== session.modelReasoningEffort) {
                this.store.sessions.setSessionModelReasoningEffort(payload.sid, payload.modelReasoningEffort, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.modelReasoningEffort = payload.modelReasoningEffort
        }
        if (payload.effort !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'effort', t)) {
            if (payload.effort !== session.effort) {
                this.store.sessions.setSessionEffort(payload.sid, payload.effort, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.effort = payload.effort
        }
        if (payload.serviceTier !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'serviceTier', t)) {
            if (payload.serviceTier !== session.serviceTier) {
                this.store.sessions.setSessionServiceTier(payload.sid, payload.serviceTier, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.serviceTier = payload.serviceTier
        }
        if (payload.collaborationMode !== undefined && !this.isStaleRuntimeKeepAlive(session.id, 'collaborationMode', t)) {
            session.collaborationMode = payload.collaborationMode
        }

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        const modeChanged = previousPermissionMode !== session.permissionMode
            || previousModel !== session.model
            || previousModelReasoningEffort !== session.modelReasoningEffort
            || previousEffort !== session.effort
            || previousServiceTier !== session.serviceTier
            || previousCollaborationMode !== session.collaborationMode
        const shouldBroadcast = (!wasActive && session.active)
            || (wasThinking !== session.thinking)
            || modeChanged
            || (now - lastBroadcastAt > 10_000)

        if (shouldBroadcast) {
            this.lastBroadcastAtBySessionId.set(session.id, now)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    active: true,
                    activeAt: session.activeAt,
                    thinking: session.thinking,
                    permissionMode: session.permissionMode,
                    model: session.model,
                    modelReasoningEffort: session.modelReasoningEffort,
                    effort: session.effort,
                    serviceTier: session.serviceTier,
                    collaborationMode: session.collaborationMode
                } satisfies SessionPatch
            })
        }
    }

    /**
     * Drop the queued-message thinking grace timer for a session.
     *
     * `markMessageQueued` sets a 15s grace during which we keep `thinking=true`
     * even if the CLI sends `keepAlive(thinking=false)` — that grace exists to
     * cover the gap between the user POSTing a prompt and the CLI starting to
     * stream. Sessions that handle the message synchronously (e.g. slash
     * commands intercepted in `onUserMessage`) never call onThinkingChange and
     * would otherwise leave the spinner stuck for the full grace window. The
     * messages-consumed socket event signals the CLI has finished its
     * synchronous handling, so it's safe to drop the grace.
     */
    clearQueuedThinkingGrace(sessionId: string): void {
        this.pendingThinkingUntilBySessionId.delete(sessionId)
    }

    markMessageQueued(sessionId: string, time: number = Date.now()): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) return
        if (!session.active) return

        const nextTime = clampAliveTime(time) ?? Date.now()
        const wasThinking = session.thinking
        const previousUpdatedAt = session.updatedAt

        session.thinking = true
        session.thinkingAt = nextTime
        session.updatedAt = Math.max(session.updatedAt, nextTime)
        this.pendingThinkingUntilBySessionId.set(session.id, nextTime + QUEUED_MESSAGE_THINKING_GRACE_MS)

        if (!wasThinking || session.updatedAt !== previousUpdatedAt) {
            this.lastBroadcastAtBySessionId.set(session.id, Date.now())
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    thinking: true,
                    updatedAt: session.updatedAt
                } satisfies SessionPatch
            })
        }
    }

    applyBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        const session = this.sessions.get(sessionId)
        if (!session) return

        const prev = session.backgroundTaskCount ?? 0
        const next = Math.max(0, prev + delta.started - delta.completed)
        if (next === prev) return

        session.backgroundTaskCount = next
        this.publisher.emit({
            type: 'session-updated',
            sessionId,
            data: { backgroundTaskCount: next } satisfies SessionPatch
        })
    }

    recordSessionActivity(sessionId: string, updatedAt: number): void {
        if (!Number.isFinite(updatedAt)) {
            return
        }

        const stored = this.store.sessions.getSession(sessionId)
        if (!stored) {
            return
        }

        const nextUpdatedAt = Math.max(stored.updatedAt, updatedAt)
        const touched = this.store.sessions.touchSessionUpdatedAt(sessionId, nextUpdatedAt, stored.namespace)
        const session = this.sessions.get(sessionId)

        if (!session) {
            if (touched) {
                this.refreshSession(sessionId)
            }
            return
        }

        if (nextUpdatedAt <= session.updatedAt && !touched) {
            return
        }

        session.updatedAt = Math.max(session.updatedAt, nextUpdatedAt)
        this.publisher.emit({
            type: 'session-updated',
            sessionId,
            namespace: session.namespace,
            data: { updatedAt: session.updatedAt } satisfies SessionPatch
        })
    }

    handleSessionEnd(payload: { sid: string; time: number }): void {
        const t = clampAliveTime(payload.time) ?? Date.now()

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        if (!session.active && !session.thinking) {
            return
        }

        session.active = false
        this.store.sessions.setSessionActive(session.id, false, t, session.namespace)
        session.thinking = false
        session.thinkingAt = t
        session.backgroundTaskCount = 0
        this.pendingThinkingUntilBySessionId.delete(session.id)

        this.publisher.emit({
            type: 'session-updated',
            sessionId: session.id,
            data: { active: false, thinking: false, backgroundTaskCount: 0 } satisfies SessionPatch
        })
    }

    expireInactive(now: number = Date.now()): string[] {
        const sessionTimeoutMs = 30_000
        const expired: string[] = []

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            session.active = false
            this.store.sessions.setSessionActive(session.id, false, now, session.namespace)
            session.thinking = false
            this.pendingThinkingUntilBySessionId.delete(session.id)
            expired.push(session.id)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: { active: false } satisfies SessionPatch
            })
        }

        return expired
    }

    applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: { provider: string; modelId: string } | string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            serviceTier?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) {
            return
        }

        const appliedAt = Date.now()
        if (config.permissionMode !== undefined) {
            session.permissionMode = config.permissionMode
            this.persistPreferredPermissionMode(session, config.permissionMode)
            this.markRuntimeConfigUpdated(sessionId, 'permissionMode', appliedAt)
        }
        if (config.model !== undefined) {
            const modelValue = config.model
            // Normalize object form { provider, modelId } to plain string for DB storage
            const piModelObject = modelValue !== null && typeof modelValue === 'object'
                ? modelValue
                : null
            const normalizedModel: string | null = piModelObject ? piModelObject.modelId : modelValue as string | null
            if (normalizedModel !== session.model) {
                const updated = this.store.sessions.setSessionModel(sessionId, normalizedModel, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session model')
                }
            }
            session.model = normalizedModel
            // Pi requires provider + modelId to uniquely identify a model.
            // Persist the provider-qualified form in metadata so web can
            // resolve the exact model even when two providers share a modelId.
            if (session.metadata?.flavor === 'pi') {
                this.persistPiSelectedModel(session, piModelObject)
            }
            this.markRuntimeConfigUpdated(sessionId, 'model', appliedAt)
        }
        if (config.modelReasoningEffort !== undefined) {
            if (config.modelReasoningEffort !== session.modelReasoningEffort) {
                const updated = this.store.sessions.setSessionModelReasoningEffort(sessionId, config.modelReasoningEffort, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session model reasoning effort')
                }
            }
            session.modelReasoningEffort = config.modelReasoningEffort
            this.markRuntimeConfigUpdated(sessionId, 'modelReasoningEffort', appliedAt)
        }
        if (config.effort !== undefined) {
            if (config.effort !== session.effort) {
                const updated = this.store.sessions.setSessionEffort(sessionId, config.effort, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session effort')
                }
            }
            session.effort = config.effort
            this.markRuntimeConfigUpdated(sessionId, 'effort', appliedAt)
        }
        if (config.serviceTier !== undefined) {
            if (config.serviceTier !== session.serviceTier) {
                const updated = this.store.sessions.setSessionServiceTier(sessionId, config.serviceTier, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session service tier')
                }
            }
            session.serviceTier = config.serviceTier
            this.markRuntimeConfigUpdated(sessionId, 'serviceTier', appliedAt)
        }
        if (config.collaborationMode !== undefined) {
            session.collaborationMode = config.collaborationMode
            this.markRuntimeConfigUpdated(sessionId, 'collaborationMode', appliedAt)
        }

        this.publisher.emit({ type: 'session-updated', sessionId, data: session })
    }

    private markRuntimeConfigUpdated(
        sessionId: string,
        key: RuntimeConfigKey,
        at: number
    ): void {
        const existing = this.runtimeConfigUpdatedAtBySessionId.get(sessionId) ?? {}
        existing[key] = at
        this.runtimeConfigUpdatedAtBySessionId.set(sessionId, existing)
    }

    private isStaleRuntimeKeepAlive(
        sessionId: string,
        key: RuntimeConfigKey,
        payloadTime: number
    ): boolean {
        const updatedAt = this.runtimeConfigUpdatedAtBySessionId.get(sessionId)?.[key]
        return updatedAt !== undefined && payloadTime < updatedAt
    }

    /**
     * tiann/hapi#916: hub-side write of the archive-metadata fields normally
     * authored by the CLI's `archiveAndClose`. Called by `syncEngine.archiveSession`
     * when the kill-RPC fails because the CLI is unreachable (e.g. the
     * hub-restart cascade already killed it). Without this, the route would
     * either 500 (pre-fix) or silently return ok=true while leaving
     * `lifecycleState=running` on disk — both confuse the operator.
     *
     * Idempotent: if `lifecycleState` is already `archived` we return without
     * touching the row to avoid resetting `lifecycleStateSince`. Best-effort:
     * if every retry hits `version-mismatch` (genuine contention) the original
     * `archiveSession` flow still marks the session inactive in cache via
     * `handleSessionEnd`, just without flipping the persisted lifecycle.
     */
    markSessionArchivedFromHub(sessionId: string, reason: string): void {
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) return
            const current = session.metadata
            if (!current) return
            if (current.lifecycleState === 'archived') {
                return
            }

            const next: Record<string, unknown> = {
                ...current,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'hub',
                archiveReason: reason
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                next,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                // tiann/hapi#916 review feedback: persistence failure must
                // surface so the route returns 5xx. Silently returning here
                // would let `/archive` claim success while the row stays
                // unarchived in the DB.
                throw new Error('Failed to archive session metadata from hub')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return
            }

            this.refreshSession(sessionId)
        }

        // tiann/hapi#916 review feedback: exhausted retries means we never
        // got a successful write. Match the renameSession / mergeSessions
        // contract and surface this as an error so non-RPC failures stay
        // 5xx per the issue's acceptance criteria.
        throw new Error('Session was modified concurrently while archiving from hub')
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        // tiann/hapi#919: retry-with-refresh on version-mismatch instead of
        // throwing on the first contention. Mirrors the good pattern in
        // mergeSessions (~L780) and in syncEngine's metadata helpers. Without
        // this, a stale cache snapshot produces forever-409 on PATCH /sessions/:id
        // until some unrelated event triggers a refresh.
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) {
                throw new Error('Session not found')
            }

            const currentMetadata = session.metadata ?? { path: '', host: '' }
            const newMetadata = { ...currentMetadata, name }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                newMetadata,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                throw new Error('Failed to update session metadata')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return
            }

            this.refreshSession(sessionId)
        }

        throw new Error('Session was modified concurrently. Please try again.')
    }

    /**
     * Clear archive-related metadata on an archived session so it can be resumed.
     * - Removes `lifecycleState`, `archivedBy`, `archiveReason`, and stamps
     *   `lifecycleStateSince` so subsequent CLI lifecycle writes still win on time.
     * - For Cursor sessions that pre-date #799 (no `cursorSessionProtocol` set, but a
     *   `cursorSessionId` exists) defaults the protocol to `stream-json` so routing
     *   reaches the legacy launcher instead of the new ACP path.
     *
     * Returns the protocol that was applied (or already present) for cursor sessions,
     * or `undefined` for other flavors. Throws on version mismatch / store error.
     * No-op when metadata is null (callers should pre-check).
     */
    async clearSessionArchiveMetadata(sessionId: string): Promise<{ cursorSessionProtocol?: 'acp' | 'stream-json' }> {
        // tiann/hapi#919: retry-with-refresh on version-mismatch. The reopen
        // flow runs this on every archived-session resume — a stale snapshot
        // here used to forever-409 the only reopen affordance.
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) {
                throw new Error('Session not found')
            }

            const currentMetadata = session.metadata
            if (!currentMetadata) {
                throw new Error('Session metadata missing')
            }

            const next: Record<string, unknown> = { ...currentMetadata }
            delete next.lifecycleState
            delete next.archivedBy
            delete next.archiveReason
            next.lifecycleStateSince = Date.now()

            let cursorSessionProtocol: 'acp' | 'stream-json' | undefined
            if (currentMetadata.flavor === 'cursor') {
                const existing = currentMetadata.cursorSessionProtocol
                if (existing === 'acp' || existing === 'stream-json') {
                    cursorSessionProtocol = existing
                } else if (currentMetadata.cursorSessionId) {
                    // Pre-#799 default: presence of cursorSessionId without protocol means stream-json.
                    cursorSessionProtocol = 'stream-json'
                    next.cursorSessionProtocol = 'stream-json'
                }
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                next,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                throw new Error('Failed to update session metadata')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return cursorSessionProtocol ? { cursorSessionProtocol } : {}
            }

            this.refreshSession(sessionId)
        }

        throw new Error('Session was modified concurrently. Please try again.')
    }

    /**
     * Restore archive-related metadata fields that were captured before a reopen attempt.
     * Used when `resumeSession` fails after `clearSessionArchiveMetadata` already ran so the
     * session does not drift into a "not archived, not active" zombie state.
     *
     * Restores the four archive fields **exactly**: if a field was present in the snapshot
     * it is written, if it was absent it is deleted (covering the case where
     * `clearSessionArchiveMetadata` stamped a fresh `lifecycleStateSince` on a row that did
     * not have one originally). Other concurrent edits (e.g. a rename in flight) are
     * preserved. Returns silently if the session is gone or its metadata is unset; throws
     * on version mismatch so the caller can decide whether to retry.
     */
    async restoreSessionArchiveMetadata(
        sessionId: string,
        snapshot: {
            lifecycleState?: string
            archivedBy?: string
            archiveReason?: string
            lifecycleStateSince?: number
        }
    ): Promise<void> {
        // tiann/hapi#919: retry-with-refresh on version-mismatch. This is the
        // /reopen rollback path — if it fails the session is left in a
        // half-cleared archive state, so making it robust to a stale snapshot
        // matters more here than for the other two.
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
            if (!session) return
            const current = session.metadata
            if (!current) return

            const next: Record<string, unknown> = { ...current }
            if (snapshot.lifecycleState !== undefined) {
                next.lifecycleState = snapshot.lifecycleState
            } else {
                delete next.lifecycleState
            }
            if (snapshot.archivedBy !== undefined) {
                next.archivedBy = snapshot.archivedBy
            } else {
                delete next.archivedBy
            }
            if (snapshot.archiveReason !== undefined) {
                next.archiveReason = snapshot.archiveReason
            } else {
                delete next.archiveReason
            }
            if (snapshot.lifecycleStateSince !== undefined) {
                next.lifecycleStateSince = snapshot.lifecycleStateSince
            } else {
                delete next.lifecycleStateSince
            }

            const result = this.store.sessions.updateSessionMetadata(
                sessionId,
                next,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )

            if (result.result === 'error') {
                throw new Error('Failed to restore archive metadata')
            }

            if (result.result === 'success') {
                this.refreshSession(sessionId)
                return
            }

            this.refreshSession(sessionId)
        }

        throw new Error('Session was modified concurrently during reopen rollback')
    }

    async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        if (session.active) {
            throw new Error('Cannot delete active session')
        }

        const deleted = this.store.sessions.deleteSession(sessionId, session.namespace)
        if (!deleted) {
            throw new Error('Failed to delete session')
        }

        this.sessions.delete(sessionId)
        this.lastBroadcastAtBySessionId.delete(sessionId)
        this.todoBackfillAttemptedSessionIds.delete(sessionId)
        this.pendingThinkingUntilBySessionId.delete(sessionId)

        this.publisher.emit({ type: 'session-removed', sessionId, namespace: session.namespace })
    }

    async mergeSessions(oldSessionId: string, newSessionId: string, namespace: string): Promise<void> {
        await this.mergeSessionData(oldSessionId, newSessionId, namespace, { deleteOldSession: true })
    }

    async mergeSessionHistory(
        oldSessionId: string,
        newSessionId: string,
        namespace: string,
        options: { mergeAgentState?: boolean } = {}
    ): Promise<void> {
        await this.mergeSessionData(oldSessionId, newSessionId, namespace, {
            deleteOldSession: false,
            mergeAgentState: options.mergeAgentState ?? true
        })
    }

    private async mergeSessionData(
        oldSessionId: string,
        newSessionId: string,
        namespace: string,
        options: { deleteOldSession: boolean; mergeAgentState?: boolean }
    ): Promise<void> {
        if (oldSessionId === newSessionId) {
            return
        }

        const oldStored = this.store.sessions.getSessionByNamespace(oldSessionId, namespace)
        const newStored = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
        if (!oldStored || !newStored) {
            throw new Error('Session not found for merge')
        }

        const movedMessages = this.store.messages.mergeSessionMessages(oldSessionId, newSessionId)
        if (movedMessages.moved > 0) {
            if (!options.deleteOldSession) {
                this.publisher.emit({ type: 'messages-invalidated', sessionId: oldSessionId, namespace })
            }
            this.publisher.emit({ type: 'messages-invalidated', sessionId: newSessionId, namespace })
        }

        const mergedMetadata = this.mergeSessionMetadata(oldStored.metadata, newStored.metadata)
        if (mergedMetadata !== null && mergedMetadata !== newStored.metadata) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const latest = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
                if (!latest) break
                const result = this.store.sessions.updateSessionMetadata(
                    newSessionId,
                    mergedMetadata,
                    latest.metadataVersion,
                    namespace,
                    { touchUpdatedAt: false }
                )
                if (result.result === 'success') {
                    break
                }
                if (result.result === 'error') {
                    break
                }
            }
        }

        if (newStored.model === null && oldStored.model !== null) {
            const updated = this.store.sessions.setSessionModel(newSessionId, oldStored.model, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session model during merge')
            }
        }

        if (newStored.modelReasoningEffort === null && oldStored.modelReasoningEffort !== null) {
            const updated = this.store.sessions.setSessionModelReasoningEffort(newSessionId, oldStored.modelReasoningEffort, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session model reasoning effort during merge')
            }
        }

        if (newStored.effort === null && oldStored.effort !== null) {
            const updated = this.store.sessions.setSessionEffort(newSessionId, oldStored.effort, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session effort during merge')
            }
        }

        if (newStored.serviceTier === null && oldStored.serviceTier !== null) {
            const updated = this.store.sessions.setSessionServiceTier(newSessionId, oldStored.serviceTier, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session service tier during merge')
            }
        }

        if (oldStored.todos !== null && oldStored.todosUpdatedAt !== null) {
            this.store.sessions.setSessionTodos(
                newSessionId,
                oldStored.todos,
                oldStored.todosUpdatedAt,
                namespace
            )
        }

        // Merge agentState: union requests/completedRequests from both sessions so pending
        // approvals on inactive duplicates are not lost. Active duplicates keep their
        // own agentState because permission approve/deny RPCs are routed by session id.
        // Read the latest target state right before writing to avoid overwriting live updates.
        if ((options.mergeAgentState ?? true) && oldStored.agentState !== null) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const latest = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
                if (!latest) break
                const mergedAgentState = this.mergeAgentState(oldStored.agentState, latest.agentState)
                if (mergedAgentState === null || mergedAgentState === latest.agentState) break
                const result = this.store.sessions.updateSessionAgentState(
                    newSessionId,
                    mergedAgentState,
                    latest.agentStateVersion,
                    namespace
                )
                if (result.result !== 'version-mismatch') break
                // version-mismatch: retry with fresh snapshot
            }
        }

        if (oldStored.teamState !== null && oldStored.teamStateUpdatedAt !== null) {
            this.store.sessions.setSessionTeamState(
                newSessionId,
                oldStored.teamState,
                oldStored.teamStateUpdatedAt,
                namespace
            )
        }

        if (options.deleteOldSession) {
            const deleted = this.store.sessions.deleteSession(oldSessionId, namespace)
            if (!deleted) {
                throw new Error('Failed to delete old session during merge')
            }

            const existed = this.sessions.delete(oldSessionId)
            if (existed) {
                this.publisher.emit({ type: 'session-removed', sessionId: oldSessionId, namespace })
            }
            this.lastBroadcastAtBySessionId.delete(oldSessionId)
            this.todoBackfillAttemptedSessionIds.delete(oldSessionId)
        } else {
            this.refreshSession(oldSessionId)
        }

        const refreshed = this.refreshSession(newSessionId)
        if (refreshed) {
            this.publisher.emit({ type: 'session-updated', sessionId: newSessionId, data: refreshed })
        }
    }

    private mergeSessionMetadata(oldMetadata: unknown | null, newMetadata: unknown | null): unknown | null {
        if (!oldMetadata || typeof oldMetadata !== 'object') {
            return newMetadata
        }
        if (!newMetadata || typeof newMetadata !== 'object') {
            return oldMetadata
        }

        const oldObj = oldMetadata as Record<string, unknown>
        const newObj = newMetadata as Record<string, unknown>
        const merged: Record<string, unknown> = { ...newObj }
        let changed = false

        if (typeof oldObj.name === 'string' && typeof newObj.name !== 'string') {
            merged.name = oldObj.name
            changed = true
        }

        const oldSummary = oldObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const newSummary = newObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const oldUpdatedAt = typeof oldSummary?.updatedAt === 'number' ? oldSummary.updatedAt : null
        const newUpdatedAt = typeof newSummary?.updatedAt === 'number' ? newSummary.updatedAt : null
        if (oldUpdatedAt !== null && (newUpdatedAt === null || oldUpdatedAt > newUpdatedAt)) {
            merged.summary = oldSummary
            changed = true
        }

        if (oldObj.worktree && !newObj.worktree) {
            merged.worktree = oldObj.worktree
            changed = true
        }

        if (typeof oldObj.path === 'string' && typeof newObj.path !== 'string') {
            merged.path = oldObj.path
            changed = true
        }
        if (typeof oldObj.host === 'string' && typeof newObj.host !== 'string') {
            merged.host = oldObj.host
            changed = true
        }
        if (typeof oldObj.preferredPermissionMode === 'string' && typeof newObj.preferredPermissionMode !== 'string') {
            merged.preferredPermissionMode = oldObj.preferredPermissionMode
            changed = true
        }

        return changed ? merged : newMetadata
    }

    private persistPreferredPermissionMode(session: Session, permissionMode: PermissionMode): void {
        const currentMetadata = session.metadata
        if (!currentMetadata || currentMetadata.preferredPermissionMode === permissionMode) {
            return
        }

        const nextMetadata = { ...currentMetadata, preferredPermissionMode: permissionMode }
        const result = this.store.sessions.updateSessionMetadata(
            session.id,
            nextMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )

        if (result.result === 'error') {
            return
        }

        const parsed = MetadataSchema.safeParse(result.value)
        if (!parsed.success) {
            return
        }

        session.metadata = parsed.data
        session.metadataVersion = result.version
    }

    private persistPiSelectedModel(session: Session, piSelected: { provider: string; modelId: string } | null): void {
        const currentMetadata = session.metadata
        if (!currentMetadata || currentMetadata.piSelectedModel === piSelected) {
            return
        }

        const nextMetadata = { ...currentMetadata, piSelectedModel: piSelected }
        const result = this.store.sessions.updateSessionMetadata(
            session.id,
            nextMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )

        if (result.result === 'error') {
            return
        }

        const parsed = MetadataSchema.safeParse(result.value)
        if (!parsed.success) {
            return
        }

        session.metadata = parsed.data
        session.metadataVersion = result.version
    }

    private mergeAgentState(oldState: unknown | null, newState: unknown | null): unknown | null {
        if (oldState === null) return newState
        if (newState === null) return oldState

        const oldObj = oldState as Record<string, unknown>
        const newObj = newState as Record<string, unknown>

        const completedRequests = {
            ...((oldObj.completedRequests as Record<string, unknown> | undefined) ?? {}),
            ...((newObj.completedRequests as Record<string, unknown> | undefined) ?? {})
        }
        // Filter out requests that are already completed to avoid resurrecting them as pending
        const completedIds = new Set(Object.keys(completedRequests))
        const requests = Object.fromEntries(
            Object.entries({
                ...((oldObj.requests as Record<string, unknown> | undefined) ?? {}),
                ...((newObj.requests as Record<string, unknown> | undefined) ?? {})
            }).filter(([id]) => !completedIds.has(id))
        )

        return { ...oldObj, ...newObj, requests, completedRequests }
    }

    private extractAgentSessionId(
        metadata: NonNullable<Session['metadata']>
    ): { field: 'codexSessionId' | 'claudeSessionId' | 'geminiSessionId' | 'opencodeSessionId' | 'grokSessionId' | 'cursorSessionId' | 'piSessionId'; value: string } | null {
        if (metadata.codexSessionId) return { field: 'codexSessionId', value: metadata.codexSessionId }
        if (metadata.claudeSessionId) return { field: 'claudeSessionId', value: metadata.claudeSessionId }
        if (metadata.geminiSessionId) return { field: 'geminiSessionId', value: metadata.geminiSessionId }
        if (metadata.opencodeSessionId) return { field: 'opencodeSessionId', value: metadata.opencodeSessionId }
        if (metadata.grokSessionId) return { field: 'grokSessionId', value: metadata.grokSessionId }
        if (metadata.cursorSessionId) return { field: 'cursorSessionId', value: metadata.cursorSessionId }
        if (metadata.piSessionId) return { field: 'piSessionId', value: metadata.piSessionId }
        return null
    }

    async deduplicateByAgentSessionId(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session?.metadata) return

        const agentId = this.extractAgentSessionId(session.metadata)
        if (!agentId) return

        // Guard: if another dedup for this agent ID is already in progress,
        // coalesce this trigger and run one more pass afterwards. This matters
        // for active duplicates: a session can become inactive while the first
        // pass is only allowed to move history, and the follow-up pass should
        // then be allowed to delete the inactive duplicate record.
        if (this.deduplicateInProgress.has(agentId.value)) {
            this.deduplicatePending.add(agentId.value)
            return
        }
        this.deduplicateInProgress.add(agentId.value)

        try {
            do {
                this.deduplicatePending.delete(agentId.value)

                const currentSession = this.sessions.get(sessionId)
                const candidates: { id: string; session: Session }[] = []
                if (currentSession?.metadata && currentSession.metadata[agentId.field] === agentId.value) {
                    candidates.push({ id: sessionId, session: currentSession })
                }
                for (const [existingId, existing] of this.sessions) {
                    if (existingId === sessionId) continue
                    if (existing.namespace !== session.namespace) continue
                    if (!existing.metadata) continue
                    if (existing.metadata[agentId.field] !== agentId.value) continue
                    candidates.push({ id: existingId, session: existing })
                }

                if (candidates.length <= 1) continue

                const activeCandidates = candidates.filter(({ session }) => session.active)
                if (activeCandidates.length > 1) {
                    // Do not move history between two live session ids. The web may
                    // intentionally keep the currently selected duplicate visible,
                    // and the hub does not know which active duplicate that is.
                    continue
                }

                // Keep the same canonical session the sidebar is likely to show:
                // active sessions win, then the most recently updated session wins.
                // If timestamps tie, prefer the session that triggered this dedup run
                // so callers can intentionally preserve the visible/resumed session.
                candidates.sort((a, b) => {
                    if (a.session.active !== b.session.active) return a.session.active ? -1 : 1
                    const updatedDelta = b.session.updatedAt - a.session.updatedAt
                    if (updatedDelta !== 0) return updatedDelta
                    if (a.id === sessionId) return -1
                    if (b.id === sessionId) return 1
                    return b.session.activeAt - a.session.activeAt
                })
                const targetId = candidates[0].id
                const targetNamespace = candidates[0].session.namespace

                for (const { id } of candidates.slice(1)) {
                    if (id === targetId) continue
                    try {
                        const candidate = this.sessions.get(id)
                        if (candidate?.active) {
                            // Keep the live session record/socket intact, but move its already
                            // persisted history into the visible dedup target.  This preserves
                            // left-sidebar dedup while making resumed/restarted sessions show
                            // the full conversation history.
                            await this.mergeSessionHistory(id, targetId, targetNamespace, {
                                mergeAgentState: false
                            })
                        } else {
                            await this.mergeSessions(id, targetId, targetNamespace)
                        }
                    } catch {
                        // best-effort: duplicate remains if merge fails
                    }
                }
            } while (this.deduplicatePending.has(agentId.value))
        } finally {
            this.deduplicateInProgress.delete(agentId.value)
            this.deduplicatePending.delete(agentId.value)
        }
    }
}
