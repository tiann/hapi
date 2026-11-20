/**
 * session_open / session_close / session_pause_resume (ux domain).
 *
 * Visit semantics (PWA long-background = mobile's dominant form, pinned in
 * shared/src/telemetry.ts):
 *   - hidden ≤ 15min: same visit, split by pause/resume events (L2);
 *   - hidden > 15min: the tracker emits session_close(exit='hidden-timeout')
 *     and marks the visit timed out; when the page becomes visible again and
 *     SessionPage is still mounted (no navigation, no session switch), a
 *     synthetic session_open(entry='resume-after-timeout') starts a NEW visit
 *     whose dwell excludes the background span. The timeout is detected BOTH
 *     by a setTimeout backstop AND on the visible transition by comparing
 *     timestamps — mobile suspends the runtime (timers freeze) for the whole
 *     background span, so the timer alone would never fire there.
 *
 * Two halves:
 *   1. an entry registry — handleSelectSession / SW notification clicks
 *      record WHY the next session open happens; the SessionPage effect
 *      consumes it (one-shot, staleness-bounded) and falls back to URL
 *      params (permission-jump / search-hit) or 'url-direct';
 *   2. a pure visit tracker (no React) owning dwell accounting, the hidden
 *      timeout, pagehide, and the close/open emission — directly testable
 *      with fake timers.
 */
import { telemetryClient } from '@/lib/telemetryClient'

export type SessionEntry =
    | 'list-click'
    | 'search-hit'
    | 'permission-jump'
    | 'deep-link'
    | 'url-direct'
    | 'resume-after-timeout'

/** A recorded entry older than this is treated as unrelated to the open it
 * would explain (navigation lost a race, slow resume, etc.). */
const ENTRY_STALENESS_MS = 30_000
/** hidden beyond this closes the visit (mobile backgrounding). */
export const VISIT_HIDDEN_TIMEOUT_MS = 15 * 60 * 1000

type RecordedEntry = {
    sessionId: string
    entry: Exclude<SessionEntry, 'resume-after-timeout'>
    navTargetMessageId?: string
    at: number
}

const recordedEntries = new Map<string, RecordedEntry>()
/** The session this device had open most recently (for fromSessionId). */
let lastOpenSessionId: string | null = null

export function getLastOpenSessionId(): string | null {
    return lastOpenSessionId
}

/** Test seam. */
export function resetSessionVisitTelemetryForTests(): void {
    recordedEntries.clear()
    lastOpenSessionId = null
}

/** Record why the NEXT open of `sessionId` happens (navigation intent). */
export function recordSessionEntry(
    sessionId: string,
    entry: Exclude<SessionEntry, 'resume-after-timeout'>,
    navTargetMessageId?: string
): void {
    try {
        recordedEntries.set(sessionId, { sessionId, entry, navTargetMessageId, at: Date.now() })
    } catch {
        // fail-silent
    }
}

function consumeSessionEntry(sessionId: string, now: number): RecordedEntry | null {
    const recorded = recordedEntries.get(sessionId)
    if (!recorded) return null
    recordedEntries.delete(sessionId)
    if (now - recorded.at > ENTRY_STALENESS_MS) return null
    return recorded
}

/** Resolve the entry for a fresh session open: recorded intent first, then
 * URL params (a pending request or a message target in the link), else a
 * plain direct URL entry. Exported for tests. */
export function resolveOpenEntry(
    sessionId: string,
    searchHint: { messageId?: string | null; pendingRequestId?: string | null } | undefined,
    now: number = Date.now()
): { entry: SessionEntry; navTargetMessageId?: string } {
    const recorded = consumeSessionEntry(sessionId, now)
    if (recorded) {
        return { entry: recorded.entry, navTargetMessageId: recorded.navTargetMessageId }
    }
    if (searchHint?.pendingRequestId) {
        return { entry: 'permission-jump' }
    }
    if (searchHint?.messageId) {
        return { entry: 'search-hit', navTargetMessageId: searchHint.messageId }
    }
    return { entry: 'url-direct' }
}

export type VisitExit = 'switch' | 'navigate-away' | 'pagehide' | 'hidden-timeout'

export type VisitCaptureFn = (kind: 'session_open' | 'session_close' | 'session_pause_resume', data: Record<string, unknown>) => void

export interface VisitTracker {
    open(entry: SessionEntry, fromSessionId?: string, navTargetMessageId?: string): void
    onVisibleChange(): void
    pageHide(): void
    close(exit: VisitExit): void
    /** True once a terminal close has been emitted for the current visit. */
    isClosed(): boolean
    /** True when the visit was closed by the hidden timeout and a visible
     * transition would start a resume-after-timeout visit. */
    isTimedOut(): boolean
}

/**
 * Pure dwell/visit machine. `capture` receives fully-populated data payloads
 * (schema-validated upstream); the default wiring routes to the telemetry
 * facade with sessionId bound.
 */
