import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useMessages } from './useMessages'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'
import type { MessageWindowState } from '@/lib/message-window-store'

const messageStore = vi.hoisted(() => ({
    clearMessageWindow: vi.fn(),
    fetchLatestMessages: vi.fn(async () => false),
    fetchNewerMessages: vi.fn(async () => {}),
    fetchOlderMessages: vi.fn(async () => {}),
    flushPendingMessages: vi.fn(() => false),
    getMessageWindowState: vi.fn(),
    returnToLatestMessages: vi.fn(async () => false),
    setAtBottom: vi.fn(),
    subscribeMessageWindow: vi.fn(() => () => {}),
}))

vi.mock('@/lib/message-window-store', () => ({
    clearMessageWindow: messageStore.clearMessageWindow,
    fetchLatestMessages: messageStore.fetchLatestMessages,
    fetchNewerMessages: messageStore.fetchNewerMessages,
    fetchOlderMessages: messageStore.fetchOlderMessages,
    flushPendingMessages: messageStore.flushPendingMessages,
    getMessageWindowState: messageStore.getMessageWindowState,
    returnToLatestMessages: messageStore.returnToLatestMessages,
    setAtBottom: messageStore.setAtBottom,
    subscribeMessageWindow: messageStore.subscribeMessageWindow,
}))

const EMPTY_MESSAGE_STATE: MessageWindowState = {
    sessionId: 'session-1',
    messages: [],
    pending: [],
    pendingCount: 0,
    hasOlder: false,
    hasNewer: false,
    hasMore: false,
    ranges: [],
    gaps: [],
    oldestSeq: null,
    newestSeq: null,
    isLoading: false,
    isLoadingOlder: false,
    isLoadingNewer: false,
    isLoadingMore: false,
    warning: null,
    atBottom: true,
    messagesVersion: 0,
}

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
}

function createApi(): ApiClient {
    return {
        markSessionRead: vi.fn(async () => {}),
    } as unknown as ApiClient
}

