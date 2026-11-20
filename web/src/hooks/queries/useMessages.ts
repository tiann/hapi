import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    activateMessageWindow,
    cancelOlderMessageLoad,
    fetchNewerMessages,
    fetchOlderMessages,
    getMessageWindowState,
    loadMessageContext,
    setMessageWindowTargetLock,
    setMessageViewMode,
    subscribeMessageWindow,
    syncTailMessages,
    type MessageViewMode,
    type MessageWindowState,
    type NewerLoadOutcome,
    type OlderLoadOutcome,
} from '@/lib/message-window-store'
import { telemetryClient } from '@/lib/telemetryClient'

/**
 * load_slow thresholds (diag, observation only). The aTrust round-trip tax is
 * ~400ms per leg and the window design is cache-first, so a session view that
 * takes longer than 3s to first show settled content (cached tail or fresh
 * page) is a regression signal; the authoritative tail reconcile may walk
 * several catch-up pages, hence the looser 5s budget there.
 */
const SESSION_DETAIL_SLOW_MS = 3_000
const TAIL_SYNC_SLOW_MS = 5_000

export const EMPTY_STATE: MessageWindowState = {
    sessionId: 'unknown',
    messages: [],
    hasMore: false,
    oldestSeq: null,
    newestSeq: null,
    epoch: null,
    isSyncingTail: false,
    preferLatestOnActivation: false,
    isLoadingMore: false,
    warning: null,
    pendingGapRecovery: false,
    viewMode: 'tail',
    requiresLatestReset: false,
    hasMoreNewer: false,
    messagesVersion: 0,
    historyVersion: 0,
    tailRevision: 0,
}

