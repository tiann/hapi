import { useCallback, useEffect, useRef } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SyncEvent } from '@/types/api'
import {
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    rewindMessageWindow,
    syncTailMessages
} from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'

/**
 * Poll cadence for the selected session's tail while it is busy
 * (active/thinking): a spinner whose stuck/unstuck transitions are the thing
 * the user is watching deserves the faster loop.
 */
export const SESSION_TAIL_BUSY_TICK_MS = 10_000

/**
 * Minimum gap between idle tail syncs. An idle session can only change
 * through the server pushing an event; this is the safety net, not the
 * primary channel.
 */
export const SESSION_TAIL_IDLE_MIN_GAP_MS = 30_000

/**
 * Tail-sync fallback for the selected session's message window.
 *
 * Three gaps this hook closes, all observed on the phone in the field:
 *
 *  1. The global SSE subscription receives `message-received` for every
 *     session but the App-level handler dropped it (`onEvent: () => {}`):
 *     whenever the session-scoped EventSource is down (reconnect backoff,
 *     hidden tab, mobile backgrounding) the open conversation silently froze
 *     even though the data arrived. Here the selected session's messages are
 *     ingested from the global stream too — idempotent by message id, so the
 *     double delivery while both connections are alive is a no-op.
 *  2. Coming back to the tab / regaining network could miss everything that
 *     happened while the page was suspended: on visible/online the tail is
 *     re-synced (`ensureAfterCurrent` keeps the loaded history).
 *  3. A long-lived page whose SSE silently died (server restart, proxy idle
 *     timeout) never noticed: a visibility-gated ticker re-syncs the tail —
 *     every tick while the session is busy, at most every 30s when idle —
 *     so the view converges to the truth even with zero events.
 *
 * Deliberately no localStorage knobs: this is plumbing, not a preference.
 */
export function useSessionTailFallback(options: {
    api: ApiClient | null
    sessionId: string | null
    queryClient: QueryClient
}): (event: SyncEvent) => void {
    const { api, sessionId, queryClient } = options

    // Latest-value refs so the returned handler identity stays stable — the
    // global SSE hook keeps callbacks in refs, but a stable function avoids
    // any re-subscribe churn in consumers that don't.
    const sessionIdRef = useRef(sessionId)
    sessionIdRef.current = sessionId
    const apiRef = useRef(api)
    apiRef.current = api
    const lastIdleSyncAtRef = useRef(0)

    // B1: ingest the selected session's messages from the global stream.
    const handleGlobalEvent = useCallback((event: SyncEvent) => {
        const selectedId = sessionIdRef.current
        if (!selectedId || !('sessionId' in event) || event.sessionId !== selectedId) {
            return
        }
        if (event.type === 'message-received') {
            // Only extend a window the user has actually opened; seeding a
            // window from one event would race the full page load.
            if (getMessageWindowState(selectedId).epoch !== null) {
                ingestIncomingMessages(selectedId, [event.message])
            }
            return
        }
        if (event.type === 'messages-invalidated') {
            if (event.reason === 'rewind' && event.truncateFromLocalId) {
                rewindMessageWindow(selectedId, event.truncateFromLocalId)
            } else {
                clearMessageWindow(selectedId)
            }
            const currentApi = apiRef.current
            if (currentApi) {
                void syncTailMessages(currentApi, selectedId)
            }
        }
    }, [])

    // B2: resync on foreground / network regain.
    useEffect(() => {
        if (!api || !sessionId) {
            return
        }
        const resync = () => {
            if (document.visibilityState !== 'visible') {
                return
            }
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }
        document.addEventListener('visibilitychange', resync)
        window.addEventListener('online', resync)
        return () => {
            document.removeEventListener('visibilitychange', resync)
            window.removeEventListener('online', resync)
        }
    }, [api, sessionId])

    // B3: visibility-gated fallback ticker.
    useEffect(() => {
        if (!api || !sessionId) {
            return
        }
        const timer = window.setInterval(() => {
            if (document.visibilityState !== 'visible') {
                return
            }
            const now = Date.now()
            const sessions = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            const row = sessions?.sessions.find((session) => session.id === sessionId)
            const busy = row?.active === true || row?.thinking === true
            if (!busy && now - lastIdleSyncAtRef.current < SESSION_TAIL_IDLE_MIN_GAP_MS) {
                return
            }
            lastIdleSyncAtRef.current = now
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }, SESSION_TAIL_BUSY_TICK_MS)
        return () => {
            window.clearInterval(timer)
        }
    }, [api, sessionId, queryClient])

    return handleGlobalEvent
}
