import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useMessages } from './useMessages'

const store = vi.hoisted(() => {
    const state = {
        sessionId: 'session-1',
        messages: [],
        hasMore: false,
        oldestSeq: null,
        newestSeq: null,
        epoch: null,
        isSyncingTail: false,
        isLoadingMore: false,
        warning: null,
        viewMode: 'history' as 'history' | 'tail',
        messagesVersion: 0,
        historyVersion: 0,
        navigationLeaseCount: 0,
        tailRevision: 0,
    }
    return {
        state,
        startsQueuedSync: true,
        syncTailMessages: vi.fn(async () => {}),
        setMessageViewMode: vi.fn((_sessionId: string, mode: 'history' | 'tail') => {
            store.state = {
                ...store.state,
                viewMode: mode,
                isSyncingTail: store.startsQueuedSync || store.state.isSyncingTail,
            }
        }),
    }
})

vi.mock('@/lib/message-window-store', () => ({
    activateMessageWindow: vi.fn(),
    cancelOlderMessageLoad: vi.fn(),
    fetchOlderMessages: vi.fn(),
    getMessageWindowState: vi.fn(() => store.state),
    setMessageViewMode: store.setMessageViewMode,
    subscribeMessageWindow: vi.fn(() => () => {}),
    syncTailMessages: store.syncTailMessages,
}))

describe('useMessages', () => {
    beforeEach(() => {
        store.state = { ...store.state, viewMode: 'history', isSyncingTail: false }
        store.startsQueuedSync = true
        vi.clearAllMocks()
    })

    it('does not enqueue a second tail sync when returning to tail starts the queued sync', () => {
        const api = {} as ApiClient
        const { result } = renderHook(() => useMessages(api, 'session-1'))
        store.syncTailMessages.mockClear()

        act(() => result.current.setViewMode('tail'))

        expect(store.setMessageViewMode).toHaveBeenCalledWith('session-1', 'tail')
        expect(store.syncTailMessages).not.toHaveBeenCalled()
    })

    it('keeps the trailing refresh when a tail sync was already running', () => {
        store.state = { ...store.state, isSyncingTail: true }
        store.startsQueuedSync = false
        const api = {} as ApiClient
        const { result } = renderHook(() => useMessages(api, 'session-1'))
        store.syncTailMessages.mockClear()

        act(() => result.current.setViewMode('tail'))

        expect(store.syncTailMessages).toHaveBeenCalledWith(api, 'session-1', {
            ensureAfterCurrent: true,
        })
    })
})
