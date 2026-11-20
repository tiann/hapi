/**
 * SSE observation: episode lifecycles (perf), anomaly signals (diag).
 *
 * Episode = a connection's lifecycle record for analysis; anomaly = an
 * incident signal for alerting. One disconnect yields at most one of each —
 * they are different views, not double counting.
 *
 *   - Episodes are started/ended by useSSE's connection effect; every parsed
 *     event and its wire bytes (message.data.length * 2, the hub sseManager
 *     serialized.length*2 convention) are counted in handleMessage. A
 *     connect handshake that admits a full resync for the SAME subscription
 *     (a prior episode of that subscription ended) emits the gap anomaly
 *     with the outage duration — session switches start a different
 *     subscription and are never misread as gaps.
 *   - App.tsx's disconnect handlers feed the disconnect anomaly (five-value
 *     reason code + hidden-at-drop) and the reconnect-storm signal
 *     (>= STORM_THRESHOLD disconnects inside STORM_WINDOW_MS per scope).
 *   - The stall predicate is semantic, not unconditional: only while the
 *     session's agent is thinking (turn in progress) AND no message-received
 *     arrived for STALL_MS. Long tool calls and queue waits are normal
 *     silence and never produce a stall.
 *
 * Bookkeeping is keyed by scope ('global' | 'full') — the app runs exactly
 * one connection per scope. Pure module (no React) for fake-timer testing;
 * every entry point is fail-silent.
 */
import { telemetryClient } from '@/lib/telemetryClient'

export const SSE_STALL_MS = 30_000
export const SSE_STORM_WINDOW_MS = 5 * 60 * 1000
export const SSE_STORM_THRESHOLD = 3

type Episode = {
    scope: string
    startedAt: number
    connectedAt: number | null
    subscriptionId: string | null
    resume: 'ok' | 'gap' | null
    gapMs: number | null
    eventsCount: number
    bytesSent: number
    ended: boolean
}

/** scope → last ended-at (gap math for the NEXT episode of that scope). */
const lastEpisodeEndAt = new Map<string, number>()
/** scope → disconnect timestamps inside the storm window. */
const stormDisconnects = new Map<string, number[]>()

// ---- stall tracker (session-scoped connections only) -----------------------

type StallState = {
    thinking: boolean
    timer: ReturnType<typeof setTimeout> | null
    stalled: boolean
    /** When the current silent stretch began (turn start or last message). */
    silenceSince: number
}

const stallBySession = new Map<string, StallState>()

function clearStallTimer(state: StallState): void {
    if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
    }
}

function armStallTimer(sessionId: string, state: StallState): void {
    clearStallTimer(state)
    if (state.stalled) return // one stall per silent stretch
    state.silenceSince = Date.now()
    state.timer = setTimeout(() => {
        state.timer = null
        try {
            if (!state.thinking || state.stalled) return
            const stallMs = Date.now() - state.silenceSince
            if (stallMs < SSE_STALL_MS) return
            state.stalled = true
            telemetryClient.capture('diag', 'sse_anomaly', {
                anomaly: 'stall',
                stallMs
            }, { sessionId })
        } catch {
            // fail-silent
        }
    }, SSE_STALL_MS)
}

/** The session-scoped SSE subscription is live: track thinking-phase silence
 * for this session. */
export function armSessionStall(sessionId: string): void {
    try {
        if (!stallBySession.has(sessionId)) {
            stallBySession.set(sessionId, { thinking: false, timer: null, stalled: false, silenceSince: Date.now() })
        }
    } catch {
        // fail-silent
    }
}

export function disarmSessionStall(sessionId: string): void {
    try {
        const state = stallBySession.get(sessionId)
        if (!state) return
        clearStallTimer(state)
        stallBySession.delete(sessionId)
    } catch {
        // fail-silent
    }
}

/** SSE session patch reported thinking. Only thinking=true starts the
 * silence clock; thinking=false clears it (turn ended = silence is normal). */
export function noteSessionThinking(sessionId: string, thinking: boolean): void {
    try {
        const state = stallBySession.get(sessionId)
        if (!state) return
        state.thinking = thinking
        if (thinking) {
            armStallTimer(sessionId, state)
        } else {
            clearStallTimer(state)
            state.stalled = false
        }
    } catch {
        // fail-silent
    }
}

/** A message-received event arrived for the session: the pipe is alive. */
export function noteSessionMessage(sessionId: string): void {
    try {
        const state = stallBySession.get(sessionId)
        if (!state) return
        state.stalled = false
        if (state.thinking) {
            armStallTimer(sessionId, state)
        }
    } catch {
        // fail-silent
    }
}

// ---- episode lifecycle (called from useSSE's connection effect) -----------

