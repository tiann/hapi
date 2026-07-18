import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSendMessage } from './useSendMessage'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, updateMessageStatus } from '@/lib/message-window-store'

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

    it('resolves the target session before retrying a failed message', async () => {
        const onSuccess = vi.fn()
        const onSessionResolved = vi.fn()
        const sendMessage = vi.fn(async () => {})
        const api = createMockApi(sendMessage)
        vi.mocked(getMessageWindowState).mockReturnValue({
            messages: [
                {
                    id: 'local-id-1',
                    seq: null,
                    localId: 'local-id-1',
                    content: {
                        role: 'user',
                        content: { type: 'text', text: 'hello' },
                    },
                    createdAt: 123,
                    status: 'failed',
                    originalText: 'hello',
                },
            ],
            pending: [],
        } as unknown as ReturnType<typeof getMessageWindowState>)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                onSuccess,
                resolveSessionId: async () => 'session-resolved',
                onSessionResolved,
            }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.retryMessage('local-id-1')
        })

        await waitFor(() => {
            expect(sendMessage).toHaveBeenCalledWith('session-resolved', 'hello', 'local-id-1', undefined)
        })
        expect(onSessionResolved).toHaveBeenCalledWith('session-resolved')
        expect(onSuccess).toHaveBeenCalledWith('session-resolved')
        expect(updateMessageStatus).not.toHaveBeenCalledWith('session-original', 'local-id-1', 'sending')
        expect(updateMessageStatus).toHaveBeenCalledWith('session-resolved', 'local-id-1', 'sent')
    })

    it('restores failed status when resolving the retry target fails', async () => {
        const onSuccess = vi.fn()
        const onSessionResolved = vi.fn()
        const sendMessage = vi.fn(async () => {})
        const api = createMockApi(sendMessage)
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(getMessageWindowState).mockReturnValue({
            messages: [
                {
                    id: 'local-id-1',
                    seq: null,
                    localId: 'local-id-1',
                    content: {
                        role: 'user',
                        content: { type: 'text', text: 'hello' },
                    },
                    createdAt: 123,
                    status: 'failed',
                    originalText: 'hello',
                },
            ],
            pending: [],
        } as unknown as ReturnType<typeof getMessageWindowState>)

        const { result } = renderHook(
            () => useSendMessage(api, 'session-original', {
                onSuccess,
                resolveSessionId: async () => { throw new Error('takeover failed') },
                onSessionResolved,
            }),
            { wrapper: createWrapper() },
        )

        act(() => {
            result.current.retryMessage('local-id-1')
        })

        await waitFor(() => {
            expect(result.current.isSending).toBe(false)
        })
        expect(sendMessage).not.toHaveBeenCalled()
        expect(onSessionResolved).not.toHaveBeenCalled()
        expect(onSuccess).not.toHaveBeenCalled()
        expect(updateMessageStatus).toHaveBeenCalledWith('session-original', 'local-id-1', 'failed')
        expect(errorSpy).toHaveBeenCalledWith('Failed to resolve session before retry:', expect.any(Error))
        errorSpy.mockRestore()
    })
})
