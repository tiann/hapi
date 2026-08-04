import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    computePendingRequestKinds,
    computePendingRequests,
    computePendingRequestsCount,
    computeTodoProgress,
    isObject,
    toSessionSummary,
    toSessionSummaryMetadata
} from '@hapi/protocol'
import { MachinePatchSchema, MachineSchema, SessionPatchSchema, SessionSchema } from '@hapi/protocol/schemas'
import type {
    Machine,
    MachinesResponse,
    Session,
    SessionPatch,
    SessionResponse,
    SessionsResponse,
    SessionSummary,
    SyncEvent
} from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow, getMessageWindowState, ingestIncomingMessages, markMessagesConsumed, removeOptimisticMessage, updateMessageStatus } from '@/lib/message-window-store'

type SSESubscription = {
    all?: boolean
    sessionId?: string
    machineId?: string
}

export type SSEScope = 'global' | 'full'

const MESSAGE_STREAM_EVENT_TYPES = new Set<SyncEvent['type']>([
    'message-received',
    'messages-consumed',
    'message-cancelled',
    'scheduled-matured'
])

export function isGlobalScopedMessageStreamEvent(scope: SSEScope, eventType: SyncEvent['type']): boolean {
    return scope === 'global' && MESSAGE_STREAM_EVENT_TYPES.has(eventType)
}

export function shouldInvalidateSessionListForEvent(scope: SSEScope, eventType: SyncEvent['type']): boolean {
    return scope === 'global' && eventType === 'messages-invalidated'
}

// Version-monotonicity gate for structured patches carrying metadata or
// agentState. SSE reconnects + per-query invalidation can leave the cache
// holding state that's NEWER than a buffered older patch about to replay;
// applying that older patch would regress resume / session-id / pending-
// requests state. Mirrors the CLI room handler contract: strictly newer
// only. Exported so the rule is unit-testable in isolation from the hook.
export function isNewerVersionedPatch(patchVersion: number, currentVersion: number): boolean {
    return patchVersion > currentVersion
}

/**
 * @deprecated Prefer gating against SessionSummary watermarks. Kept for unit
 * tests of the old "detail required" rule; summary path no longer uses this
 * for metadata/agentState/todos (teamState is a summary no-op).
 */
export function canApplyVersionedSummaryPatch(
    patch: Pick<SessionPatch, 'metadata' | 'agentState' | 'todos' | 'teamState'>,
    detailPresent: boolean
): boolean {
    // teamState is not rendered on SessionSummary — never block list patches.
    if (
        patch.metadata === undefined
        && patch.agentState === undefined
        && patch.todos === undefined
    ) {
        return true
    }
    return detailPresent
}

type VisibilityState = 'visible' | 'hidden'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

const HEARTBEAT_STALE_MS = 90_000
const HEARTBEAT_WATCHDOG_INTERVAL_MS = 10_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_JITTER_MS = 500
const INVALIDATION_BATCH_MS = 16

function sortSessionSummaries(left: SessionSummary, right: SessionSummary): number {
    if (left.active !== right.active) {
        return left.active ? -1 : 1
    }
    if (left.active && left.pendingRequestsCount !== right.pendingRequestsCount) {
        return right.pendingRequestsCount - left.pendingRequestsCount
    }
    return right.updatedAt - left.updatedAt
}

/**
 * True when applying `patch` to `session` would change nothing that renders.
 *
 * Keep-alive patches re-send fields about every ~10s. SessionHeader reads
 * `activeAt` for relative age, but `formatRelativeTime` only changes at
 * minute boundaries (`just now` while delta < 60s). Sub-minute `activeAt`
 * moves are therefore skipped here so the detail cache does not replace the
 * Session object (and re-render SessionChat / HappyThread) six times a
 * minute for an invisible label change. A delta of ≥60s is still
 * render-relevant so the header stays on `just now` for live sessions.
 * The session-list path still uses {@link isRenderIrrelevantPatch}, which
 * ignores `activeAt` entirely.
 */
export function isRenderIrrelevantSessionPatch(session: Session, patch: SessionPatch): boolean {
    const current = session as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
        if (
            key === 'activeAt'
            && typeof value === 'number'
            && Math.abs(value - session.activeAt) < 60_000
        ) {
            continue
        }
        if (current[key] !== value) {
            return false
        }
    }
    return true
}

