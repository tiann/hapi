import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSession } from './useSession'
import type { ApiClient } from '@/api/client'
import type { ReactNode } from 'react'

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

describe('useSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns null when api is null', () => {
        const { result } = renderHook(() => useSession(null, 'session-123'), {
            wrapper: createWrapper(),
        })
        expect(result.current.session).toBe(null)
        expect(result.current.isLoading).toBe(false)
    })

    it('returns null when sessionId is null', () => {
        const mockApi = {} as ApiClient
        const { result } = renderHook(() => useSession(mockApi, null), {
            wrapper: createWrapper(),
        })
        expect(result.current.session).toBe(null)
        expect(result.current.isLoading).toBe(false)
    })

    it('fetches session data when api and sessionId are provided', async () => {
        const mockSession = {
            id: 'session-123',
            metadata: { name: 'Test Session' },
        }
        const mockApi = {
            getSession: vi.fn().mockResolvedValue({ session: mockSession }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSession(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.getSession).toHaveBeenCalledWith('session-123')
        expect(result.current.session).toEqual(mockSession)
        expect(result.current.error).toBe(null)
    })

    it('handles fetch error', async () => {
        const mockApi = {
            getSession: vi.fn().mockRejectedValue(new Error('Network error')),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSession(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.session).toBe(null)
        expect(result.current.error).toBe('Network error')
    })

    it('provides refetch function', async () => {
        const mockSession = { id: 'session-123' }
        const mockApi = {
            getSession: vi.fn().mockResolvedValue({ session: mockSession }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSession(mockApi, 'session-123'), {
            wrapper: createWrapper(),
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.getSession).toHaveBeenCalledTimes(1)

        await result.current.refetch()
        expect(mockApi.getSession).toHaveBeenCalledTimes(2)
    })
})