export function createVisitTracker(options: {
    sessionId: string
    now?: () => number
    getVisibilityState?: () => 'visible' | 'hidden'
    getSeenTail?: () => boolean | undefined
    capture?: VisitCaptureFn
    hiddenTimeoutMs?: number
}): VisitTracker {
    const {
        sessionId,
        getSeenTail,
        capture = (kind, data) => telemetryClient.capture('ux', kind, data, { sessionId }),
    } = options
    const now = options.now ?? Date.now
    const getVisibilityState = options.getVisibilityState
        ?? (() => (typeof document !== 'undefined' && document.visibilityState === 'visible' ? 'visible' : 'hidden'))
    const hiddenTimeoutMs = options.hiddenTimeoutMs ?? VISIT_HIDDEN_TIMEOUT_MS

    let visitStart = 0
    let visibleDwell = 0
    let visibleSince: number | null = null
    let closed = false
    let timedOut = false
    let paused = false
    let hiddenSince: number | null = null
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null

    const cancelHiddenTimer = () => {
        if (hiddenTimer !== null) {
            clearTimeout(hiddenTimer)
            hiddenTimer = null
        }
    }

    const startVisit = () => {
        visitStart = now()
        visibleDwell = 0
        visibleSince = getVisibilityState() === 'visible' ? visitStart : null
        closed = false
        timedOut = false
        paused = false
        hiddenSince = null
        cancelHiddenTimer()
    }

    /** shared hidden-timeout semantics: close the visit (exit='hidden-timeout')
     *  and arm the synthetic re-open — used by BOTH the setTimeout backstop
     *  (desktop hidden tab) and the visible-transition check (mobile, where
     *  the timer is frozen for the whole suspended runtime and would never
     *  fire). */
    const emitTimeoutClose = () => {
        cancelHiddenTimer()
        paused = false
        closed = true
        timedOut = true
        const seenTail = getSeenTail?.()
        const data: Record<string, unknown> = {
            wallDwellMs: Math.max(0, now() - visitStart),
            visibleDwellMs: Math.max(0, visibleDwell),
            exit: 'hidden-timeout'
        }
        if (seenTail !== undefined) data.seenTail = seenTail
        capture('session_close', data)
        telemetryClient.setTrigger(null)
    }

    return {
        open(entry, fromSessionId, navTargetMessageId) {
            try {
                startVisit()
                lastOpenSessionId = sessionId
                const data: Record<string, unknown> = { entry, openedAt: now() }
                if (fromSessionId && fromSessionId !== sessionId) {
                    data.fromSessionId = fromSessionId.slice(0, 128)
                }
                if (navTargetMessageId) {
                    data.navTargetMessageId = navTargetMessageId.slice(0, 128)
                }
                capture('session_open', data)
                telemetryClient.setTrigger('session-open')
            } catch {
                // fail-silent
            }
        },
        onVisibleChange() {
            try {
                if (closed && !timedOut) return
                const visibility = getVisibilityState()
                if (visibility === 'hidden') {
                    if (paused || closed) return
                    paused = true
                    hiddenSince = now()
                    if (visibleSince !== null) {
                        visibleDwell += now() - visibleSince
                        visibleSince = null
                    }
                    capture('session_pause_resume', { kind: 'pause', dwellSoFarMs: visibleDwell })
                    cancelHiddenTimer()
                    hiddenTimer = setTimeout(() => {
                        hiddenTimer = null
                        try {
                            if (closed || !paused) return
                            if (getVisibilityState() !== 'hidden') return
                            emitTimeoutClose()
                        } catch {
                            // fail-silent
                        }
                    }, hiddenTimeoutMs)
                    return
                }
                // visible again
                if (timedOut) {
                    // Synthetic re-open: a NEW visit whose dwell starts here,
                    // excluding the background span entirely.
                    this.open('resume-after-timeout')
                    return
                }
                if (paused && !closed
                    && hiddenSince !== null
                    && now() - hiddenSince >= hiddenTimeoutMs) {
                    // Mobile suspended-runtime path: the hiddenTimer never fired
                    // (timers are frozen while suspended), but wall-clock says
                    // the visit timed out — same close+open pair as the timer
                    // path, judged by timestamp instead of the timer.
                    emitTimeoutClose()
                    this.open('resume-after-timeout')
                    return
                }
                if (!paused || closed) return
                paused = false
                hiddenSince = null
                cancelHiddenTimer()
                visibleSince = now()
                capture('session_pause_resume', { kind: 'resume', dwellSoFarMs: visibleDwell })
            } catch {
                // fail-silent
            }
        },
        pageHide() {
            this.close('pagehide')
        },
        close(exit) {
            try {
                if (closed) return
                closed = true
                cancelHiddenTimer()
                if (visibleSince !== null) {
                    visibleDwell += now() - visibleSince
                    visibleSince = null
                }
                const seenTail = getSeenTail?.()
                const data: Record<string, unknown> = {
                    wallDwellMs: Math.max(0, now() - visitStart),
                    visibleDwellMs: Math.max(0, visibleDwell),
                    exit
                }
                if (seenTail !== undefined) data.seenTail = seenTail
                capture('session_close', data)
                telemetryClient.setTrigger(null)
            } catch {
                // fail-silent
            }
        },
        isClosed() {
            return closed
        },
        isTimedOut() {
            return timedOut
        }
    }
}
