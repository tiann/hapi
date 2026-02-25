import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isObject, toSessionSummary } from '@hapi/protocol'
import type {
    Machine,
    MachinesResponse,
    Session,
    SessionResponse,
    SessionsResponse,
    SessionSummary,
    SyncEvent
} from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow, ingestIncomingMessages } from '@/lib/message-window-store'

type SSESubscription = {
    all?: boolean
    sessionId?: string
    machineId?: string
}

type VisibilityState = 'visible' | 'hidden'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

const HEARTBEAT_STALE_MS = 90_000
const HEARTBEAT_WATCHDOG_INTERVAL_MS = 10_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_JITTER_MS = 500
const INVALIDATION_BATCH_MS = 16

type SessionPatch = Partial<Pick<Session, 'active' | 'thinking' | 'activeAt' | 'updatedAt' | 'permissionMode' | 'modelMode'>>

function sortSessionSummaries(left: SessionSummary, right: SessionSummary): number {
    if (left.active !== right.active) {
        return left.active ? -1 : 1
    }
    if (left.active && left.pendingRequestsCount !== right.pendingRequestsCount) {
        return right.pendingRequestsCount - left.pendingRequestsCount
    }
    return right.updatedAt - left.updatedAt
}

function hasRecordShape(value: unknown): value is Record<string, unknown> {
    return isObject(value)
}

function isSessionRecord(value: unknown): value is Session {
    if (!hasRecordShape(value)) {
        return false
    }
    return typeof value.id === 'string'
        && typeof value.active === 'boolean'
        && typeof value.activeAt === 'number'
        && typeof value.updatedAt === 'number'
        && typeof value.thinking === 'boolean'
}

function getSessionPatch(value: unknown): SessionPatch | null {
    if (!hasRecordShape(value)) {
        return null
    }

    const patch: SessionPatch = {}
    let hasKnownPatch = false

    if (typeof value.active === 'boolean') {
        patch.active = value.active
        hasKnownPatch = true
    }
    if (typeof value.thinking === 'boolean') {
        patch.thinking = value.thinking
        hasKnownPatch = true
    }
    if (typeof value.activeAt === 'number') {
        patch.activeAt = value.activeAt
        hasKnownPatch = true
    }
    if (typeof value.updatedAt === 'number') {
        patch.updatedAt = value.updatedAt
        hasKnownPatch = true
    }
    if (typeof value.permissionMode === 'string') {
        patch.permissionMode = value.permissionMode as Session['permissionMode']
        hasKnownPatch = true
    }
    if (typeof value.modelMode === 'string') {
        patch.modelMode = value.modelMode as Session['modelMode']
        hasKnownPatch = true
    }

    return hasKnownPatch ? patch : null
}

function hasUnknownSessionPatchKeys(value: unknown): boolean {
    if (!hasRecordShape(value)) {
        return false
    }
    const knownKeys = new Set(['active', 'thinking', 'activeAt', 'updatedAt', 'permissionMode', 'modelMode'])
    return Object.keys(value).some((key) => !knownKeys.has(key))
}

function isMachineMetadata(value: unknown): value is Machine['metadata'] {
    if (value === null) {
        return true
    }
    if (!hasRecordShape(value)) {
        return false
    }
    return typeof value.host === 'string'
        && typeof value.platform === 'string'
        && typeof value.happyCliVersion === 'string'
}

function isMachineRecord(value: unknown): value is Machine {
    if (!hasRecordShape(value)) {
        return false
    }
    return typeof value.id === 'string'
        && typeof value.active === 'boolean'
        && isMachineMetadata(value.metadata)
}

function isInactiveMachinePatch(value: unknown): boolean {
    return hasRecordShape(value) && value.active === false
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
    }>({ sessions: false, machines: false, sessionIds: new Set() })
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

    const subscriptionKey = useMemo(() => {
        return `${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}`
    }, [subscription.all, subscription.sessionId, subscription.machineId])

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
            if (!pending.sessions && !pending.machines && pending.sessionIds.size === 0) {
                return
            }

            const shouldInvalidateSessions = pending.sessions
            const shouldInvalidateMachines = pending.machines
            const sessionIds = Array.from(pending.sessionIds)

            pending.sessions = false
            pending.machines = false
            pending.sessionIds.clear()

            const tasks: Array<Promise<unknown>> = []
            if (shouldInvalidateSessions) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.sessions }))
            }
            for (const sessionId of sessionIds) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }))
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

        const queueMachinesInvalidation = () => {
            pendingInvalidationsRef.current.machines = true
            scheduleInvalidationFlush()
        }

        const upsertSessionSummary = (session: Session) => {
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }

                const summary = toSessionSummary(session)
                const nextSessions = previous.sessions.slice()
                const existingIndex = nextSessions.findIndex((item) => item.id === session.id)
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
                    updatedAt: patch.updatedAt ?? current.updatedAt,
                    modelMode: patch.modelMode ?? current.modelMode
                }

                patched = true
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
                return {
                    ...previous,
                    session: {
                        ...previous.session,
                        ...patch
                    }
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
                        if (hasUnknownSessionPatchKeys(event.data)) {
                            queueSessionDetailInvalidation(event.sessionId)
                            queueSessionListInvalidation()
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
                } else if (event.data === null || isInactiveMachinePatch(event.data)) {
                    removeMachine(event.machineId)
                } else if (!hasRecordShape(event.data) || typeof event.data.activeAt !== 'number') {
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

        return () => {
            clearInterval(watchdogTimer)
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
    }, [options.baseUrl, options.enabled, options.token, subscriptionKey, queryClient, reconnectNonce])

    return { subscriptionId }
}
