import type { ApiClient } from '@/api/client'
import { ApiError } from '@/api/client'
import { randomId } from './randomId'
import { SessionReadMutationSchema, SessionReadSnapshotSchema, type SessionReadMutation, type SessionReadState } from '@hapi/protocol'
import {
    applySessionReadStates, configureSessionReadSync, disconnectSessionReadSync, getLegacyManualUnread
} from './sessionLastSeen'

type ReadApi = Pick<ApiClient, 'getSessionReadState' | 'updateSessionReadState' | 'getSessions'>
type PendingMutation = SessionReadMutation & { baseVersion: number }

/** Hub identity includes namespace, not the short-lived JWT or user transport identity. */
export function sessionReadScope(baseUrl: string, token: string): string {
    const payload: unknown = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    if (!payload || typeof payload !== 'object' || !('ns' in payload) || typeof payload.ns !== 'string') {
        throw new Error('Missing read-state namespace')
    }
    return JSON.stringify([baseUrl, payload.ns])
}

export function startSessionReadSync(api: ReadApi, scope: string) {
    const states = new Map<string, SessionReadState>()
    let stopped = false
    let ready = false
    let running = false
    let refreshPromise: Promise<void> | null = null
    let followupRefresh: Promise<void> | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    // Every controller owns a distinct durable queue, including duplicated tabs.
    // Closed/crashed controllers are discovered by scope instead of sessionStorage.
    const tabId = randomId()
    const cacheKey = `hapi.sessionReadSync.v1:${scope}`
    const queuePrefix = `${cacheKey}:pending:`
    const queueKey = `${queuePrefix}${tabId}`
    const ownerPrefix = `${cacheKey}:owner:`
    const ownerKey = `${ownerPrefix}${tabId}`
    const ownerTtlMs = 60000
    let pending: PendingMutation[] = []
    let inFlight = new Set<PendingMutation>()
    const parsePending = (value: unknown): PendingMutation | null => {
        const parsed = SessionReadMutationSchema.safeParse(value)
        if (!parsed.success) return null
        const base = (value as { baseVersion?: unknown }).baseVersion
        return { ...parsed.data, baseVersion: typeof base === 'number' && Number.isSafeInteger(base) && base >= 0
            ? base : parsed.data.expectedVersion }
    }
    try {
        const cached = SessionReadSnapshotSchema.safeParse(JSON.parse(localStorage.getItem(cacheKey) ?? 'null'))
        if (cached.success) for (const state of cached.data.states) states.set(state.sessionId, state)
        const queue: unknown = JSON.parse(localStorage.getItem(queueKey) ?? '[]')
        if (Array.isArray(queue)) {
            // Reuse the wire validator, including numeric bounds, for persisted queue data.
            for (const value of queue) {
                const parsed = parsePending(value)
                if (parsed) pending.push(parsed)
            }
        }
    } catch { /* Storage is optional; online synchronization still works. */ }

    const persist = () => {
        try {
            localStorage.setItem(cacheKey, JSON.stringify({ states: [...states.values()] }))
            if (pending.length) localStorage.setItem(queueKey, JSON.stringify(pending))
            else localStorage.removeItem(queueKey)
            return true
        } catch { /* Storage can be unavailable in private browsing. */ }
        return false
    }
    const releaseOwnership = () => {
        try { localStorage.removeItem(ownerKey) } catch { /* Optional storage. */ }
    }
    const renewOwnership = () => {
        try { localStorage.setItem(ownerKey, String(Date.now())) } catch { /* Optional storage. */ }
    }
    const recoverOrphanedQueues = () => {
        let recovered = false
        try {
            const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
            const knownIds = new Set(pending.map(item => item.mutationId))
            for (const key of keys) {
                if (!key?.startsWith(queuePrefix) || key === queueKey) continue
                const lease = `${ownerPrefix}${key.slice(queuePrefix.length)}`
                const renewedAt = Number(localStorage.getItem(lease))
                if (renewedAt > Date.now() - ownerTtlMs) continue
                const raw = localStorage.getItem(key)
                let queue: unknown
                try { queue = JSON.parse(raw ?? 'null') } catch { continue }
                if (!Array.isArray(queue)) continue
                for (const value of queue) {
                    const parsed = parsePending(value)
                    if (!parsed || knownIds.has(parsed.mutationId)) continue
                    pending.push(parsed)
                    recovered = true
                    knownIds.add(parsed.mutationId)
                }
                // Copy durably before removing the source; failed writes retain it.
                // Concurrent recovery is harmless: mutation IDs are idempotent at the Hub.
                if (persist() && localStorage.getItem(key) === raw) {
                    localStorage.removeItem(key)
                    localStorage.removeItem(lease)
                }
            }
        } catch { /* Online sync must still work when storage is inaccessible. */ }
        return recovered
    }
    const publish = () => {
        const visible = new Map(states)
        for (const mutation of pending) {
            const current = visible.get(mutation.sessionId)
            if ((current?.version ?? 0) !== mutation.expectedVersion) continue
            const seen = mutation.kind === 'seen'
            visible.set(mutation.sessionId, {
                sessionId: mutation.sessionId,
                version: mutation.expectedVersion + 1,
                lastSeenAt: seen ? Math.max(current?.lastSeenAt ?? 0, mutation.activityAt)
                    : Math.min(current?.lastSeenAt ?? 0, Math.max(0, mutation.activityAt - 1)),
                manualUnreadAt: seen
                    ? (mutation.activityAt >= (current?.manualUnreadAt ?? 0) ? null : current!.manualUnreadAt)
                    : mutation.activityAt
            })
        }
        applySessionReadStates([...visible.values()], true, ready)
    }
    const apply = (incoming: SessionReadState[]) => {
        if (stopped) return
        for (const state of incoming) {
            if (state.version > (states.get(state.sessionId)?.version ?? 0)) states.set(state.sessionId, state)
        }
        persist()
        publish()
    }
    const schedule = () => {
        if (stopped || retry) return
        retry = setTimeout(() => { retry = undefined; void refresh() }, 5000)
    }
    const flush = async () => {
        if (!ready || running || stopped) return
        running = true
        let singleTarget = false
        try {
            while (pending.length && !stopped) {
                // Batch independent targets, but serialize each session's intent order.
                // Never rebase an offline action over a peer's newer version.
                const targets = new Set<string>()
                const batch = pending.filter(mutation => {
                    if (targets.has(mutation.sessionId) || targets.size >= (singleTarget ? 1 : 500)) return false
                    targets.add(mutation.sessionId)
                    return true
                })
                let response
                try {
                    inFlight = new Set(batch)
                    response = await api.updateSessionReadState(batch)
                } catch (error) {
                    if (stopped) return
                    if (error instanceof ApiError && (error.status === 400 || error.status === 404)) {
                        // A deleted target rolls back a batch. Split it to retain valid work.
                        if (batch.length > 1) singleTarget = true
                        else pending = pending.filter(item => item !== batch[0])
                        persist()
                        continue
                    }
                    throw error
                } finally { inFlight.clear() }
                if (stopped) return
                const rejected = new Map(batch.filter(item => !response.acceptedSessionIds.includes(item.sessionId))
                    .map(item => [item.sessionId, item.baseVersion]))
                // Drop the entire dependent offline chain on conflict. Its projected
                // versions might otherwise accidentally match an intervening peer write.
                pending = pending.filter(item => !batch.includes(item)
                    && (!rejected.has(item.sessionId) || item.baseVersion > rejected.get(item.sessionId)!))
                apply(response.states)
            }
        } catch {
            if (stopped) return
            schedule()
        } finally { running = false }
    }
    configureSessionReadSync(scope, (kind, sessions) => {
        for (const { id, updatedAt } of sessions) {
            const confirmedVersion = states.get(id)?.version ?? 0
            const parent = [...inFlight].find(item => item.sessionId === id && item.expectedVersion >= confirmedVersion)
            const baseVersion = parent?.baseVersion ?? confirmedVersion
            // A fresh intent based on an observed peer update supersedes unsent
            // intents from older state, but does not depend on a stale in-flight write.
            pending = pending.filter(item => item.sessionId !== id || item.baseVersion >= confirmedVersion || inFlight.has(item))
            const expectedVersion = pending.filter(item => item.sessionId === id && item.baseVersion === baseVersion)
                .reduce((version, item) => Math.max(version, item.expectedVersion + 1), baseVersion)
            pending.push({ mutationId: randomId(), sessionId: id, kind, activityAt: updatedAt, expectedVersion, baseVersion })
        }
        persist()
        // Let the optimistic local update finish before an immediate mocked response.
        void Promise.resolve().then(flush)
    })
    if (states.size || pending.length) publish()

    async function refresh(): Promise<void> {
        if (stopped) return
        if (refreshPromise) {
            // A connection handshake must observe a snapshot captured after the
            // subscription registered. Coalesce overlaps into one subsequent GET.
            followupRefresh ??= refreshPromise.then(() => {
                followupRefresh = null
                return refresh()
            })
            return followupRefresh
        }
        refreshPromise = (async () => {
            try {
                renewOwnership()
                recoverOrphanedQueues()
                const snapshot = await api.getSessionReadState()
                if (stopped) return
                apply(snapshot.states)
                if (!ready) {
                    // Import only explicit unread markers and only for a session whose
                    // current activity still matches. Never promote legacy seen receipts.
                    const legacy = getLegacyManualUnread(scope)
                    if (Object.keys(legacy).length) {
                        const sessions = await api.getSessions()
                        if (stopped) return
                        for (const session of sessions.sessions) {
                            if (!states.has(session.id) && legacy[session.id] === session.updatedAt) {
                                pending.push({ mutationId: randomId(), sessionId: session.id, kind: 'import-unread', activityAt: session.updatedAt, expectedVersion: 0, baseVersion: 0 })
                            }
                        }
                    }
                }
                ready = true
                publish()
                await flush()
            } catch { schedule() }
            finally { refreshPromise = null }
        })()
        return refreshPromise
    }
    // Keep live tab queues separate; recover abandoned queues even when another
    // tab stays open through the original owner's crash. pagehide handles normal closes.
    const ownershipTimer = setInterval(() => {
        renewOwnership()
        if (recoverOrphanedQueues()) void refresh()
    }, 10000)
    window.addEventListener('pagehide', releaseOwnership)
    void refresh()
    return {
        refresh,
        receive: apply,
        stop() {
            stopped = true
            clearTimeout(retry)
            clearInterval(ownershipTimer)
            window.removeEventListener('pagehide', releaseOwnership)
            releaseOwnership()
            disconnectSessionReadSync()
        }
    }
}
