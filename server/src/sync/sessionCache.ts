import { AgentStateSchema, MetadataSchema } from '@hapi/protocol/schemas'
import type { ModelMode, PermissionMode, Session } from '@hapi/protocol/types'
import type { Store } from '../store'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'
import { extractTodoWriteTodosFromMessageContent, TodosSchema } from './todos'

export class SessionCache {
    private readonly sessions: Map<string, Session> = new Map()
    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()

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

    getActiveSessions(): Session[] {
        return this.getSessions().filter((session) => session.active)
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Session {
        const stored = this.store.getOrCreateSession(tag, metadata, agentState, namespace)
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    refreshSession(sessionId: string): Session | null {
        let stored = this.store.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            if (existed) {
                this.publisher.emit({ type: 'session-removed', sessionId })
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
                    const updated = this.store.setSessionTodos(sessionId, todos, message.createdAt, stored.namespace)
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
            namespace: stored.namespace,
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
            permissionMode: existing?.permissionMode,
            modelMode: existing?.modelMode
        }

        this.sessions.set(sessionId, session)
        this.publisher.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: session })
        return session
    }

    reloadAll(): void {
        const sessions = this.store.getSessions()
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
        modelMode?: ModelMode
    }): void {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        const wasActive = session.active
        const wasThinking = session.thinking
        const previousPermissionMode = session.permissionMode
        const previousModelMode = session.modelMode

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        session.thinking = Boolean(payload.thinking)
        session.thinkingAt = t
        if (payload.permissionMode !== undefined) {
            session.permissionMode = payload.permissionMode
        }
        if (payload.modelMode !== undefined) {
            session.modelMode = payload.modelMode
        }

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        const modeChanged = previousPermissionMode !== session.permissionMode || previousModelMode !== session.modelMode
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
                    activeAt: session.activeAt,
                    thinking: session.thinking,
                    permissionMode: session.permissionMode,
                    modelMode: session.modelMode
                }
            })
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

        this.publisher.emit({ type: 'session-updated', sessionId: session.id, data: { active: false, thinking: false } })
    }

    expireInactive(now: number = Date.now()): void {
        const sessionTimeoutMs = 30_000

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            session.active = false
            session.thinking = false
            this.publisher.emit({ type: 'session-updated', sessionId: session.id, data: { active: false } })
        }
    }

    applySessionConfig(sessionId: string, config: { permissionMode?: PermissionMode; modelMode?: ModelMode }): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) {
            return
        }

        if (config.permissionMode !== undefined) {
            session.permissionMode = config.permissionMode
        }
        if (config.modelMode !== undefined) {
            session.modelMode = config.modelMode
        }

        this.publisher.emit({ type: 'session-updated', sessionId, data: session })
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        const currentMetadata = session.metadata ?? { path: '', host: '' }
        const newMetadata = { ...currentMetadata, name }

        const result = this.store.updateSessionMetadata(
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

    async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        if (session.active) {
            throw new Error('Cannot delete active session')
        }

        const deleted = this.store.deleteSession(sessionId, session.namespace)
        if (!deleted) {
            throw new Error('Failed to delete session')
        }

        this.sessions.delete(sessionId)
        this.lastBroadcastAtBySessionId.delete(sessionId)
        this.todoBackfillAttemptedSessionIds.delete(sessionId)

        this.publisher.emit({ type: 'session-removed', sessionId, namespace: session.namespace })
    }
}
