import { CODEX_DESKTOP_SYNC_SOURCE, isCcApiEffortAllowedForModel, isClaudeDeepSeekEffortAllowedForModel } from '@hapi/protocol'
import { AgentStateSchema, MetadataSchema, TeamStateSchema } from '@hapi/protocol/schemas'
import type { CodexCollaborationMode, CodexServiceTier, PermissionMode, Session } from '@hapi/protocol/types'
import type { Store } from '../store'
import { validateActivityEventTime } from '../utils/activityEventTime'
import { EventPublisher } from './eventPublisher'
import { mergeSessionMetadata } from './sessionMetadata'
import { extractTodoWriteTodosFromMessageContent, TodosSchema } from './todos'
import { extractBackgroundTaskDelta } from './backgroundTasks'

function isCodexBackedMetadata(metadata: Record<string, unknown>): boolean {
    return metadata.mirrorSource === CODEX_DESKTOP_SYNC_SOURCE
        || metadata.flavor === 'codex'
        || typeof metadata.codexSessionId === 'string'
}

function metadataFlavor(metadata: unknown): string | null {
    const parsed = MetadataSchema.safeParse(metadata)
    return parsed.success ? parsed.data.flavor ?? null : null
}

/**
 * Merge agent_state across a session fork (old session id → new session id).
 *
 * The old (forked-away) session's still-pending `requests` have no live permission handler
 * in the resumed session, so carrying them into `requests` strands them as a permanent
 * "pending" badge — they can never be answered or finalized again. Cancel those into
 * `completedRequests` instead (preserving an audit trail); only the new session's own
 * requests stay live. Requests already recorded as completed are never resurrected.
 */
export function mergeForkedAgentState(oldState: unknown | null, newState: unknown | null): unknown | null {
    if (oldState === null) return newState
    if (newState === null) return oldState

    const oldObj = oldState as Record<string, unknown>
    const newObj = newState as Record<string, unknown>

    const completedRequests: Record<string, unknown> = {
        ...((oldObj.completedRequests as Record<string, unknown> | undefined) ?? {}),
        ...((newObj.completedRequests as Record<string, unknown> | undefined) ?? {})
    }

    // Old session's leftover pending requests → cancel into completedRequests (no live handler
    // after the fork). Skip ids already recorded as completed, and ids the new session still has
    // a live request for (don't cancel/override a genuine new-session pending on id collision).
    const newRequests = (newObj.requests as Record<string, unknown> | undefined) ?? {}
    const oldRequests = (oldObj.requests as Record<string, unknown> | undefined) ?? {}
    for (const [id, request] of Object.entries(oldRequests)) {
        if (id in completedRequests || id in newRequests) continue
        completedRequests[id] = {
            ...(request as Record<string, unknown>),
            completedAt: Date.now(),
            status: 'canceled',
            reason: 'Canceled on session fork (no live handler in resumed session)'
        }
    }

    // Only the new (active) session's requests remain live; drop any already completed.
    const completedIds = new Set(Object.keys(completedRequests))
    const requests = Object.fromEntries(
        Object.entries(newRequests).filter(([id]) => !completedIds.has(id))
    )

    return { ...oldObj, ...newObj, requests, completedRequests }
}

