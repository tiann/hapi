import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSendMessage } from './useSendMessage'
import type { ApiClient } from '@/api/client'

vi.mock('@/lib/message-window-store', () => ({
    appendOptimisticMessage: vi.fn(),
    getMessageWindowState: vi.fn(() => ({ messages: [], pending: [] })),
    updateMessageStatus: vi.fn(),
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { notification: vi.fn() },
    }),
}))

vi.mock('@/lib/messages', () => ({
    makeClientSideId: vi.fn(() => 'local-id-1'),
}))

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createMockApi(sendMessage: (...args: unknown[]) => Promise<void> = async () => {}): ApiClient {
    return { sendMessage } as unknown as ApiClient
}

describe('useSendMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('calls onSuccess with the session ID that was sent', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi()

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { onSuccess }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(onSuccess).toHaveBeenCalledWith('session-A')
        })
    })

    it('calls onSuccess with resolved session ID, not the original', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi()

        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                onSuccess,
                resolveSessionId: async () => 'session-resolved',
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(onSuccess).toHaveBeenCalledWith('session-resolved')
        })
    })

    it('does not call onSuccess when send fails', async () => {
        const onSuccess = vi.fn()
        const api = createMockApi(async () => {
            throw new Error('network error')
        })

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', { onSuccess }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        await waitFor(() => {
            expect(result.current.isSending).toBe(false)
        })

        expect(onSuccess).not.toHaveBeenCalled()
    })

    it('does not call onSuccess when blocked', () => {
        const onSuccess = vi.fn()
        const onBlocked = vi.fn()

        const { result } = renderHook(
            () => useSendMessage(null, 'session-A', { onSuccess, onBlocked }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.sendMessage('hello')
        })

        expect(onBlocked).toHaveBeenCalledWith('no-api')
        expect(onSuccess).not.toHaveBeenCalled()
    })

    it('resolves true when the send is accepted', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(true)
    })

    it('resolves false when blocked (no api) so the caller can preserve schedule state', async () => {
        const onBlocked = vi.fn()
        const { result } = renderHook(
            () => useSendMessage(null, 'session-A', { onBlocked }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
        expect(onBlocked).toHaveBeenCalledWith('no-api')
    })

    it('resolves false when blocked (no session)', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, null),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
    })

    it('resolves false when resolveSessionId throws (inactive-session resume failure)', async () => {
        const api = createMockApi()
        const resumeError = new Error('resume failed')
        const { result } = renderHook(
            () => useSendMessage(api, 'session-A', {
                resolveSessionId: async () => { throw resumeError },
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(false)
    })

    it('resolves true after async resolveSessionId succeeds and mutation starts', async () => {
        const api = createMockApi()
        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                resolveSessionId: async () => 'session-resolved',
                onSessionResolved: vi.fn(),
            }),
            { wrapper: createWrapper() },
        )
        let acceptedPromise: Promise<boolean> | undefined
        act(() => {
            acceptedPromise = result.current.sendMessage('hello')
        })
        await expect(acceptedPromise!).resolves.toBe(true)
    })

    it('preserves scheduledAt when retrying a failed scheduled message', async () => {
        const sendMock = vi.fn(async () => {})
        const api = createMockApi(sendMock)
        const scheduledAt = Date.now() + 5 * 60_000

        const { getMessageWindowState } = await import('@/lib/message-window-store')
        vi.mocked(getMessageWindowState).mockReturnValueOnce({
            messages: [],
            pending: [{
                id: 'local-retry-1',
                seq: null,
                localId: 'local-retry-1',
                content: { role: 'user', content: { type: 'text', text: 'hi later' } },
                createdAt: 1_000,
                invokedAt: null,
                scheduledAt,
                status: 'failed',
                originalText: 'hi later',
            } as never],
        } as never)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-A'),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.retryMessage('local-retry-1')
        })

        await waitFor(() => {
            expect(sendMock).toHaveBeenCalled()
        })

        // api.sendMessage(sessionId, text, localId, attachments, scheduledAt)
        expect(sendMock).toHaveBeenCalledWith(
            'session-A',
            'hi later',
            'local-retry-1',
            undefined,
            scheduledAt,
        )
    })
})
