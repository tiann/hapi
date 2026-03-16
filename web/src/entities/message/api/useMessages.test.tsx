import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMessages } from './useMessages'
import type { ApiClient } from '@/api/client'
import type { ReactNode } from 'react'

// Mock message-window-store - define mocks inside factory to avoid hoisting issues
vi.mock('@/lib/message-window-store', () => {
    const mockState = {
        sessionId: 'session-123',
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

    return {
        subscribeMessageWindow: vi.fn((sessionId, listener) => () => {}),
        getMessageWindowState: vi.fn(() => mockState),
        fetchLatestMessages: vi.fn(),
        fetchOlderMessages: vi.fn(),
        clearMessageWindow: vi.fn(),
        flushPendingMessages: vi.fn(() => false),
        setAtBottom: vi.fn(),
    }
})

// Import mocked functions for testing
import * as messageWindowStore from '@/lib/message-window-store'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

describe('useMessages', () => {
    let mockApi: ApiClient

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = {} as ApiClient
    })

    it('returns empty state when sessionId is null', () => {
        const { result } = renderHook(() => useMessages(mockApi, null), {
            wrapper: createWrapper(),
        })

        expect(result.current.messages).toEqual([])
        expect(result.current.isLoading).toBe(false)
        expect(result.current.hasMore).toBe(false)
    })

    it('subscribes to message window state', () => {
        renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        expect(messageWindowStore.subscribeMessageWindow).toHaveBeenCalledWith('session-123', expect.any(Function))
    })

    it('fetches latest messages on mount', () => {
        renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        expect(messageWindowStore.fetchLatestMessages).toHaveBeenCalledWith(mockApi, 'session-123')
    })

    it('clears message window on unmount', () => {
        const { unmount } = renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        unmount()

        expect(messageWindowStore.clearMessageWindow).toHaveBeenCalledWith('session-123')
    })

    it('provides loadMore function', async () => {
        vi.mocked(messageWindowStore.getMessageWindowState).mockReturnValue({
            sessionId: 'session-123',
            messages: [],
            pending: [],
            pendingCount: 0,
            hasMore: true,
            oldestSeq: null,
            newestSeq: null,
            isLoading: false,
            isLoadingMore: false,
            warning: null,
            atBottom: true,
            messagesVersion: 0,
        })

        const { result } = renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        await result.current.loadMore()

        expect(messageWindowStore.fetchOlderMessages).toHaveBeenCalledWith(mockApi, 'session-123')
    })

    it('does not load more when already loading', async () => {
        vi.mocked(messageWindowStore.getMessageWindowState).mockReturnValue({
            sessionId: 'session-123',
            messages: [],
            pending: [],
            pendingCount: 0,
            hasMore: true,
            oldestSeq: null,
            newestSeq: null,
            isLoading: false,
            isLoadingMore: true,
            warning: null,
            atBottom: true,
            messagesVersion: 0,
        })

        const { result } = renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        await result.current.loadMore()

        expect(messageWindowStore.fetchOlderMessages).not.toHaveBeenCalled()
    })

    it('provides refetch function', async () => {
        const { result } = renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        await result.current.refetch()

        expect(messageWindowStore.fetchLatestMessages).toHaveBeenCalledTimes(2) // Once on mount, once on refetch
    })

    it('provides flushPending function', async () => {
        vi.mocked(messageWindowStore.flushPendingMessages).mockReturnValue(true) // Needs refresh

        const { result } = renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        await result.current.flushPending()

        expect(messageWindowStore.flushPendingMessages).toHaveBeenCalledWith('session-123')
        expect(messageWindowStore.fetchLatestMessages).toHaveBeenCalled()
    })

    it('provides setAtBottom function', () => {
        const { result } = renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        result.current.setAtBottom(false)

        expect(messageWindowStore.setAtBottom).toHaveBeenCalledWith('session-123', false)
    })

    it('returns message state from store', () => {
        const mockMessages = [
            {
                id: 'msg-1',
                seq: 1,
                localId: null,
                content: { role: 'user', content: { type: 'text', text: 'Hello' } },
                createdAt: Date.now()
            },
        ]

        vi.mocked(messageWindowStore.getMessageWindowState).mockReturnValue({
            sessionId: 'session-123',
            messages: mockMessages,
            pending: [],
            pendingCount: 2,
            hasMore: true,
            oldestSeq: null,
            newestSeq: null,
            isLoading: false,
            isLoadingMore: false,
            warning: 'Connection lost',
            atBottom: true,
            messagesVersion: 0,
        })

        const { result } = renderHook(() => useMessages(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        expect(result.current.messages).toEqual(mockMessages)
        expect(result.current.pendingCount).toBe(2)
        expect(result.current.hasMore).toBe(true)
        expect(result.current.warning).toBe('Connection lost')
    })
})