export class SessionCache {
    private readonly sessions: Map<string, Session> = new Map()
    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly lastActivityPersistedAtBySessionId: Map<string, number> = new Map()
    private readonly lastActivityEventAtBySessionId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()
    private readonly deduplicateInProgress: Set<string> = new Set()

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
        const canonicalSessionId = this.store.managedSessions.resolveCanonical(namespace, sessionId)
        const session = this.sessions.get(canonicalSessionId) ?? this.refreshSession(canonicalSessionId)
        if (session) {
            if (session.namespace !== namespace) {
                return { ok: false, reason: 'access-denied' }
            }
            return { ok: true, sessionId: canonicalSessionId, session }
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
        serviceTier?: string
    ): Session {
        const stored = this.store.sessions.getOrCreateSession(tag, metadata, agentState, namespace, model, effort, modelReasoningEffort, serviceTier)
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    refreshSession(sessionId: string): Session | null {
        let stored = this.store.sessions.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            if (existed) {
                this.lastBroadcastAtBySessionId.delete(sessionId)
                this.lastActivityPersistedAtBySessionId.delete(sessionId)
                this.lastActivityEventAtBySessionId.delete(sessionId)
                this.todoBackfillAttemptedSessionIds.delete(sessionId)
                this.publisher.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)
        const existingActivityEventAt = this.lastActivityEventAtBySessionId.get(sessionId)
        // Heartbeats advance the in-memory watermark more often than the throttled
        // SQLite write. A delayed durable outcome can therefore leave the row older
        // than the live cache; never replace newer liveness with that stale row.
        const existingActivityWins = existing !== undefined
            && existingActivityEventAt !== undefined
            && (
                stored.activityEventAt === null
                || stored.activityEventAt < existingActivityEventAt
                || (
                    stored.activityEventAt === existingActivityEventAt
                    && !existing.active
                    && stored.active
                )
            )
        // A normal throttled heartbeat only advances the in-memory timestamp while
        // both snapshots remain active. Preserve that newer cache value without
        // turning every unrelated refresh into an SQLite activity write. Repair
        // immediately only when a delayed durable transition changed active state.
        const storedActivityNeedsRepair = existingActivityWins
            && stored.active !== existing.active
        if (storedActivityNeedsRepair) {
            const repaired = this.store.sessions.setSessionActivity(
                sessionId,
                existing.active,
                existing.activeAt,
                existingActivityEventAt,
                stored.namespace
            )
            if (repaired) {
                this.lastActivityPersistedAtBySessionId.set(sessionId, existing.activeAt)
            }
        }
        if (stored.activityEventAt !== null && (existingActivityEventAt === undefined || stored.activityEventAt > existingActivityEventAt)) {
            this.lastActivityEventAtBySessionId.set(sessionId, stored.activityEventAt)
        }

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

        const active = existingActivityWins ? existing.active : stored.active
        const activeAt = existingActivityWins
            ? existing.activeAt
            : existing?.active && stored.active
                ? Math.max(existing.activeAt, stored.activeAt ?? stored.createdAt)
                : (stored.activeAt ?? stored.createdAt)
        const session: Session = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active,
            activeAt,
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: active ? (existing?.thinking ?? false) : false,
            thinkingAt: active ? (existing?.thinkingAt ?? 0) : 0,
            backgroundTaskCount: active ? (existing?.backgroundTaskCount ?? 0) : 0,
            todos,
            teamState,
            model: stored.model,
            modelReasoningEffort: stored.modelReasoningEffort,
            serviceTier: stored.serviceTier as CodexServiceTier | null,
            effort: stored.effort,
            permissionMode: (stored.permissionMode as PermissionMode | null) ?? undefined,
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

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        model?: string | null
        modelReasoningEffort?: string | null
        serviceTier?: CodexServiceTier | null
        effort?: string | null
        collaborationMode?: CodexCollaborationMode
    }): void {
        const eventAt = validateActivityEventTime(payload.time)
        if (!eventAt) return

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return
        const lastActivityEventAt = this.lastActivityEventAtBySessionId.get(session.id)
        if (lastActivityEventAt !== undefined && (
            eventAt < lastActivityEventAt
            || (eventAt === lastActivityEventAt && !session.active)
        )) return

        const wasActive = session.active
        const wasThinking = session.thinking
        const previousPermissionMode = session.permissionMode
        const previousModel = session.model
        const previousModelReasoningEffort = session.modelReasoningEffort
        const previousServiceTier = session.serviceTier
        const previousEffort = session.effort
        const previousCollaborationMode = session.collaborationMode
        const now = Date.now()
        const lastActivityPersistedAt = this.lastActivityPersistedAtBySessionId.get(session.id) ?? 0
        if (!wasActive || now - lastActivityPersistedAt > 10_000) {
            const persisted = this.store.sessions.setSessionActivity(session.id, true, now, eventAt, session.namespace)
            if (persisted) {
                this.lastActivityPersistedAtBySessionId.set(session.id, now)
            } else {
                const stored = this.store.sessions.getSession(session.id)
                if (!wasActive) {
                    if (!stored?.active || stored.activityEventAt === null || stored.activityEventAt < eventAt) return
                } else if (stored && !stored.active) {
                    this.refreshSession(session.id)
                    return
                }
            }
        }

        session.active = true
        session.activeAt = now
        session.thinking = Boolean(payload.thinking)
        session.thinkingAt = session.activeAt
        if (payload.permissionMode !== undefined) {
            if (payload.permissionMode !== session.permissionMode) {
                this.store.sessions.setSessionPermissionMode(payload.sid, payload.permissionMode, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.permissionMode = payload.permissionMode
        }
        if (payload.model !== undefined) {
            if (payload.model !== session.model) {
                this.store.sessions.setSessionModel(payload.sid, payload.model, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.model = payload.model
        }
        if (payload.modelReasoningEffort !== undefined) {
            if (payload.modelReasoningEffort !== session.modelReasoningEffort) {
                this.store.sessions.setSessionModelReasoningEffort(payload.sid, payload.modelReasoningEffort, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.modelReasoningEffort = payload.modelReasoningEffort
        }
        if (payload.serviceTier !== undefined) {
            if (payload.serviceTier !== session.serviceTier) {
                this.store.sessions.setSessionServiceTier(payload.sid, payload.serviceTier, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.serviceTier = payload.serviceTier
        }
        if (payload.effort !== undefined) {
            if (payload.effort !== session.effort) {
                this.store.sessions.setSessionEffort(payload.sid, payload.effort, session.namespace, {
                    touchUpdatedAt: false
                })
            }
            session.effort = payload.effort
        }
        if (payload.collaborationMode !== undefined) {
            session.collaborationMode = payload.collaborationMode
        }

        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        this.lastActivityEventAtBySessionId.set(session.id, eventAt)
        const modeChanged = previousPermissionMode !== session.permissionMode
            || previousModel !== session.model
            || previousModelReasoningEffort !== session.modelReasoningEffort
            || previousServiceTier !== session.serviceTier
            || previousEffort !== session.effort
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
                    serviceTier: session.serviceTier,
                    effort: session.effort,
                    collaborationMode: session.collaborationMode
                }
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
            data: { backgroundTaskCount: next }
        })
    }

    handleSessionEnd(payload: { sid: string; time: number }): boolean {
        const eventAt = validateActivityEventTime(payload.time)
        if (!eventAt) return false

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return false
        const lastActivityEventAt = this.lastActivityEventAtBySessionId.get(session.id)
        if (lastActivityEventAt !== undefined && eventAt < lastActivityEventAt) return false

        const transitionAt = Date.now()
        const persisted = this.store.sessions.setSessionActivity(session.id, false, transitionAt, eventAt, session.namespace)
        let committedEventAt = eventAt
        let committedActiveAt = transitionAt
        if (!persisted) {
            const stored = this.store.sessions.getSession(session.id)
            if (!stored || stored.active || stored.activityEventAt !== eventAt) {
                return false
            }
            committedEventAt = stored.activityEventAt
            committedActiveAt = stored.activeAt ?? session.activeAt
        }
        this.lastActivityPersistedAtBySessionId.set(session.id, committedActiveAt)
        this.lastActivityEventAtBySessionId.set(session.id, committedEventAt)

        if (!session.active && !session.thinking) {
            session.activeAt = committedActiveAt
            return true
        }

        session.active = false
        session.activeAt = committedActiveAt
        session.thinking = false
        session.thinkingAt = committedActiveAt
        session.backgroundTaskCount = 0

        this.publisher.emit({ type: 'session-updated', sessionId: session.id, data: { active: false, thinking: false, backgroundTaskCount: 0 } })
        return true
    }

    expireInactive(now: number = Date.now()): string[] {
        const sessionTimeoutMs = 30_000
        const expired: string[] = []

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            const lastActivityEventAt = this.lastActivityEventAtBySessionId.get(session.id)
            const eventAt = (lastActivityEventAt ?? 0) + 1
            if (!this.store.sessions.setSessionActivity(session.id, false, now, eventAt, session.namespace)) continue
            session.active = false
            session.activeAt = now
            session.thinking = false
            session.backgroundTaskCount = 0
            this.lastActivityPersistedAtBySessionId.set(session.id, now)
            this.lastActivityEventAtBySessionId.set(session.id, eventAt)
            expired.push(session.id)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: { active: false, activeAt: now, thinking: false, backgroundTaskCount: 0 }
            })
        }

        return expired
    }

    applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: string | null
            modelReasoningEffort?: string | null
            serviceTier?: CodexServiceTier | null
            effort?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) {
            return
        }

        if (config.permissionMode !== undefined) {
            if (config.permissionMode !== session.permissionMode) {
                const updated = this.store.sessions.setSessionPermissionMode(sessionId, config.permissionMode, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session permission mode')
                }
            }
            session.permissionMode = config.permissionMode
        }
        if (config.model !== undefined) {
            if (config.model !== session.model) {
                const updated = this.store.sessions.setSessionModel(sessionId, config.model, session.namespace, {
                    touchUpdatedAt: false
                })
                if (!updated) {
                    throw new Error('Failed to update session model')
                }
            }
            session.model = config.model
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
        }
        if (config.collaborationMode !== undefined) {
            session.collaborationMode = config.collaborationMode
        }

        this.publisher.emit({ type: 'session-updated', sessionId, data: session })
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        const currentMetadata = session.metadata ?? { path: '', host: '' }
        const newMetadata: Record<string, unknown> = isCodexBackedMetadata(currentMetadata as Record<string, unknown>)
            ? {
                ...currentMetadata,
                name: undefined,
                title: name,
                titleUpdatedAt: Date.now()
            }
            : { ...currentMetadata, name }

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

        if (result.result === 'version-mismatch') {
            throw new Error('Session was modified concurrently. Please try again.')
        }

        this.refreshSession(sessionId)
    }

