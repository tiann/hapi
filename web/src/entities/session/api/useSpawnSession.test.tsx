import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSpawnSession } from './useSpawnSession'
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

describe('useSpawnSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns error when api is null', async () => {
        const { result } = renderHook(() => useSpawnSession(null), {
            wrapper: createWrapper(),
        })

        await expect(
            result.current.spawnSession({
                machineId: 'machine-1',
                directory: '/path',
            })
        ).rejects.toThrow('API unavailable')
    })

    it('spawns session successfully', async () => {
        const mockApi = {
            spawnSession: vi.fn().mockResolvedValue({
                type: 'success',
                sessionId: 'new-session-123',
            }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSpawnSession(mockApi), {
            wrapper: createWrapper(),
        })

        const response = await result.current.spawnSession({
            machineId: 'machine-1',
            directory: '/path',
            agent: 'claude',
            yolo: false,
        })

        expect(mockApi.spawnSession).toHaveBeenCalledWith(
            'machine-1',
            '/path',
            'claude',
            undefined,
            false,
            undefined,
            undefined
        )
        expect(response.type).toBe('success')
        expect(response.sessionId).toBe('new-session-123')
    })

    it('handles spawn error', async () => {
        const mockApi = {
            spawnSession: vi.fn().mockResolvedValue({
                type: 'error',
                message: 'Failed to spawn',
            }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSpawnSession(mockApi), {
            wrapper: createWrapper(),
        })

        const response = await result.current.spawnSession({
            machineId: 'machine-1',
            directory: '/path',
        })

        expect(response.type).toBe('error')
        expect(response.message).toBe('Failed to spawn')
    })

    it('passes worktree parameters', async () => {
        const mockApi = {
            spawnSession: vi.fn().mockResolvedValue({
                type: 'success',
                sessionId: 'worktree-session',
            }),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSpawnSession(mockApi), {
            wrapper: createWrapper(),
        })

        await result.current.spawnSession({
            machineId: 'machine-1',
            directory: '/path',
            sessionType: 'worktree',
            worktreeName: 'feature-branch',
        })

        expect(mockApi.spawnSession).toHaveBeenCalledWith(
            'machine-1',
            '/path',
            undefined,
            undefined,
            undefined,
            'worktree',
            'feature-branch'
        )
    })

    it('tracks pending state', async () => {
        const mockApi = {
            spawnSession: vi.fn().mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve({ type: 'success', sessionId: 'test' }), 100))
            ),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSpawnSession(mockApi), {
            wrapper: createWrapper(),
        })

        expect(result.current.isPending).toBe(false)

        const promise = result.current.spawnSession({
            machineId: 'machine-1',
            directory: '/path',
        })

        await waitFor(() => {
            expect(result.current.isPending).toBe(true)
        })

        await promise

        await waitFor(() => {
            expect(result.current.isPending).toBe(false)
        })
    })
})