/**
 * Apply a validated SessionPatch onto a detail Session. Returns null when
 * nothing render-relevant changed (keep prior object identity). Field-by-field
 * only — never wholesale-spread versioned `{ version, value }` wrappers.
 * Exported for unit tests (Copilot mode keep-alive must not be dropped).
 */
export function applySessionDetailPatch(session: Session, patch: SessionPatch): Session | null {
    if (isRenderIrrelevantSessionPatch(session, patch)) {
        return null
    }
    let changed = false
    const nextSession: Session = { ...session }
    const assign = <K extends keyof Session>(key: K, value: Session[K]) => {
        if (nextSession[key] !== value) {
            nextSession[key] = value
            changed = true
        }
    }
    if (patch.active !== undefined) assign('active', patch.active)
    if (patch.thinking !== undefined) assign('thinking', patch.thinking)
    if (patch.activeAt !== undefined) assign('activeAt', patch.activeAt)
    // Monotonic with hub applySessionPatch: a rejected stale
    // metadata/agentState replay must not rewind updatedAt.
    if (patch.updatedAt !== undefined) {
        const nextUpdatedAt = Math.max(nextSession.updatedAt, patch.updatedAt)
        assign('updatedAt', nextUpdatedAt)
    }
    if (patch.model !== undefined) assign('model', patch.model)
    if (patch.modelReasoningEffort !== undefined) assign('modelReasoningEffort', patch.modelReasoningEffort)
    if (patch.effort !== undefined) assign('effort', patch.effort)
    if (Object.prototype.hasOwnProperty.call(patch, 'serviceTier')) {
        assign('serviceTier', patch.serviceTier ?? null)
    }
    if (patch.permissionMode !== undefined) assign('permissionMode', patch.permissionMode)
    if (patch.collaborationMode !== undefined) assign('collaborationMode', patch.collaborationMode)
    if (patch.copilotAgentMode !== undefined) assign('copilotAgentMode', patch.copilotAgentMode)
    if (patch.backgroundTaskCount !== undefined) assign('backgroundTaskCount', patch.backgroundTaskCount)
    // Version gates: dual SSE can deliver duplicates out of order.
    // Only mark changed when a strictly newer version lands —
    // otherwise keep previous object identity (no redundant render).
    if (patch.todos !== undefined && isNewerVersionedPatch(patch.todos.version, nextSession.todosUpdatedAt ?? 0)) {
        nextSession.todos = patch.todos.value
        nextSession.todosUpdatedAt = patch.todos.version
        changed = true
    }
    if (patch.teamState !== undefined && isNewerVersionedPatch(patch.teamState.version, nextSession.teamStateUpdatedAt ?? 0)) {
        nextSession.teamState = patch.teamState.value ?? undefined
        nextSession.teamStateUpdatedAt = patch.teamState.version
        changed = true
    }
    if (patch.metadata !== undefined && isNewerVersionedPatch(patch.metadata.version, nextSession.metadataVersion)) {
        nextSession.metadata = patch.metadata.value
        nextSession.metadataVersion = patch.metadata.version
        changed = true
    }
    if (patch.agentState !== undefined && isNewerVersionedPatch(patch.agentState.version, nextSession.agentStateVersion)) {
        nextSession.agentState = patch.agentState.value
        nextSession.agentStateVersion = patch.agentState.version
        changed = true
    }
    return changed ? nextSession : null
}

function isSessionRecord(value: unknown): value is Session {
    return SessionSchema.safeParse(value).success
}

/**
 * True when the only difference between two summaries is `activeAt`.
 *
 * The CLI keep-alive makes the hub re-broadcast a full session patch about
 * every 10s per active session even when nothing changed, and `activeAt` is
 * the sole field that moves. No component reads `activeAt` - the list shows
 * `updatedAt` and sorts on active/pendingRequestsCount/updatedAt - so storing
 * it costs a new object identity and a full list re-render for nothing.
 */
export function sameSessionSummaryMetadata(
    current: SessionSummary['metadata'],
    next: SessionSummary['metadata']
): boolean {
    if (current === next) {
        return true
    }
    if (current == null || next == null) {
        return current == null && next == null
    }
    return current.name === next.name
        && current.path === next.path
        && current.machineId === next.machineId
        && current.summary?.text === next.summary?.text
        && current.flavor === next.flavor
        && current.agentSessionId === next.agentSessionId
        && current.lifecycleState === next.lifecycleState
        && current.worktree?.basePath === next.worktree?.basePath
        && current.worktree?.branch === next.worktree?.branch
        && current.worktree?.name === next.worktree?.name
        && current.worktree?.worktreePath === next.worktree?.worktreePath
        && current.worktree?.createdAt === next.worktree?.createdAt
}

