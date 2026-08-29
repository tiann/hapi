import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    activateMessageWindow,
    cancelOlderMessageLoad,
    fetchOlderMessages,
    getMessageWindowState,
    loadMessageContext,
    setMessageWindowTargetLock,
    setMessageViewMode,
    subscribeMessageWindow,
    syncTailMessages,
    type MessageViewMode,
    type MessageWindowState,
    type OlderLoadOutcome,
} from '@/lib/message-window-store'

export const EMPTY_STATE: MessageWindowState = {
    sessionId: 'unknown',
    messages: [],
    hasMore: false,
    oldestSeq: null,
    newestSeq: null,
    epoch: null,
    isSyncingTail: false,
    isLoadingMore: false,
    warning: null,
    viewMode: 'tail',
    requiresLatestReset: false,
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
    warning: string | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    hasMore: boolean
    viewMode: MessageViewMode
    messagesVersion: number
    historyVersion: number
    tailRevision: number
    loadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
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
            setInitialSyncReadyKey(sessionId)
            return () => {
                setMessageWindowTargetLock(sessionId, false)
            }
        }
        let active = true
        void syncTailMessages(api, sessionId).then(() => {
            if (active) {
                setInitialSyncReadyKey(sessionId)
            }
        })
        return () => {
            active = false
            setMessageWindowTargetLock(sessionId, false)
        }
    }, [api, sessionId, options.skipInitialTailSync])

    const loadMore = useCallback(async (onBeforeApply?: (historyVersion: number) => boolean) => {
        if (!api || !sessionId) {
            return { kind: 'stopped', reason: 'unavailable' } as const
        }
        return await fetchOlderMessages(api, sessionId, { onBeforeApply })
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
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        viewMode: state.viewMode,
        messagesVersion: state.messagesVersion,
        historyVersion: state.historyVersion,
        tailRevision: state.tailRevision,
        loadMore,
        loadMessageContext: loadMessageContextForSession,
        cancelLoadMore,
        refetch,
        setViewMode,
        jumpToTail,
    }
}