export interface SseEpisodeHandle {
    /** The server's connection-changed handshake arrived. */
    noteConnect(subscriptionId: string | null, resumed: boolean): void
    /** One parsed SSE event; bytes follow the serialized.length * 2 metric. */
    noteEvent(wireBytes: number): void
    /** Terminal; idempotent. reason = five-value reconnect code or
     * 'unsubscribe' for a clean teardown (scope change / unmount). */
    end(reason: string): void
}

/**
 * Start an episode. `subscriptionKey` is useSSE's subscription identity
 * (scope + all/sessionId/machineId): gap math only compares episodes of the
 * SAME subscription, so switching sessions (teardown + fresh subscription)
 * is not misread as an outage.
 */
export function startSseEpisode(scope: string, subscriptionKey: string): SseEpisodeHandle {
    const key = `${scope}|${subscriptionKey}`
    const episode: Episode = {
        scope,
        startedAt: Date.now(),
        connectedAt: null,
        subscriptionId: null,
        resume: null,
        gapMs: null,
        eventsCount: 0,
        bytesSent: 0,
        ended: false
    }
    return {
        noteConnect(subscriptionId, resumed) {
            try {
                if (episode.ended || episode.connectedAt !== null) return
                episode.connectedAt = Date.now()
                if (subscriptionId) episode.subscriptionId = subscriptionId
                const previousEnd = lastEpisodeEndAt.get(key)
                if (!resumed && previousEnd !== undefined) {
                    // A prior episode of this same subscription ended, and the
                    // handshake admits a full resync: events were missed.
                    episode.resume = 'gap'
                    episode.gapMs = Math.max(0, episode.connectedAt - previousEnd)
                    telemetryClient.capture('diag', 'sse_anomaly', {
                        anomaly: 'gap',
                        outageMs: episode.gapMs,
                        resumedAfterGap: true
                    })
                } else {
                    episode.resume = 'ok'
                }
            } catch {
                // fail-silent
            }
        },
        noteEvent(wireBytes) {
            try {
                if (episode.ended) return
                episode.eventsCount += 1
                if (Number.isFinite(wireBytes) && wireBytes > 0) {
                    episode.bytesSent += Math.round(wireBytes)
                }
            } catch {
                // fail-silent
            }
        },
        end(reason) {
            try {
                if (episode.ended) return
                episode.ended = true
                const endAt = Date.now()
                lastEpisodeEndAt.set(key, endAt)
                const data: Record<string, unknown> = {
                    scope: episode.scope.slice(0, 32),
                    durationMs: Math.max(0, endAt - episode.startedAt),
                    eventsCount: episode.eventsCount
                }
                if (episode.subscriptionId) data.subscriptionId = episode.subscriptionId.slice(0, 64)
                if (episode.resume) data.resume = episode.resume
                if (episode.connectedAt !== null) {
                    data.connectMs = Math.max(0, episode.connectedAt - episode.startedAt)
                }
                if (episode.eventsCount > 0) data.bytesSent = episode.bytesSent
                if (episode.gapMs !== null) data.gapMs = episode.gapMs
                data.disconnectReason = reason.slice(0, 32)
                telemetryClient.capture('perf', 'sse_episode', data)
            } catch {
                // fail-silent
            }
        }
    }
}

// ---- App-level anomaly signals (called from App.tsx's SSE handlers) -------

/** App's onDisconnect: one disconnect anomaly + storm bookkeeping. Scope is
 * 'global' or 'full' (the app runs one connection per scope). */
export function noteSseDisconnected(scope: string, reason: string, hidden: boolean): void {
    try {
        telemetryClient.capture('diag', 'sse_anomaly', {
            anomaly: 'disconnect',
            reason: reason.slice(0, 32),
            hiddenAtDrop: hidden
        })
        const now = Date.now()
        const window = (stormDisconnects.get(scope) ?? []).filter((at) => now - at <= SSE_STORM_WINDOW_MS)
        window.push(now)
        stormDisconnects.set(scope, window)
        if (window.length >= SSE_STORM_THRESHOLD) {
            // Reported once per storm crossing; the window then starts empty
            // so a follow-up storm needs a full fresh set of drops.
            stormDisconnects.set(scope, [])
            telemetryClient.capture('diag', 'sse_anomaly', {
                anomaly: 'reconnect-storm',
                reason: reason.slice(0, 32),
                hiddenAtDrop: hidden
            })
        }
    } catch {
        // fail-silent
    }
}

/** Test seam. */
export function resetSseTelemetryForTests(): void {
    lastEpisodeEndAt.clear()
    stormDisconnects.clear()
    for (const state of stallBySession.values()) {
        clearStallTimer(state)
    }
    stallBySession.clear()
}