export function isRenderIrrelevantPatch(current: SessionSummary, next: SessionSummary): boolean {
    return current.active === next.active
        && current.thinking === next.thinking
        && current.updatedAt === next.updatedAt
        && current.backgroundTaskCount === next.backgroundTaskCount
        && current.model === next.model
        && current.modelReasoningEffort === next.modelReasoningEffort
        && current.effort === next.effort
        && current.pendingRequestsCount === next.pendingRequestsCount
        // Structured SSE patches (#897) can move these without touching the
        // keep-alive fields above; omit them and a todos/metadata/agentState
        // patch would be dropped as "activeAt-only" churn.
        && current.todoProgress?.completed === next.todoProgress?.completed
        && current.todoProgress?.total === next.todoProgress?.total
        && (current.todoProgress == null) === (next.todoProgress == null)
        && current.pendingRequestKinds.length === next.pendingRequestKinds.length
        && current.pendingRequestKinds.every((kind, i) => kind === next.pendingRequestKinds[i])
        && current.pendingRequests.length === next.pendingRequests.length
        && current.pendingRequests.every((req, i) => {
            const nextReq = next.pendingRequests[i]
            return req.id === nextReq?.id
                && req.kind === nextReq.kind
                && req.tool === nextReq.tool
        })
        && sameSessionSummaryMetadata(current.metadata, next.metadata)
        && current.metadataVersion === next.metadataVersion
        && current.agentStateVersion === next.agentStateVersion
        && current.todosUpdatedAt === next.todosUpdatedAt
}

function getSessionPatch(value: unknown): SessionPatch | null {
    const parsed = SessionPatchSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return Object.keys(parsed.data).length > 0 ? parsed.data : null
}

function isMachineRecord(value: unknown): value is Machine {
    return MachineSchema.safeParse(value).success
}

function getMachinePatch(value: unknown): { active?: boolean; activeAt?: number; updatedAt?: number } | null {
    const parsed = MachinePatchSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return Object.keys(parsed.data).length > 0 ? parsed.data : null
}

function getVisibilityState(): VisibilityState {
    if (typeof document === 'undefined') {
        return 'hidden'
    }
    return document.visibilityState === 'visible' ? 'visible' : 'hidden'
}

function buildEventsUrl(
    baseUrl: string,
    token: string,
    subscription: SSESubscription,
    visibility: VisibilityState
): string {
    const params = new URLSearchParams()
    params.set('token', token)
    params.set('visibility', visibility)
    if (subscription.all) {
        params.set('all', 'true')
    }
    if (subscription.sessionId) {
        params.set('sessionId', subscription.sessionId)
    }
    if (subscription.machineId) {
        params.set('machineId', subscription.machineId)
    }

    const path = `/api/events?${params.toString()}`
    try {
        return new URL(path, baseUrl).toString()
    } catch {
        return path
    }
}