    async patchSessionMetadata(
        sessionId: string,
        namespace: string,
        updater: (metadata: Record<string, unknown>) => Record<string, unknown>
    ): Promise<void> {
        const session = this.resolveSessionAccess(sessionId, namespace)
        if (!session.ok) {
            throw new Error('Session not found')
        }

        const currentMetadata = (session.session.metadata ?? { path: '', host: '' }) as Record<string, unknown>
        const nextMetadata = updater(currentMetadata)
        const result = this.store.sessions.updateSessionMetadata(
            sessionId,
            nextMetadata,
            session.session.metadataVersion,
            namespace,
            { touchUpdatedAt: false }
        )

        if (result.result !== 'success') {
            throw new Error(
                result.result === 'version-mismatch'
                    ? 'Session was modified concurrently. Please try again.'
                    : 'Failed to update session metadata'
            )
        }

        this.refreshSession(sessionId)
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
        this.lastActivityPersistedAtBySessionId.delete(sessionId)
        this.lastActivityEventAtBySessionId.delete(sessionId)
        this.todoBackfillAttemptedSessionIds.delete(sessionId)

        this.publisher.emit({ type: 'session-removed', sessionId, namespace: session.namespace })
    }

    async mergeSessions(oldSessionId: string, newSessionId: string, namespace: string): Promise<void> {
        if (oldSessionId === newSessionId) {
            return
        }

        const oldStored = this.store.sessions.getSessionByNamespace(oldSessionId, namespace)
        const newStored = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
        if (!oldStored || !newStored) {
            throw new Error('Session not found for merge')
        }

        // Alias publication, delivery-ledger rewrite, and message movement are
        // one SQLite commit. No crash can expose the alias while messages still
        // live only under the hidden old id.
        this.store.mergeSessionIdentity(namespace, oldSessionId, newSessionId)

        const mergedMetadata = mergeSessionMetadata(oldStored.metadata, newStored.metadata)
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

        if (newStored.serviceTier === null && oldStored.serviceTier !== null) {
            const updated = this.store.sessions.setSessionServiceTier(newSessionId, oldStored.serviceTier, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session service tier during merge')
            }
        }

        const mergedFlavor = metadataFlavor(mergedMetadata) ?? metadataFlavor(newStored.metadata) ?? metadataFlavor(oldStored.metadata)
        const mergedModel = newStored.model ?? oldStored.model
        if (
            newStored.effort === null
            && oldStored.effort !== null
            && (mergedFlavor !== 'cc-api' || isCcApiEffortAllowedForModel(
                mergedModel,
                oldStored.effort,
                { allowUnlistedModel: true }
            ))
            && (mergedFlavor !== 'claude-deepseek' || isClaudeDeepSeekEffortAllowedForModel(mergedModel, oldStored.effort))
        ) {
            const updated = this.store.sessions.setSessionEffort(newSessionId, oldStored.effort, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session effort during merge')
            }
        }

        if (newStored.permissionMode === null && oldStored.permissionMode !== null) {
            const updated = this.store.sessions.setSessionPermissionMode(newSessionId, oldStored.permissionMode, namespace, {
                touchUpdatedAt: false
            })
            if (!updated) {
                throw new Error('Failed to preserve session permission mode during merge')
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
        // approvals on the duplicate are not lost. Only inactive duplicates reach this point
        // (active ones are skipped by deduplicateByAgentSessionId).
        // Read the latest target state right before writing to avoid overwriting live updates.
        if (oldStored.agentState !== null) {
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

        const deleted = this.store.sessions.deleteSession(oldSessionId, namespace)
        if (!deleted) {
            throw new Error('Failed to delete old session during merge')
        }

        const existed = this.sessions.delete(oldSessionId)
        if (existed) {
            this.publisher.emit({ type: 'session-removed', sessionId: oldSessionId, namespace })
        }
        this.lastBroadcastAtBySessionId.delete(oldSessionId)
        this.lastActivityPersistedAtBySessionId.delete(oldSessionId)
        this.lastActivityEventAtBySessionId.delete(oldSessionId)
        this.todoBackfillAttemptedSessionIds.delete(oldSessionId)

        this.refreshSession(newSessionId)
    }

    private mergeAgentState(oldState: unknown | null, newState: unknown | null): unknown | null {
        return mergeForkedAgentState(oldState, newState)
    }

    private extractAgentSessionId(
        metadata: NonNullable<Session['metadata']>
    ): { field: 'codexSessionId' | 'claudeSessionId' | 'agySessionId' | 'grokSessionId' | 'opencodeSessionId' | 'cursorSessionId' | 'hermesSessionId'; value: string } | null {
        if (metadata.codexSessionId) return { field: 'codexSessionId', value: metadata.codexSessionId }
        if (metadata.claudeSessionId) return { field: 'claudeSessionId', value: metadata.claudeSessionId }
        if (metadata.agySessionId) return { field: 'agySessionId', value: metadata.agySessionId }
        if (metadata.grokSessionId) return { field: 'grokSessionId', value: metadata.grokSessionId }
        if (metadata.opencodeSessionId) return { field: 'opencodeSessionId', value: metadata.opencodeSessionId }
        if (metadata.cursorSessionId) return { field: 'cursorSessionId', value: metadata.cursorSessionId }
        if (metadata.hermesSessionId) return { field: 'hermesSessionId', value: metadata.hermesSessionId }
        return null
    }

    async deduplicateByAgentSessionId(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session?.metadata) return

        const agentId = this.extractAgentSessionId(session.metadata)
        if (!agentId) return

        // Guard: skip if another dedup for this agent ID is already in progress.
        // A skipped trigger is acceptable — the web-side display dedup hides any remaining duplicates.
        if (this.deduplicateInProgress.has(agentId.value)) return
        this.deduplicateInProgress.add(agentId.value)

        try {
            const candidates: { id: string; session: Session }[] = [{ id: sessionId, session }]
            for (const [existingId, existing] of this.sessions) {
                if (existingId === sessionId) continue
                if (existing.namespace !== session.namespace) continue
                if (!existing.metadata) continue
                if (existing.metadata[agentId.field] !== agentId.value) continue
                // Only merge inactive duplicates. Active ones still have a live CLI socket
                // whose keepalive/messages would fail if we deleted their session record.
                // The web-side display dedup hides active duplicates from the UI.
                if (existing.active) continue
                candidates.push({ id: existingId, session: existing })
            }

            if (candidates.length <= 1) return

            // Keep the most recent session as the merge target so newer state survives.
            candidates.sort((a, b) =>
                (b.session.activeAt - a.session.activeAt) || (b.session.updatedAt - a.session.updatedAt)
            )
            const targetId = candidates[0].id
            const targetNamespace = candidates[0].session.namespace

            for (const { id } of candidates.slice(1)) {
                if (id === targetId) continue
                try {
                    await this.mergeSessions(id, targetId, targetNamespace)
                } catch {
                    // best-effort: duplicate remains if merge fails
                }
            }
        } finally {
            this.deduplicateInProgress.delete(agentId.value)
        }
    }
}
