import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { ConversationOutlineItem } from '@/chat/outline'
import {
    getConversationOutlineState,
    hydrateConversationOutline,
    resetConversationOutline,
    seedConversationOutline,
    setConversationOutlineLocating,
    subscribeConversationOutline,
    type ConversationOutlineState,
} from '@/lib/outline-store'

const EMPTY_STATE: ConversationOutlineState = {
    sessionId: 'unknown',
    items: [],
    status: 'idle',
    complete: false,
    hasMore: true,
    cursorBeforeAt: null,
    cursorBeforeSeq: null,
    error: null,
    locateError: null,
    isLocating: false,
    locatingTargetMessageId: null,
}

export function useConversationOutline(
    api: ApiClient | null,
    sessionId: string | null,
    seedItems: readonly ConversationOutlineItem[]
): ConversationOutlineState & {
    startHydrating: () => Promise<void>
    retryHydrating: () => Promise<void>
    setLocating: (targetMessageId: string | null, locateError?: string | null) => void
} {
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) {
                return () => {}
            }
            return subscribeConversationOutline(sessionId, listener)
        }, [sessionId]),
        useCallback(() => {
            if (!sessionId) {
                return EMPTY_STATE
            }
            return getConversationOutlineState(sessionId)
        }, [sessionId]),
        () => EMPTY_STATE
    )

    useEffect(() => {
        if (!sessionId || seedItems.length === 0) {
            return
        }
        seedConversationOutline(sessionId, seedItems)
    }, [sessionId, seedItems])

    const startHydrating = useCallback(async () => {
        if (!api || !sessionId) {
            return
        }
        await hydrateConversationOutline(api, sessionId)
    }, [api, sessionId])

    const retryHydrating = useCallback(async () => {
        if (!api || !sessionId) {
            return
        }
        resetConversationOutline(sessionId)
        if (seedItems.length > 0) {
            seedConversationOutline(sessionId, seedItems)
        }
        await hydrateConversationOutline(api, sessionId)
    }, [api, sessionId, seedItems])

    const setLocating = useCallback((targetMessageId: string | null, locateError: string | null = null) => {
        if (!sessionId) {
            return
        }
        setConversationOutlineLocating(sessionId, targetMessageId, locateError)
    }, [sessionId])

    return {
        ...state,
        startHydrating,
        retryHydrating,
        setLocating,
    }
}
