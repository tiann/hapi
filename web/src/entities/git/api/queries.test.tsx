import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitStatusFiles } from './queries'
import type { ApiClient } from '@/api/client'
import type { ReactNode } from 'react'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <QueryClientProvider client={queryClient}>
                {children}
            </QueryClientProvider>
        )
    }
}

describe('useGitStatusFiles', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns null when api is null', () => {
        const { result } = renderHook(
            () => useGitStatusFiles(null, 'session-123'),
            { wrapper: createWrapper() }
        )
        expect(result.current.status).toBe(null)
        expect(result.current.isLoading).toBe(false)
    })

    it('returns null when sessionId is null', () => {
        const mockApi = {} as ApiClient
        const { result } = renderHook(
            () => useGitStatusFiles(mockApi, null),
            { wrapper: createWrapper() }
        )
        expect(result.current.status).toBe(null)
        expect(result.current.isLoading).toBe(false)
    })

    it('fetches git status successfully', async () => {
        const mockApi = {
            getGitStatus: vi.fn().mockResolvedValue({
                success: true,
                stdout: 'M  file.ts\n?? new.ts'
            }),
            getGitDiffNumstat: vi.fn()
                .mockResolvedValueOnce({ success: true, stdout: '10\t5\tfile.ts' })
                .mockResolvedValueOnce({ success: true, stdout: '' })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useGitStatusFiles(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.getGitStatus).toHaveBeenCalledWith('session-123')
        expect(mockApi.getGitDiffNumstat).toHaveBeenCalledTimes(2)
        expect(result.current.status).not.toBe(null)
        expect(result.current.error).toBe(null)
    })

    it('handles git status error', async () => {
        const mockApi = {
            getGitStatus: vi.fn().mockResolvedValue({
                success: false,
                error: 'Not a git repository'
            })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useGitStatusFiles(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.status).toBe(null)
        expect(result.current.error).toContain('Not a git repository')
    })

    it('handles partial diff errors', async () => {
        const mockApi = {
            getGitStatus: vi.fn().mockResolvedValue({
                success: true,
                stdout: 'M  file.ts'
            }),
            getGitDiffNumstat: vi.fn()
                .mockResolvedValueOnce({ success: false, error: 'Diff failed' })
                .mockResolvedValueOnce({ success: true, stdout: '' })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useGitStatusFiles(mockApi, 'session-123'),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.status).not.toBe(null)
        expect(result.current.error).toContain('Unstaged diff unavailable')
    })
})
