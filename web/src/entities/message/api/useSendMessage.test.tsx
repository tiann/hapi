import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSendMessage } from './useSendMessage'
import type { ApiClient } from '@/api/client'
import type { ReactNode } from 'react'

// Mock usePlatform hook
vi.mock('@/shared/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
        },
    }),
}))

// Mock message-window-store
vi.mock('@/lib/message-window-store', () => ({
    appendOptimisticMessage: vi.fn(),
    updateMessageStatus: vi.fn(),
    getMessageWindowState: vi.fn(() => ({
        messages: [],
        pending: [],
    })),
}))

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

describe('useSendMessage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('blocks sending when api is null', () => {
        const onBlocked = vi.fn()
        const { result } = renderHook(
            () => useSendMessage(null, 'session-123', { onBlocked }),
            { wrapper: createWrapper() }
        )

        result.current.sendMessage('Hello')

        expect(onBlocked).toHaveBeenCalledWith('no-api')
    })

    it('blocks sending when sessionId is null', () => {
        const mockApi = {} as ApiClient
        const onBlocked = vi.fn()
        const { result } = renderHook(
            () => useSendMessage(mockApi, null, { onBlocked }),
            { wrapper: createWrapper() }
        )

        result.current.sendMessage('Hello')

        expect(onBlocked).toHaveBeenCalledWith('no-session')
    })

    it('sends message successfully', async () => {
        const mockApi = {
            sendMessage: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSendMessage(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        result.current.sendMessage('Hello world')

        await waitFor(() => {
            expect(mockApi.sendMessage).toHaveBeenCalled()
        })

        const callArgs = (mockApi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(callArgs[0]).toBe('session-123')
        expect(callArgs[1]).toBe('Hello world')
        expect(typeof callArgs[2]).toBe('string') // localId
    })

    it('sends message with attachments', async () => {
        const mockApi = {
            sendMessage: vi.fn().mockResolvedValue(undefined),
        } as unknown as ApiClient

        const attachments = [
            {
                id: 'att-1',
                filename: 'test.txt',
                mimeType: 'text/plain',
                size: 100,
                path: '/uploads/test.txt',
            },
        ]

        const { result } = renderHook(
            () => useSendMessage(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        result.current.sendMessage('Check this file', attachments)

        await waitFor(() => {
            expect(mockApi.sendMessage).toHaveBeenCalled()
        })

        const callArgs = (mockApi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(callArgs[3]).toEqual(attachments)
    })

    it('tracks sending state', async () => {
        const mockApi = {
            sendMessage: vi.fn().mockImplementation(
                () => new Promise((resolve) => setTimeout(resolve, 100))
            ),
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSendMessage(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        expect(result.current.isSending).toBe(false)

        result.current.sendMessage('Hello')

        await waitFor(() => {
            expect(result.current.isSending).toBe(true)
        })

        await waitFor(() => {
            expect(result.current.isSending).toBe(false)
        }, { timeout: 200 })
    })
})
