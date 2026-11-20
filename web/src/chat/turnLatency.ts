/**
 * turn_latency state machine (diag domain, L1).
 *
 * Measures the "send silence" distribution the 2026-11-18 latency research
 * could only observe qualitatively: a send POST settles in milliseconds, but
 * the first agent-side output takes 1-5s+. Wiring:
 *
 *   send POST settles (useSendMessage onSuccess)
 *     → noteSendSettled(sessionId)            arms the turn, setTrigger('send')
 *   next agent-side message-received for that session (useSSE handleMessage)
 *     → noteAgentMessage(sessionId, kind)     records firstAgentMs/firstEventKind
 *   turn completes (session thinking true→false via SSE session patch)
 *     → noteThinking(sessionId, false)        emits outcome 'completed'
 *   session switch / a newer send preempts a still-pending turn
 *     → emits outcome 'aborted' with only the fields already recorded
 *
 * Pure module (no React) so it is directly unit-testable; all timing flows
 * through Date.now() for fake-timer tests. Captures are routed through the
 * fail-silent telemetry facade and are themselves wrapped so a broken capture
 * can never disturb the send/SSE paths that feed this machine.
 */
import { telemetryClient } from '@/lib/telemetryClient'

export const TURN_LATENCY_KIND = 'turn_latency'

type PendingTurn = {
    sessionId: string
    sendSettledAt: number
    firstAgentMs?: number
    firstEventKind?: string
}

/** Only one pending turn per session; sessions are keyed so a background
 * session's activity cannot cancel the turn the user is watching. */
const pendingBySession = new Map<string, PendingTurn>()

/** Test seam: drop all state. */
export function resetTurnLatencyForTests(): void {
    pendingBySession.clear()
}

function emit(sessionId: string, outcome: 'completed' | 'aborted', turn: PendingTurn, now: number): void {
    const data: Record<string, unknown> = { outcome }
    if (turn.firstAgentMs !== undefined) {
        data.firstAgentMs = Math.max(0, Math.round(turn.firstAgentMs))
    }
    if (turn.firstEventKind !== undefined) {
        data.firstEventKind = turn.firstEventKind.slice(0, 64)
    }
    if (outcome === 'completed') {
        data.turnTotalMs = Math.max(0, now - turn.sendSettledAt)
    }
    // 'aborted' keeps only the fields already recorded — no synthesized
    // totals for a turn that never finished.
    telemetryClient.capture('diag', TURN_LATENCY_KIND, data, { sessionId })
}

/** A send POST settled successfully. Arms (or re-arms) the latency turn for
 * that session; a superseded pending turn is flushed as 'aborted'. */
export function noteSendSettled(sessionId: string): void {
    try {
        const now = Date.now()
        const previous = pendingBySession.get(sessionId)
        if (previous) {
            pendingBySession.delete(sessionId)
            emit(sessionId, 'aborted', previous, now)
        }
        pendingBySession.set(sessionId, { sessionId, sendSettledAt: now })
        telemetryClient.setTrigger('send')
    } catch {
        // fail-silent
    }
}

/** The first agent-side message-received after the send settles breaks the
 * silence; later agent messages for the same turn are ignored. */
export function noteAgentMessage(sessionId: string, eventKind: string): void {
    try {
        const turn = pendingBySession.get(sessionId)
        if (!turn || turn.firstAgentMs !== undefined) return
        turn.firstAgentMs = Date.now() - turn.sendSettledAt
        turn.firstEventKind = eventKind
    } catch {
        // fail-silent
    }
}

/** SSE session patch reported a thinking transition. thinking=true starts
 * nothing here (the send arms the turn); thinking=false completes it. */
export function noteThinking(sessionId: string, thinking: boolean): void {
    try {
        if (thinking) return
        const turn = pendingBySession.get(sessionId)
        if (!turn) return
        pendingBySession.delete(sessionId)
        telemetryClient.setTrigger(null)
        emit(sessionId, 'completed', turn, Date.now())
    } catch {
        // fail-silent
    }
}

/** The user left this session (visit close). Flush its pending turn as
 * 'aborted' so it is not attributed to a later visit. */
export function noteVisitClosed(sessionId: string): void {
    try {
        const turn = pendingBySession.get(sessionId)
        if (!turn) return
        pendingBySession.delete(sessionId)
        telemetryClient.setTrigger(null)
        emit(sessionId, 'aborted', turn, Date.now())
    } catch {
        // fail-silent
    }
}