export function useMessages(
    api: ApiClient | null,
    sessionId: string | null,
    options: { skipInitialTailSync?: boolean } = {}
): {
    messages: DecryptedMessage[]
    readThroughRevision?: number
    warning: string | null
    isSyncingTail: boolean
    /** Cached re-entry: the authoritative latest-page fetch is still in flight. */
    isCatchingUpFromCache: boolean
    isLoadingMore: boolean
    hasMore: boolean
    hasMoreNewer: boolean
    viewMode: MessageViewMode
    messagesVersion: number
    historyVersion: number
    tailRevision: number
    loadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    loadNewer: (resolvePreserveMessageId?: () => string | null) => Promise<NewerLoadOutcome>
    loadMessageContext: (messageId: string) => Promise<boolean>
    cancelLoadMore: () => void
    refetch: () => Promise<void>
    setViewMode: (mode: MessageViewMode) => void
    jumpToTail: () => void
} {
    const initialSyncKey = api && sessionId ? sessionId : null
    const [initialSyncReadyKey, setInitialSyncReadyKey] = useState<string | null>(null)
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) return () => {}
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        useCallback(() => sessionId ? getMessageWindowState(sessionId) : EMPTY_STATE, [sessionId]),
        () => EMPTY_STATE
    )
    useLayoutEffect(() => {
        if (sessionId && !options.skipInitialTailSync) {
            activateMessageWindow(sessionId)
        }
    }, [options.skipInitialTailSync, sessionId])

    // Start the initial tail reconciliation in the layout phase so a search
    // target cannot begin a context load in the gap before the tail request
    // invalidates it. HappyThread waits for this state to settle before it
    // attempts DOM anchoring.
    useLayoutEffect(() => {
        if (!api || !sessionId) return
        setMessageWindowTargetLock(sessionId, Boolean(options.skipInitialTailSync))
        if (options.skipInitialTailSync) {
            // A search result already identifies the exact message to load.
            // Avoid fetching the latest 200 messages first: inactive sessions
            // can contain very large tool payloads, and that request can delay
            // the much smaller, targeted context request for a long time.
            setMessageViewMode(sessionId, 'history')
            setInitialSyncReadyKey(sessionId)
            return () => {
                setMessageWindowTargetLock(sessionId, false)
            }
        }
        let active = true
        const syncStartedAt = Date.now()
        // Read BEFORE the sync starts: activation (the first layout effect)
        // sets preferLatestOnActivation when a persisted v3 window served a
        // usable cursor, and the sync's own updates clear it on landing.
        const cacheHitOnActivate = getMessageWindowState(sessionId).preferLatestOnActivation
        void syncTailMessages(api, sessionId).then(() => {
            if (active) {
                setInitialSyncReadyKey(sessionId)
            }
            // Observation only: the initial reconcile settled (data_loaded,
            // ux) and its duration against the slow threshold (load_slow,
            // diag). Emitted even when the page already moved on — the sync
            // itself really did settle.
            try {
                const settledAt = Date.now()
                const durationMs = settledAt - syncStartedAt
                telemetryClient.capture('ux', 'data_loaded', {
                    cacheHitOnActivate,
                    messageCountAfterSync: getMessageWindowState(sessionId).messages.length,
                    settledAt
                }, { sessionId })
                if (durationMs > TAIL_SYNC_SLOW_MS) {
                    telemetryClient.capture('diag', 'load_slow', {
                        phase: 'tail-sync',
                        durationMs,
                        fromCache: cacheHitOnActivate
                    }, { sessionId })
                }
            } catch {
                // fail-silent
            }
        })
        return () => {
            active = false
            setMessageWindowTargetLock(sessionId, false)
        }
    }, [api, sessionId, options.skipInitialTailSync])

    // Observation only (load_slow / 'session-detail'): time from the session
    // becoming active until the window first publishes settled, non-empty
    // content — the "open a session and see the tail" metric. A v3 cache hit
    // settles near-instantly; a cold open waits for the network leg. Passive
    // effect: observes the same publications the layout effects produce. A
    // small poll backs the store subscription (publications are throttled
    // and coalesced, so the settle moment would otherwise smear up to the
    // throttle window). Level 0 (telemetry off / old hub) skips the whole
    // effect — the poll would be pure observational overhead; the poll also
    // stops itself once the metric settles or the window is confirmed empty.
    useEffect(() => {
        if (!sessionId) {
            return
        }
        if (telemetryClient.getLevel() <= 0) {
            return
        }
        const startedAt = Date.now()
        let settled = false
        let poll: ReturnType<typeof setInterval> | null = null
        const stopPoll = () => {
            if (poll !== null) {
                clearInterval(poll)
                poll = null
            }
        }
        const check = () => {
            if (settled) {
                return
            }
            try {
                const state = getMessageWindowState(sessionId)
                if (state.isSyncingTail) {
                    return
                }
                if (state.messages.length === 0) {
                    if (state.epoch !== null) {
                        // Confirmed empty window: the authoritative sync
                        // completed with zero messages — nothing further can
                        // arrive on its own, stop watching. (epoch null means
                        // no sync ran yet, e.g. a search-target open whose
                        // context load is still pending — keep watching.)
                        settled = true
                        stopPoll()
                    }
                    return
                }
                settled = true
                stopPoll()
                const durationMs = Date.now() - startedAt
                if (durationMs > SESSION_DETAIL_SLOW_MS) {
                    telemetryClient.capture('diag', 'load_slow', {
                        phase: 'session-detail',
                        durationMs,
                        fromCache: state.preferLatestOnActivation
                    }, { sessionId })
                }
            } catch {
                settled = true
                stopPoll()
                // fail-silent
            }
        }
        check()
        const unsubscribe = subscribeMessageWindow(sessionId, check)
        poll = setInterval(check, 500)
        return () => {
            stopPoll()
            settled = true
            unsubscribe()
        }
    }, [sessionId])

    const loadMore = useCallback(async (onBeforeApply?: (historyVersion: number) => boolean) => {
        if (!api || !sessionId) {
            return { kind: 'stopped', reason: 'unavailable' } as const
        }
        return await fetchOlderMessages(api, sessionId, { onBeforeApply })
    }, [api, sessionId])

    const loadNewer = useCallback(async (resolvePreserveMessageId?: () => string | null) => {
        if (!api || !sessionId) {
            return { kind: 'stopped', reason: 'unavailable' } as const
        }
        return await fetchNewerMessages(api, sessionId, { resolvePreserveMessageId })
    }, [api, sessionId])

    const cancelLoadMore = useCallback(() => {
        if (sessionId) {
            cancelOlderMessageLoad(sessionId)
        }
    }, [sessionId])

    const loadMessageContextForSession = useCallback(async (messageId: string) => {
        if (!api || !sessionId) return false
        return await loadMessageContext(api, sessionId, messageId)
    }, [api, sessionId])

    const refetch = useCallback(async () => {
        if (!api || !sessionId) return
        await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    }, [api, sessionId])

    const setViewMode = useCallback((mode: MessageViewMode) => {
        if (!sessionId) return
        const previous = getMessageWindowState(sessionId)
        setMessageViewMode(sessionId, mode)
        if (mode === 'tail' && api && (previous.viewMode !== 'tail' || previous.requiresLatestReset)) {
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }
    }, [api, sessionId])

    const jumpToTail = useCallback(() => {
        if (!sessionId) return
        setMessageViewMode(sessionId, 'tail')
        if (api) {
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }
    }, [api, sessionId])

    return {
        messages: state.messages,
        readThroughRevision: state.readThroughRevision,
        warning: state.warning,
        // The store's first isSyncingTail publication can occur after child
        // layout effects. Keep search-target anchoring blocked until the
        // initial reconciliation promise has settled as well, so a persisted
        // historical window cannot be mistaken for the latest tail.
        isSyncingTail: state.isSyncingTail
            // `requiresLatestReset` is expected while a retained history
            // window is being re-activated into tail mode. Once a search
            // context is applied it remains true as a marker for the next
            // tail activation, but the current history view must still be
            // renderable and searchable.
            || (state.requiresLatestReset && state.viewMode === 'tail')
            || (initialSyncKey !== null && initialSyncReadyKey !== initialSyncKey),
        isCatchingUpFromCache: state.preferLatestOnActivation,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        hasMoreNewer: state.hasMoreNewer,
        viewMode: state.viewMode,
        messagesVersion: state.messagesVersion,
        historyVersion: state.historyVersion,
        tailRevision: state.tailRevision,
        loadMore,
        loadNewer,
        loadMessageContext: loadMessageContextForSession,
        cancelLoadMore,
        refetch,
        setViewMode,
        jumpToTail,
    }
}
