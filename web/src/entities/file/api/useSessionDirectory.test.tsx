import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSessionDirectory } from './useSessionDirectory'
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

describe('useSessionDirectory', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns empty entries when api is null', () => {
        const { result } = renderHook(
            () => useSessionDirectory(null, 'session-123', '/path'),
            { wrapper: createWrapper() }
        )
        expect(result.current.entries).toEqual([])
        expect(result.current.isLoading).toBe(false)
    })

    it('returns empty entries when sessionId is null', () => {
        const mockApi = {} as ApiClient
        const { result } = renderHook(
            () => useSessionDirectory(mockApi, null, '/path'),
            { wrapper: createWrapper() }
        )
        expect(result.current.entries).toEqual([])
        expect(result.current.isLoading).toBe(false)
    })

    it('fetches directory entries successfully', async () => {
        const mockEntries = [
            { name: 'file1.txt', type: 'file' as const, size: 100 },
            { name: 'dir1', type: 'directory' as const }
        ]
        const mockApi = {
            listSessionDirectory: vi.fn().mockResolvedValue({
                success: true,
                entries: mockEntries
            })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionDirectory(mockApi, 'session-123', '/path'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.listSessionDirectory).toHaveBeenCalledWith('session-123', '/path')
        expect(result.current.entries).toEqual(mockEntries)
        expect(result.current.error).toBe(null)
    })

    it('handles API error', async () => {
        const mockApi = {
            listSessionDirectory: vi.fn().mockResolvedValue({
                success: false,
                error: 'Directory not found'
            })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionDirectory(mockApi, 'session-123', '/path'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.entries).toEqual([])
        expect(result.current.error).toBe('Directory not found')
    })

    it('provides refetch function', async () => {
        const mockApi = {
            listSessionDirectory: vi.fn().mockResolvedValue({
                success: true,
                entries: []
            })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionDirectory(mockApi, 'session-123', '/path'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.listSessionDirectory).toHaveBeenCalledTimes(1)

        await result.current.refetch()
        expect(mockApi.listSessionDirectory).toHaveBeenCalledTimes(2)
    })
})
