import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    clearMessageWindow,
    fetchLatestMessages,
    fetchOlderMessages,
    flushPendingMessages,
    getMessageWindowState,
    setAtBottom as setMessageWindowAtBottom,
    subscribeMessageWindow,
    type MessageWindowState,
} from '@/lib/message-window-store'

const EMPTY_STATE: MessageWindowState = {
    sessionId: 'unknown',
    messages: [],
    pending: [],
    pendingCount: 0,
    hasMore: false,
    oldestSeq: null,
    newestSeq: null,
    isLoading: false,
    isLoadingMore: false,
    warning: null,
    atBottom: true,
    messagesVersion: 0,
}

export function useMessages(api: ApiClient | null, sessionId: string | null): {
    messages: DecryptedMessage[]
    warning: string | null
    isLoading: boolean
    isLoadingMore: boolean
    hasMore: boolean
    pendingCount: number
    messagesVersion: number
    loadMore: () => Promise<unknown>
    refetch: () => Promise<unknown>
    flushPending: () => Promise<void>
    setAtBottom: (atBottom: boolean) => void
} {
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) {
                return () => {}
            }
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        useCallback(() => {
            if (!sessionId) {
                return EMPTY_STATE
            }
            return getMessageWindowState(sessionId)
        }, [sessionId]),
        () => EMPTY_STATE
    )

    useEffect(() => {
        if (!api || !sessionId) {
            return
        }
        void fetchLatestMessages(api, sessionId)
    }, [api, sessionId])

    useEffect(() => {
        if (!sessionId) {
            return
        }
        return () => {
            clearMessageWindow(sessionId)
        }
    }, [sessionId])

    const loadMore = useCallback(async () => {
        if (!api || !sessionId) return
        if (!state.hasMore || state.isLoadingMore) return
        await fetchOlderMessages(api, sessionId)
    }, [api, sessionId, state.hasMore, state.isLoadingMore])

    const refetch = useCallback(async () => {
        if (!api || !sessionId) return
        await fetchLatestMessages(api, sessionId)
    }, [api, sessionId])

    const flushPending = useCallback(async () => {
        if (!sessionId) return
        const needsRefresh = flushPendingMessages(sessionId)
        if (needsRefresh && api) {
            await fetchLatestMessages(api, sessionId)
        }
    }, [api, sessionId])

    const setAtBottom = useCallback((atBottom: boolean) => {
        if (!sessionId) return
        setMessageWindowAtBottom(sessionId, atBottom)
    }, [sessionId])

    return {
        messages: state.messages,
        warning: state.warning,
        isLoading: state.isLoading,
        isLoadingMore: state.isLoadingMore,
        hasMore: state.hasMore,
        pendingCount: state.pendingCount,
        messagesVersion: state.messagesVersion,
        loadMore,
        refetch,
        flushPending,
        setAtBottom,
    }
}
