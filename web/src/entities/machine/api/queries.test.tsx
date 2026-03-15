import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMachines } from './queries'
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

describe('useMachines', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns empty machines when api is null', () => {
        const { result } = renderHook(
            () => useMachines(null, true),
            { wrapper: createWrapper() }
        )
        expect(result.current.machines).toEqual([])
        expect(result.current.isLoading).toBe(false)
    })

    it('does not fetch when enabled is false', () => {
        const mockApi = {
            getMachines: vi.fn()
        } as unknown as ApiClient

        renderHook(
            () => useMachines(mockApi, false),
            { wrapper: createWrapper() }
        )

        expect(mockApi.getMachines).not.toHaveBeenCalled()
    })

    it('fetches machines successfully', async () => {
        const mockMachines = [
            { id: 'machine-1', hostname: 'localhost', platform: 'linux' },
            { id: 'machine-2', hostname: 'remote', platform: 'darwin' }
        ]
        const mockApi = {
            getMachines: vi.fn().mockResolvedValue({
                machines: mockMachines
            })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useMachines(mockApi, true),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.getMachines).toHaveBeenCalled()
        expect(result.current.machines).toEqual(mockMachines)
        expect(result.current.error).toBe(null)
    })

    it('handles fetch error', async () => {
        const mockApi = {
            getMachines: vi.fn().mockRejectedValue(new Error('Network error'))
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useMachines(mockApi, true),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.machines).toEqual([])
        expect(result.current.error).toBe('Network error')
    })

    it('provides refetch function', async () => {
        const mockApi = {
            getMachines: vi.fn().mockResolvedValue({ machines: [] })
        } as unknown as ApiClient

        const { result } = renderHook(
            () => useMachines(mockApi, true),
            { wrapper: createWrapper() }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(mockApi.getMachines).toHaveBeenCalledTimes(1)

        await result.current.refetch()
        expect(mockApi.getMachines).toHaveBeenCalledTimes(2)
    })
})
