import { useEffect, useRef } from 'react'
import {
    createVisitTracker,
    getLastOpenSessionId,
    resolveOpenEntry,
    type SessionEntry,
} from '@/chat/sessionVisitTelemetry'
import { noteVisitClosed } from '@/chat/turnLatency'

/**
 * SessionPage visit instrumentation: session_open on mount/session change,
 * session_close on switch/navigate-away/pagehide/hidden-timeout, and the
 * pause/resume + resume-after-timeout visit semantics (see
 * chat/sessionVisitTelemetry). Observation only — no behavior change to the
 * page it watches.
 *
 * `searchHint` carries the open-time URL params (message target / pending
 * request) used to classify entries when no recorded navigation intent
 * exists (toast clicks, shared links, reloads). `getSeenTail` is evaluated
 * once at close time for the seenTail close field.
 */
export function useSessionVisitTelemetry(
    sessionId: string,
    options?: {
        searchHint?: { messageId?: string | null; pendingRequestId?: string | null }
        getSeenTail?: () => boolean | undefined
    }
): void {
    // Read live at effect time without re-running the effect on every render
    // (hint objects are recreated per render in SessionPage).
    const optionsRef = useRef(options)
    optionsRef.current = options
    // Updated during render so the cleanup for an old sessionId can tell a
    // session SWITCH (render already moved to a new id) from an UNMOUNT.
    const renderSessionIdRef = useRef(sessionId)
    renderSessionIdRef.current = sessionId

    useEffect(() => {
        const hint = optionsRef.current
        const resolved = resolveOpenEntry(sessionId, hint?.searchHint)
        const fromSessionId = getLastOpenSessionId() ?? undefined
        const tracker = createVisitTracker({
            sessionId,
            getSeenTail: () => hint?.getSeenTail?.(),
        })

        const onVisibilityChange = () => tracker.onVisibleChange()
        const onPageHide = () => tracker.pageHide()
        try {
            tracker.open(resolved.entry as SessionEntry, fromSessionId, resolved.navTargetMessageId)
            document.addEventListener('visibilitychange', onVisibilityChange)
            window.addEventListener('pagehide', onPageHide)
        } catch {
            // fail-silent: instrumentation must never break the page
        }

        return () => {
            try {
                document.removeEventListener('visibilitychange', onVisibilityChange)
                window.removeEventListener('pagehide', onPageHide)
                const exit = renderSessionIdRef.current !== sessionId ? 'switch' : 'navigate-away'
                tracker.close(exit)
            } catch {
                // fail-silent
            }
            noteVisitClosed(sessionId)
        }
    }, [sessionId])
}
