import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { useCancelQueuedMessage } from './useCancelQueuedMessage'

const storeMocks = vi.hoisted(() => ({
    appendOptimisticMessage: vi.fn(),
    removeOptimisticMessage: vi.fn(),
    markMessagesConsumed: vi.fn(),
    markMessagesRequeued: vi.fn(),
}))

vi.mock('@/lib/message-window-store', () => ({
    appendOptimisticMessage: storeMocks.appendOptimisticMessage,
    removeOptimisticMessage: storeMocks.removeOptimisticMessage,
    markMessagesConsumed: storeMocks.markMessagesConsumed,
    markMessagesRequeued: storeMocks.markMessagesRequeued,
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { notification: vi.fn() },
    }),
}))

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function makeSnapshot(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'server-message-id',
        localId: 'local-1',
        createdAt: 1000,
        seq: 1,
        invokedAt: null,
        status: 'queued',
        content: {
            role: 'user',
            content: { type: 'text', text: 'Queued request' },
        },
        ...overrides,
    } as unknown as DecryptedMessage
}

describe('useCancelQueuedMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('restores an indeterminate held row when cancel returns busy for a normal queued message', async () => {
        const api = {
            cancelMessage: vi.fn().mockResolvedValue({ status: 'busy', localId: 'local-1' }),
            getQueuedState: vi.fn().mockResolvedValue({ invokedLocalMessages: [], queuedLocalIds: ['local-1'] }),
        } as unknown as ApiClient
        const snapshot = makeSnapshot()

        const { result } = renderHook(() => useCancelQueuedMessage(api), { wrapper: createWrapper() })

        await act(async () => {
            await result.current.mutateAsync({
                sessionId: 'session-1',
                messageId: 'server-message-id',
                localId: 'local-1',
                snapshot,
            })
        })

        expect(storeMocks.removeOptimisticMessage).toHaveBeenCalledWith('session-1', 'local-1')
        expect(storeMocks.appendOptimisticMessage).toHaveBeenCalledWith('session-1', {
            ...snapshot,
            deliveryState: 'indeterminate',
        })
    })

    it('force-dismisses an already-indeterminate row when cancel returns busy (#1839)', async () => {
        const api = {
            cancelMessage: vi.fn().mockResolvedValue({ status: 'busy', localId: 'local-1' }),
            getQueuedState: vi.fn().mockResolvedValue({
                invokedLocalMessages: [],
                queuedLocalIds: [],
                indeterminateLocalIds: ['local-1'],
            }),
        } as unknown as ApiClient
        const snapshot = makeSnapshot({ deliveryState: 'indeterminate' })

        const { result } = renderHook(() => useCancelQueuedMessage(api), { wrapper: createWrapper() })

        await act(async () => {
            await result.current.mutateAsync({
                sessionId: 'session-1',
                messageId: 'server-message-id',
                localId: 'local-1',
                snapshot,
            })
        })

        expect(storeMocks.removeOptimisticMessage).toHaveBeenCalledWith('session-1', 'local-1')
        expect(storeMocks.appendOptimisticMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            deliveryState: 'indeterminate',
            queueDismissed: true,
        }))
        expect(storeMocks.markMessagesConsumed).not.toHaveBeenCalled()
    })

    it('upgrades force-dismiss busy to invoked when getQueuedState reports consumed', async () => {
        const api = {
            cancelMessage: vi.fn().mockResolvedValue({ status: 'busy', localId: 'local-1' }),
            getQueuedState: vi.fn().mockResolvedValue({
                invokedLocalMessages: [{ localId: 'local-1', invokedAt: 42 }],
                queuedLocalIds: [],
            }),
        } as unknown as ApiClient
        const snapshot = makeSnapshot({ deliveryState: 'indeterminate' })

        const { result } = renderHook(() => useCancelQueuedMessage(api), { wrapper: createWrapper() })

        let cancelResult: unknown
        await act(async () => {
            cancelResult = await result.current.mutateAsync({
                sessionId: 'session-1',
                messageId: 'server-message-id',
                localId: 'local-1',
                snapshot,
            })
        })

        expect(cancelResult).toEqual({
            status: 'invoked',
            message: expect.objectContaining({
                id: 'server-message-id',
                localId: 'local-1',
                invokedAt: 42,
            }),
        })
        await waitFor(() => {
            expect(storeMocks.appendOptimisticMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
                id: 'server-message-id',
                localId: 'local-1',
                status: 'sent',
                invokedAt: 42,
            }))
        })
        // Hidden hold restored before getQueuedState, then sent after synthetic invoked.
        expect(storeMocks.appendOptimisticMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            deliveryState: 'indeterminate',
            queueDismissed: true,
        }))
        expect(storeMocks.appendOptimisticMessage).toHaveBeenCalledTimes(2)
    })

    it('clears force-dismiss when getQueuedState reports the row is back in FIFO', async () => {
        const api = {
            cancelMessage: vi.fn().mockResolvedValue({ status: 'busy', localId: 'local-1' }),
            getQueuedState: vi.fn().mockResolvedValue({
                invokedLocalMessages: [],
                queuedLocalIds: ['local-1'],
            }),
        } as unknown as ApiClient
        const snapshot = makeSnapshot({ deliveryState: 'indeterminate' })

        const { result } = renderHook(() => useCancelQueuedMessage(api), { wrapper: createWrapper() })

        let cancelResult: unknown
        await act(async () => {
            cancelResult = await result.current.mutateAsync({
                sessionId: 'session-1',
                messageId: 'server-message-id',
                localId: 'local-1',
                snapshot,
            })
        })

        expect(cancelResult).toEqual({ status: 'busy', localId: 'local-1' })
        expect(storeMocks.appendOptimisticMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            queueDismissed: true,
        }))
        expect(storeMocks.markMessagesRequeued).toHaveBeenCalledWith('session-1', ['local-1'])
    })
})
