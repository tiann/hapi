import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    activateMessageWindow,
    fetchOlderMessages,
    getMessageWindowState,
    setMessageViewMode,
    subscribeMessageWindow,
    syncTailMessages,
    type MessageViewMode,
    type MessageWindowState,
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
    unseenCount: 0,
    messagesVersion: 0,
    historyVersion: 0,
}

export function useMessages(api: ApiClient | null, sessionId: string | null): {
    messages: DecryptedMessage[]
    warning: string | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    hasMore: boolean
    unseenCount: number
    messagesVersion: number
    historyVersion: number
    loadMore: () => Promise<boolean>
    refetch: () => Promise<void>
    setViewMode: (mode: MessageViewMode) => void
} {
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) return () => {}
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        useCallback(() => sessionId ? getMessageWindowState(sessionId) : EMPTY_STATE, [sessionId]),
        () => EMPTY_STATE
    )

    useLayoutEffect(() => {
        if (sessionId) {
            activateMessageWindow(sessionId)
        }
    }, [sessionId])

    useEffect(() => {
        if (api && sessionId) {
            void syncTailMessages(api, sessionId)
        }
    }, [api, sessionId])

    const loadMore = useCallback(async () => {
        if (!api || !sessionId || !state.hasMore || state.isLoadingMore) return false
        return await fetchOlderMessages(api, sessionId)
    }, [api, sessionId, state.hasMore, state.isLoadingMore])

    const refetch = useCallback(async () => {
        if (!api || !sessionId) return
        await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    }, [api, sessionId])

    const setViewMode = useCallback((mode: MessageViewMode) => {
        if (!sessionId) return
        const previousMode = getMessageWindowState(sessionId).viewMode
        setMessageViewMode(sessionId, mode)
        if (mode === 'tail' && previousMode !== 'tail' && api) {
            void syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        }
    }, [api, sessionId])

    return {
        messages: state.messages,
        warning: state.warning,
        isSyncingTail: state.isSyncingTail,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        unseenCount: state.unseenCount,
        messagesVersion: state.messagesVersion,
        historyVersion: state.historyVersion,
        loadMore,
        refetch,
        setViewMode,
    }
}
