import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSessionFileSearch } from './useSessionFileSearch'
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

describe('useSessionFileSearch', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns empty files when api is null', () => {
        const { result } = renderHook(
            () => useSessionFileSearch(null, 'session-123', 'query'),
            { wrapper: createWrapper() }
        )
        expect(result.current.files).toEqual([])
        expect(result.current.isLoading).toBe(false)
    })

    it('returns empty files when sessionId is null', () => {
        const mockApi = {} as ApiClient
        const { result } = renderHook(
            () => useSessionFileSearch(mockApi, null, 'query'),
            { wrapper: createWrapper() }
        )
        expect(result.current.files).toEqual([])
        expect(result.current.isLoading).toBe(false)
    })

    it('searches files successfully', async () => {
        const mockFiles = [
            { fileName: 'test.ts', filePath: '/src', fullPath: '/src/test.ts', fileType: 'file' as const },
            { fileName: 'app.tsx', filePath: '/src', fullPath: '/src/app.tsx', fileType: 'file' as const }
        ]
        const mockApi = {
            searchSessionFiles: vi.fn().mockResolvedValue({
                success: true,
                files: mockFiles
            })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionFileSearch(mockApi, 'session-123', 'test'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.searchSessionFiles).toHaveBeenCalledWith('session-123', 'test', 200)
        expect(result.current.files).toEqual(mockFiles)
        expect(result.current.error).toBe(null)
    })

    it('respects custom limit option', async () => {
        const mockApi = {
            searchSessionFiles: vi.fn().mockResolvedValue({
                success: true,
                files: []
            })
        } as unknown as ApiClient

        renderHook(
            () => useSessionFileSearch(mockApi, 'session-123', 'query', { limit: 50 }),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(mockApi.searchSessionFiles).toHaveBeenCalledWith('session-123', 'query', 50)
        })
    })

    it('handles search error', async () => {
        const mockApi = {
            searchSessionFiles: vi.fn().mockResolvedValue({
                success: false,
                error: 'Search failed'
            })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessionFileSearch(mockApi, 'session-123', 'query'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.files).toEqual([])
        expect(result.current.error).toBe('Search failed')
    })
})
