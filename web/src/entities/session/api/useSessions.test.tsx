import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSessions } from './useSessions'
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

describe('useSessions', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns empty array when api is null', () => {
        const { result } = renderHook(() => useSessions(null), {
            wrapper: createWrapper(),
        })
        expect(result.current.sessions).toEqual([])
        expect(result.current.isLoading).toBe(false)
    })

    it('fetches sessions when api is provided', async () => {
        const mockSessions = [
            { id: 'session-1', metadata: { name: 'Session 1' } },
            { id: 'session-2', metadata: { name: 'Session 2' } },
        ]
        const mockApi = {
            getSessions: vi.fn().mockResolvedValue({ sessions: mockSessions }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSessions(mockApi), {
            wrapper: createWrapper(),
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.getSessions).toHaveBeenCalled()
        expect(result.current.sessions).toEqual(mockSessions)
        expect(result.current.error).toBe(null)
    })

    it('handles fetch error', async () => {
        const mockApi = {
            getSessions: vi.fn().mockRejectedValue(new Error('Network error')),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSessions(mockApi), {
            wrapper: createWrapper(),
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.sessions).toEqual([])
        expect(result.current.error).toBe('Network error')
    })

    it('provides refetch function', async () => {
        const mockSessions = [{ id: 'session-1' }]
        const mockApi = {
            getSessions: vi.fn().mockResolvedValue({ sessions: mockSessions }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSessions(mockApi), {
            wrapper: createWrapper(),
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.getSessions).toHaveBeenCalledTimes(1)

        await result.current.refetch()
        expect(mockApi.getSessions).toHaveBeenCalledTimes(2)
    })

    it('returns empty array when response has no sessions', async () => {
        const mockApi = {
            getSessions: vi.fn().mockResolvedValue({ sessions: undefined }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSessions(mockApi), {
            wrapper: createWrapper(),
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.sessions).toEqual([])
    })
})