describe('useMessages', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.clearAllMocks()
    })

    it('marks the initial latest-message fetch read and clears cached unread count without a second read request', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue(EMPTY_MESSAGE_STATE)
        messageStore.fetchLatestMessages.mockResolvedValueOnce(true)

        const api = createApi()
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.sessions, {
            sessions: [
                {
                    id: 'session-1',
                    active: true,
                    thinking: false,
                    activeAt: 1,
                    updatedAt: 2,
                    metadata: null,
                    todoProgress: null,
                    pendingRequestsCount: 0,
                    unreadCount: 3,
                    model: null,
                    effort: null,
                },
                {
                    id: 'session-2',
                    active: true,
                    thinking: false,
                    activeAt: 1,
                    updatedAt: 2,
                    metadata: null,
                    todoProgress: null,
                    pendingRequestsCount: 0,
                    unreadCount: 5,
                    model: null,
                    effort: null,
                },
            ],
        })

        renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: true })
        })
        expect(api.markSessionRead).not.toHaveBeenCalled()
        await waitFor(() => {
            const sessions = queryClient.getQueryData<{ sessions: Array<{ id: string; unreadCount: number }> }>(queryKeys.sessions)
            expect(sessions?.sessions.find((session) => session.id === 'session-1')?.unreadCount).toBe(0)
            expect(sessions?.sessions.find((session) => session.id === 'session-2')?.unreadCount).toBe(5)
        })
    })

    it('retains cached unread count when the initial latest-message fetch fails', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue(EMPTY_MESSAGE_STATE)
        messageStore.fetchLatestMessages.mockResolvedValueOnce(false)

        const api = createApi()
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.sessions, {
            sessions: [{
                id: 'session-1',
                active: true,
                thinking: false,
                activeAt: 1,
                updatedAt: 2,
                metadata: null,
                todoProgress: null,
                pendingRequestsCount: 0,
                unreadCount: 3,
                model: null,
                effort: null,
            }],
        })

        renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: true })
        })
        const sessions = queryClient.getQueryData<{ sessions: Array<{ id: string; unreadCount: number }> }>(queryKeys.sessions)
        expect(sessions?.sessions[0]?.unreadCount).toBe(3)
    })

    it('waits for an active-window read mark to succeed before clearing cached unread count', async () => {
        let visible = false
        let focused = false
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
        vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
        messageStore.getMessageWindowState.mockReturnValue(EMPTY_MESSAGE_STATE)
        messageStore.fetchLatestMessages.mockResolvedValueOnce(true)
        let resolveReadMark!: () => void
        const readMark = new Promise<void>((resolve) => {
            resolveReadMark = resolve
        })
        const api = {
            markSessionRead: vi.fn(() => readMark),
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.sessions, {
            sessions: [{
                id: 'session-1',
                active: true,
                thinking: false,
                activeAt: 1,
                updatedAt: 2,
                metadata: null,
                todoProgress: null,
                pendingRequestsCount: 0,
                unreadCount: 3,
                model: null,
                effort: null,
            }],
        })

        renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })
        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: false })
        })

        visible = true
        focused = true
        act(() => window.dispatchEvent(new Event('focus')))
        await waitFor(() => expect(api.markSessionRead).toHaveBeenCalledTimes(1))

        let sessions = queryClient.getQueryData<{ sessions: Array<{ unreadCount: number }> }>(queryKeys.sessions)
        expect(sessions?.sessions[0]?.unreadCount).toBe(3)

        await act(async () => {
            resolveReadMark()
            await readMark
        })
        sessions = queryClient.getQueryData<{ sessions: Array<{ unreadCount: number }> }>(queryKeys.sessions)
        expect(sessions?.sessions[0]?.unreadCount).toBe(0)
    })

    it('retains cached unread count when an active-window read mark fails', async () => {
        let visible = false
        let focused = false
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
        vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
        messageStore.getMessageWindowState.mockReturnValue(EMPTY_MESSAGE_STATE)
        messageStore.fetchLatestMessages.mockResolvedValueOnce(true)
        const api = {
            markSessionRead: vi.fn(async () => {
                throw new Error('read mark unavailable')
            }),
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.sessions, {
            sessions: [{
                id: 'session-1',
                active: true,
                thinking: false,
                activeAt: 1,
                updatedAt: 2,
                metadata: null,
                todoProgress: null,
                pendingRequestsCount: 0,
                unreadCount: 3,
                model: null,
                effort: null,
            }],
        })

        renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })
        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: false })
        })

        visible = true
        focused = true
        act(() => window.dispatchEvent(new Event('focus')))
        await waitFor(() => expect(api.markSessionRead).toHaveBeenCalledTimes(1))
        await act(async () => {
            await Promise.resolve()
        })

        const sessions = queryClient.getQueryData<{ sessions: Array<{ unreadCount: number }> }>(queryKeys.sessions)
        expect(sessions?.sessions[0]?.unreadCount).toBe(3)
    })

    it('does not mutate a retained review window before fetching latest messages', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            atBottom: false,
            pendingCount: 1,
        })

        const api = createApi()
        const queryClient = createQueryClient()

        renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: true })
        })
        expect(messageStore.setAtBottom).not.toHaveBeenCalled()
    })

    it('does not mutate a review window before an ordinary refetch', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            atBottom: false,
            pendingCount: 1,
        })

        const api = createApi()
        const queryClient = createQueryClient()
        const { result } = renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalled()
        })
        messageStore.setAtBottom.mockClear()
        messageStore.fetchLatestMessages.mockClear()

        await act(async () => {
            await result.current.refetch()
        })

        expect(messageStore.setAtBottom).not.toHaveBeenCalled()
        expect(messageStore.fetchLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: true })
    })

    it('uses an exact return-to-latest fetch when pending history requires repair', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            atBottom: false,
            pendingCount: 1,
        })

        const api = createApi()
        const queryClient = createQueryClient()
        const { result } = renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalled()
        })
        messageStore.flushPendingMessages.mockReturnValueOnce(true)
        messageStore.setAtBottom.mockClear()
        messageStore.fetchLatestMessages.mockClear()
        messageStore.returnToLatestMessages.mockClear()

        await act(async () => {
            await result.current.flushPending()
        })

        expect(messageStore.flushPendingMessages).toHaveBeenCalledWith('session-1')
        expect(messageStore.setAtBottom).not.toHaveBeenCalled()
        expect(messageStore.fetchLatestMessages).not.toHaveBeenCalled()
        expect(messageStore.returnToLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: true })
    })

    it('exposes directional state and dispatches older and newer loads independently', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            hasOlder: true,
            hasNewer: true,
            hasMore: true,
            isLoadingOlder: false,
            isLoadingNewer: false,
        })

        const api = createApi()
        const queryClient = createQueryClient()
        const { result } = renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })
        await waitFor(() => expect(messageStore.fetchLatestMessages).toHaveBeenCalled())

        expect(result.current.hasOlder).toBe(true)
        expect(result.current.hasNewer).toBe(true)
        expect(result.current.isLoadingOlder).toBe(false)
        expect(result.current.isLoadingNewer).toBe(false)

        await act(async () => {
            await result.current.loadOlder()
            await result.current.loadNewer()
        })

        expect(messageStore.fetchOlderMessages).toHaveBeenCalledWith(api, 'session-1')
        expect(messageStore.fetchNewerMessages).toHaveBeenCalledWith(api, 'session-1')
    })

    it('returns to the exact latest page even when there are zero pending rows', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            atBottom: false,
            hasNewer: true,
            pendingCount: 0,
        })

        const api = createApi()
        const queryClient = createQueryClient()
        const { result } = renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })
        await waitFor(() => expect(messageStore.fetchLatestMessages).toHaveBeenCalled())
        messageStore.returnToLatestMessages.mockClear()

        await act(async () => {
            await result.current.returnToLatest()
        })

        expect(messageStore.returnToLatestMessages).toHaveBeenCalledWith(api, 'session-1', { markRead: true })
    })

    it('propagates an exact latest failure so the thread can retain its review position', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            atBottom: false,
            hasNewer: true,
        })
        messageStore.returnToLatestMessages.mockResolvedValueOnce(false)

        const api = createApi()
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.sessions, {
            sessions: [{
                id: 'session-1',
                active: true,
                thinking: false,
                activeAt: 1,
                updatedAt: 2,
                metadata: null,
                todoProgress: null,
                pendingRequestsCount: 0,
                unreadCount: 2,
                model: null,
                effort: null,
            }],
        })
        const { result } = renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })
        await waitFor(() => expect(messageStore.fetchLatestMessages).toHaveBeenCalled())

        let returned: unknown
        await act(async () => {
            returned = await result.current.returnToLatest()
        })

        expect(returned).toBe(false)
        const sessions = queryClient.getQueryData<{ sessions: Array<{ id: string; unreadCount: number }> }>(queryKeys.sessions)
        expect(sessions?.sessions[0]?.unreadCount).toBe(2)
    })

    it('does not let the initial latest-fetch optimistic clear suppress the next server read mark', async () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            messagesVersion: 0,
        })

        const api = createApi()
        const queryClient = createQueryClient()
        const { rerender } = renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(messageStore.fetchLatestMessages).toHaveBeenCalled()
        })
        expect(api.markSessionRead).not.toHaveBeenCalled()

        now.mockReturnValue(101_000)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            messagesVersion: 1,
        })
        rerender()

        await waitFor(() => {
            expect(api.markSessionRead).toHaveBeenCalledTimes(1)
        })

        now.mockReturnValue(105_000)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            messagesVersion: 2,
        })
        rerender()

        await Promise.resolve()
        expect(api.markSessionRead).toHaveBeenCalledTimes(1)

        now.mockReturnValue(112_000)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            messagesVersion: 3,
        })
        rerender()

        await waitFor(() => {
            expect(api.markSessionRead).toHaveBeenCalledTimes(2)
        })
    })

    it('schedules a trailing server read mark for throttled message-version updates', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        messageStore.fetchLatestMessages.mockResolvedValueOnce(true)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            messagesVersion: 0,
        })

        const api = createApi()
        const queryClient = createQueryClient()
        const { rerender } = renderHook(() => useMessages(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await act(async () => {
            await Promise.resolve()
        })
        expect(messageStore.fetchLatestMessages).toHaveBeenCalled()
        await act(async () => {
            await Promise.resolve()
        })

        queryClient.setQueryData(queryKeys.sessions, {
            sessions: [{
                id: 'session-1',
                active: true,
                thinking: false,
                activeAt: 1,
                updatedAt: 2,
                metadata: null,
                todoProgress: null,
                pendingRequestsCount: 0,
                unreadCount: 2,
                model: null,
                effort: null,
            }],
        })

        vi.setSystemTime(101_000)
        messageStore.getMessageWindowState.mockReturnValue({
            ...EMPTY_MESSAGE_STATE,
            messagesVersion: 1,
        })
        rerender()

        await act(async () => {
            await Promise.resolve()
        })
        expect(api.markSessionRead).not.toHaveBeenCalled()
        let sessions = queryClient.getQueryData<{ sessions: Array<{ unreadCount: number }> }>(queryKeys.sessions)
        expect(sessions?.sessions[0]?.unreadCount).toBe(2)

        await act(async () => {
            vi.advanceTimersByTime(8_999)
            await Promise.resolve()
        })
        expect(api.markSessionRead).not.toHaveBeenCalled()

        await act(async () => {
            vi.advanceTimersByTime(1)
            await Promise.resolve()
        })
        expect(api.markSessionRead).toHaveBeenCalledTimes(1)
        sessions = queryClient.getQueryData<{ sessions: Array<{ unreadCount: number }> }>(queryKeys.sessions)
        expect(sessions?.sessions[0]?.unreadCount).toBe(0)
    })

})