export function useSSE(options: {
    enabled: boolean
    token: string
    baseUrl: string
    subscription?: SSESubscription
    scope?: SSEScope
    onEvent: (event: SyncEvent) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onError?: (error: unknown) => void
    onToast?: (event: ToastEvent) => void
}): { subscriptionId: string | null } {
    const queryClient = useQueryClient()
    const onEventRef = useRef(options.onEvent)
    const onConnectRef = useRef(options.onConnect)
    const onDisconnectRef = useRef(options.onDisconnect)
    const onErrorRef = useRef(options.onError)
    const onToastRef = useRef(options.onToast)
    const eventSourceRef = useRef<EventSource | null>(null)
    const invalidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingInvalidationsRef = useRef<{
        sessions: boolean
        machines: boolean
        sessionIds: Set<string>
        scratchlistSessionIds: Set<string>
    }>({ sessions: false, machines: false, sessionIds: new Set(), scratchlistSessionIds: new Set() })
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const reconnectAttemptRef = useRef(0)
    const lastActivityAtRef = useRef(0)
    const [reconnectNonce, setReconnectNonce] = useState(0)
    const [subscriptionId, setSubscriptionId] = useState<string | null>(null)

    useEffect(() => {
        onEventRef.current = options.onEvent
    }, [options.onEvent])

    useEffect(() => {
        onErrorRef.current = options.onError
    }, [options.onError])

    useEffect(() => {
        onConnectRef.current = options.onConnect
    }, [options.onConnect])

    useEffect(() => {
        onDisconnectRef.current = options.onDisconnect
    }, [options.onDisconnect])

    useEffect(() => {
        onToastRef.current = options.onToast
    }, [options.onToast])

    const subscription = options.subscription ?? {}
    const scope = options.scope ?? 'full'

    const subscriptionKey = useMemo(() => {
        return `${scope}|${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}`
    }, [scope, subscription.all, subscription.sessionId, subscription.machineId])

    useEffect(() => {
        if (!options.enabled) {
            eventSourceRef.current?.close()
            eventSourceRef.current = null
            if (invalidationTimerRef.current) {
                clearTimeout(invalidationTimerRef.current)
                invalidationTimerRef.current = null
            }
            pendingInvalidationsRef.current.sessions = false
            pendingInvalidationsRef.current.machines = false
            pendingInvalidationsRef.current.sessionIds.clear()
            pendingInvalidationsRef.current.scratchlistSessionIds.clear()
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
                reconnectTimerRef.current = null
            }
            reconnectAttemptRef.current = 0
            setSubscriptionId(null)
            return
        }

        setSubscriptionId(null)
        const url = buildEventsUrl(options.baseUrl, options.token, {
            ...subscription,
            sessionId: subscription.sessionId ?? undefined
        }, getVisibilityState())
        const eventSource = new EventSource(url)
        let disconnectNotified = false
        let reconnectRequested = false
        eventSourceRef.current = eventSource
        lastActivityAtRef.current = Date.now()

        const scheduleReconnect = () => {
            const attempt = reconnectAttemptRef.current
            const exponentialDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** attempt))
            const jitter = Math.floor(Math.random() * (RECONNECT_JITTER_MS + 1))
            reconnectAttemptRef.current = attempt + 1
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
            }
            reconnectTimerRef.current = setTimeout(() => {
                reconnectTimerRef.current = null
                setReconnectNonce((value) => value + 1)
            }, exponentialDelay + jitter)
        }

        const notifyDisconnect = (reason: string) => {
            if (disconnectNotified) {
                return
            }
            disconnectNotified = true
            onDisconnectRef.current?.(reason)
        }

        const requestReconnect = (reason: string) => {
            if (reconnectRequested) {
                return
            }
            reconnectRequested = true
            notifyDisconnect(reason)
            eventSource.close()
            if (eventSourceRef.current === eventSource) {
                eventSourceRef.current = null
            }
            setSubscriptionId(null)
            scheduleReconnect()
        }

        const flushInvalidations = () => {
            const pending = pendingInvalidationsRef.current
            if (
                !pending.sessions
                && !pending.machines
                && pending.sessionIds.size === 0
                && pending.scratchlistSessionIds.size === 0
            ) {
                return
            }

            const shouldInvalidateSessions = pending.sessions
            const shouldInvalidateMachines = pending.machines
            const sessionIds = Array.from(pending.sessionIds)
            const scratchlistSessionIds = Array.from(pending.scratchlistSessionIds)

            pending.sessions = false
            pending.machines = false
            pending.sessionIds.clear()
            pending.scratchlistSessionIds.clear()

            const tasks: Array<Promise<unknown>> = []
            if (shouldInvalidateSessions) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.sessions }))
            }
            for (const sessionId of sessionIds) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }))
            }
            for (const sessionId of scratchlistSessionIds) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.scratchlist(sessionId) }))
            }
            if (shouldInvalidateMachines) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.machines }))
            }

            if (tasks.length === 0) {
                return
            }
            void Promise.all(tasks).catch(() => {})
        }

        const scheduleInvalidationFlush = () => {
            if (invalidationTimerRef.current) {
                return
            }
            invalidationTimerRef.current = setTimeout(() => {
                invalidationTimerRef.current = null
                flushInvalidations()
            }, INVALIDATION_BATCH_MS)
        }

        const queueSessionListInvalidation = () => {
            pendingInvalidationsRef.current.sessions = true
            scheduleInvalidationFlush()
        }

        const queueSessionDetailInvalidation = (sessionId: string) => {
            pendingInvalidationsRef.current.sessionIds.add(sessionId)
            scheduleInvalidationFlush()
        }

        const queueScratchlistInvalidation = (sessionId: string) => {
            pendingInvalidationsRef.current.scratchlistSessionIds.add(sessionId)
            scheduleInvalidationFlush()
        }

        const queueMachinesInvalidation = () => {
            pendingInvalidationsRef.current.machines = true
            scheduleInvalidationFlush()
        }

        const upsertSessionSummary = (session: Session) => {
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }

                const existingIndex = previous.sessions.findIndex((item) => item.id === session.id)
                const existing = existingIndex >= 0 ? previous.sessions[existingIndex] : undefined
                const summary = {
                    ...toSessionSummary(session),
                    futureScheduledMessageCount: existing?.futureScheduledMessageCount ?? 0,
                    nextScheduledAt: existing?.nextScheduledAt ?? null
                }
                const nextSessions = previous.sessions.slice()
                if (existingIndex >= 0) {
                    nextSessions[existingIndex] = summary
                } else {
                    nextSessions.push(summary)
                }
                nextSessions.sort(sortSessionSummaries)
                return { ...previous, sessions: nextSessions }
            })
        }

        const patchSessionSummary = (sessionId: string, patch: SessionPatch): boolean => {
            let patched = false
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }

                const nextSessions = previous.sessions.slice()
                const index = nextSessions.findIndex((item) => item.id === sessionId)
                if (index < 0) {
                    return previous
                }

                const current = nextSessions[index]
                if (!current) {
                    return previous
                }

                const nextSummary: SessionSummary = {
                    ...current,
                    active: patch.active ?? current.active,
                    thinking: patch.thinking ?? current.thinking,
                    activeAt: patch.activeAt ?? current.activeAt,
                    // Monotonic: stale versioned-patch replays can carry an
                    // older updatedAt; never move the list clock backward.
                    updatedAt: patch.updatedAt !== undefined
                        ? Math.max(current.updatedAt, patch.updatedAt)
                        : current.updatedAt,
                    backgroundTaskCount: Object.prototype.hasOwnProperty.call(patch, 'backgroundTaskCount')
                        ? patch.backgroundTaskCount ?? 0
                        : current.backgroundTaskCount,
                    model: Object.prototype.hasOwnProperty.call(patch, 'model') ? patch.model ?? null : current.model,
                    modelReasoningEffort: Object.prototype.hasOwnProperty.call(patch, 'modelReasoningEffort')
                        ? patch.modelReasoningEffort ?? null
                        : current.modelReasoningEffort,
                    effort: Object.prototype.hasOwnProperty.call(patch, 'effort') ? patch.effort ?? null : current.effort
                }

                // Gate versioned fields against THIS summary's watermarks —
                // not the detail query. Global SSE covers every session;
                // requiring detail would force O(N) /sessions invalidation.
                // teamState is a summary no-op (not rendered on the list).
                if (patch.todos !== undefined && patch.todos.version >= current.todosUpdatedAt) {
                    nextSummary.todoProgress = computeTodoProgress(patch.todos.value)
                    nextSummary.todosUpdatedAt = patch.todos.version
                }
                if (patch.agentState !== undefined && patch.agentState.version >= current.agentStateVersion) {
                    nextSummary.pendingRequestsCount = computePendingRequestsCount(patch.agentState.value)
                    nextSummary.pendingRequestKinds = computePendingRequestKinds(patch.agentState.value)
                    nextSummary.pendingRequests = computePendingRequests(patch.agentState.value, nextSummary.updatedAt)
                    nextSummary.agentStateVersion = patch.agentState.version
                }
                if (patch.metadata !== undefined && patch.metadata.version >= current.metadataVersion) {
                    nextSummary.metadata = toSessionSummaryMetadata(patch.metadata.value)
                    nextSummary.metadataVersion = patch.metadata.version
                }

                patched = true
                // The keep-alive patch repeats every field every ~10s per active
                // session, and `activeAt` is the only one that actually moves.
                // Nothing renders `activeAt`, so writing a new object for it just
                // hands React Query a fresh reference and re-renders the list.
                if (isRenderIrrelevantPatch(current, nextSummary)) {
                    return previous
                }
                nextSessions[index] = nextSummary
                nextSessions.sort(sortSessionSummaries)
                return { ...previous, sessions: nextSessions }
            })
            return patched
        }

        const patchSessionDetail = (sessionId: string, patch: SessionPatch): boolean => {
            let patched = false
            queryClient.setQueryData<SessionResponse | undefined>(queryKeys.session(sessionId), (previous) => {
                if (!previous?.session) {
                    return previous
                }
                patched = true
                const nextSession = applySessionDetailPatch(previous.session, patch)
                if (!nextSession) {
                    return previous
                }
                return {
                    ...previous,
                    session: nextSession
                }
            })
            return patched
        }

        const removeSessionSummary = (sessionId: string) => {
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }
                const nextSessions = previous.sessions.filter((item) => item.id !== sessionId)
                if (nextSessions.length === previous.sessions.length) {
                    return previous
                }
                return { ...previous, sessions: nextSessions }
            })
        }

        const upsertMachine = (machine: Machine) => {
            queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
                if (!previous) {
                    return previous
                }

                const nextMachines = previous.machines.slice()
                const index = nextMachines.findIndex((item) => item.id === machine.id)
                if (!machine.active) {
                    if (index >= 0) {
                        nextMachines.splice(index, 1)
                        return { ...previous, machines: nextMachines }
                    }
                    return previous
                }

                if (index >= 0) {
                    nextMachines[index] = machine
                } else {
                    nextMachines.push(machine)
                }
                return { ...previous, machines: nextMachines }
            })
        }

        const removeMachine = (machineId: string) => {
            queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
                if (!previous) {
                    return previous
                }
                const nextMachines = previous.machines.filter((item) => item.id !== machineId)
                if (nextMachines.length === previous.machines.length) {
                    return previous
                }
                return { ...previous, machines: nextMachines }
            })
        }

        const handleSyncEvent = (event: SyncEvent) => {
            lastActivityAtRef.current = Date.now()

            if (event.type === 'heartbeat') {
                return
            }

            if (event.type === 'connection-changed') {
                const data = event.data
                if (data && typeof data === 'object' && 'subscriptionId' in data) {
                    const nextId = (data as { subscriptionId?: unknown }).subscriptionId
                    if (typeof nextId === 'string' && nextId.length > 0) {
                        setSubscriptionId(nextId)
                    }
                }
            }

            if (event.type === 'toast') {
                onToastRef.current?.(event)
                return
            }

            if (shouldInvalidateSessionListForEvent(scope, event.type)) {
                queueSessionListInvalidation()
            }

            if (scope === 'global' && MESSAGE_STREAM_EVENT_TYPES.has(event.type)) {
                if (event.type === 'message-received' && event.message.scheduledAt != null) {
                    queueSessionListInvalidation()
                }
                if (
                    event.type === 'message-cancelled'
                    || event.type === 'messages-consumed'
                    || event.type === 'scheduled-matured'
                ) {
                    queueSessionListInvalidation()
                }
                // The global `all` subscription also receives message-stream events.
                // Session-scoped SSE normally drives the message window, but during
                // reconnect gaps or while another session is selected, only the global
                // connection may be alive — still clear the queued bar / optimistic rows.
                if (event.type === 'messages-consumed') {
                    markMessagesConsumed(event.sessionId, event.localIds, event.invokedAt)
                }
                if (event.type === 'message-cancelled') {
                    removeOptimisticMessage(event.sessionId, event.messageId)
                }
                onEventRef.current(event)
                return
            }

            if (event.type === 'messages-consumed') {
                markMessagesConsumed(event.sessionId, event.localIds, event.invokedAt)
            }

            if (event.type === 'message-cancelled') {
                // Remove the cancelled message from the store. If the local
                // optimistic removal already cleared it, this is a no-op.
                removeOptimisticMessage(event.sessionId, event.messageId)
            }

            if (event.type === 'message-received') {
                ingestIncomingMessages(event.sessionId, [event.message])
            }

            if (event.type === 'session-added' || event.type === 'session-updated' || event.type === 'session-removed') {
                if (event.type === 'session-removed') {
                    removeSessionSummary(event.sessionId)
                    void queryClient.removeQueries({ queryKey: queryKeys.session(event.sessionId) })
                    clearMessageWindow(event.sessionId)
                } else if (isSessionRecord(event.data) && event.data.id === event.sessionId) {
                    queryClient.setQueryData<SessionResponse>(queryKeys.session(event.sessionId), { session: event.data })
                    upsertSessionSummary(event.data)
                } else {
                    const patch = getSessionPatch(event.data)
                    if (patch) {
                        const detailPatched = patchSessionDetail(event.sessionId, patch)
                        const summaryPatched = patchSessionSummary(event.sessionId, patch)

                        if (!detailPatched) {
                            queueSessionDetailInvalidation(event.sessionId)
                        }
                        if (!summaryPatched) {
                            queueSessionListInvalidation()
                        }
                        // tiann/hapi#893: piggybacked scratchlist token.
                        // The patch itself does not carry the entries -
                        // the timestamp is the change-detection signal,
                        // which triggers the dedicated query refetch.
                        if (Object.prototype.hasOwnProperty.call(patch, 'scratchlistUpdatedAt')) {
                            queueScratchlistInvalidation(event.sessionId)
                        }
                    } else {
                        queueSessionDetailInvalidation(event.sessionId)
                        queueSessionListInvalidation()
                    }
                }
            }

            if (event.type === 'machine-updated') {
                if (isMachineRecord(event.data)) {
                    upsertMachine(event.data)
                } else if (event.data === null) {
                    removeMachine(event.machineId)
                } else {
                    const patch = getMachinePatch(event.data)
                    if (patch?.active === false) {
                        removeMachine(event.machineId)
                    } else {
                        queueMachinesInvalidation()
                    }
                }
                if (event.data === undefined) {
                    queueMachinesInvalidation()
                }
            }

            onEventRef.current(event)
        }

        const handleMessage = (message: MessageEvent<string>) => {
            if (typeof message.data !== 'string') {
                return
            }

            let parsed: unknown
            try {
                parsed = JSON.parse(message.data)
            } catch {
                return
            }

            if (!isObject(parsed)) {
                return
            }
            if (typeof parsed.type !== 'string') {
                return
            }

            handleSyncEvent(parsed as SyncEvent)
        }

        eventSource.onmessage = handleMessage
        eventSource.onopen = () => {
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
                reconnectTimerRef.current = null
            }
            reconnectAttemptRef.current = 0
            disconnectNotified = false
            lastActivityAtRef.current = Date.now()
            onConnectRef.current?.()
        }
        eventSource.onerror = (error) => {
            onErrorRef.current?.(error)
            if (eventSource.readyState === EventSource.CLOSED) {
                requestReconnect('closed')
                return
            }
            notifyDisconnect('error')
        }

        const watchdogTimer = setInterval(() => {
            if (eventSourceRef.current !== eventSource) {
                return
            }
            if (getVisibilityState() === 'hidden') {
                return
            }
            if (Date.now() - lastActivityAtRef.current < HEARTBEAT_STALE_MS) {
                return
            }
            requestReconnect('heartbeat-timeout')
        }, HEARTBEAT_WATCHDOG_INTERVAL_MS)

        // When the tab becomes visible again, check immediately whether the
        // SSE connection went stale while hidden (the watchdog skips checks
        // for hidden tabs).  This avoids the user having to wait up to
        // HEARTBEAT_WATCHDOG_INTERVAL_MS after switching back.
        const onVisibilityChange = () => {
            if (getVisibilityState() !== 'visible') return
            if (eventSourceRef.current !== eventSource) return
            if (Date.now() - lastActivityAtRef.current >= HEARTBEAT_STALE_MS) {
                requestReconnect('visibility-recovery')
            }
        }
        document.addEventListener('visibilitychange', onVisibilityChange)

        return () => {
            clearInterval(watchdogTimer)
            document.removeEventListener('visibilitychange', onVisibilityChange)
            if (invalidationTimerRef.current) {
                clearTimeout(invalidationTimerRef.current)
                invalidationTimerRef.current = null
            }
            pendingInvalidationsRef.current.sessions = false
            pendingInvalidationsRef.current.machines = false
            pendingInvalidationsRef.current.sessionIds.clear()
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
                reconnectTimerRef.current = null
            }
            eventSource.close()
            if (eventSourceRef.current === eventSource) {
                eventSourceRef.current = null
            }
            setSubscriptionId(null)
        }
    }, [options.baseUrl, options.enabled, options.scope, options.token, scope, subscriptionKey, queryClient, reconnectNonce])

    return { subscriptionId }
}
