import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useAgyModels } from './useAgyModels'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

describe('useAgyModels', () => {
    it('forces a re-probe for the retry that follows, then goes back to the cached catalog', async () => {
        const getMachineAgyModels = vi.fn(async () => ({
            success: true,
            availableModels: [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }]
        }))
        const api = { getMachineAgyModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useAgyModels({
            api,
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1))
        expect(getMachineAgyModels).toHaveBeenLastCalledWith('machine-1', { refresh: false })

        act(() => { result.current.refetch() })
        await waitFor(() => expect(getMachineAgyModels).toHaveBeenCalledTimes(2))
        expect(getMachineAgyModels).toHaveBeenLastCalledWith('machine-1', { refresh: true })

        await queryClient.refetchQueries({ queryKey: ['machine-agy-models', 'machine-1'] })
        expect(getMachineAgyModels).toHaveBeenLastCalledWith('machine-1', { refresh: false })
    })

    it('separates a catalog that is merely out of date from one that could not be loaded', async () => {
        const getMachineAgyModels = vi.fn(async () => ({
            success: true,
            availableModels: [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }],
            error: 'Authentication required. Please run `agy` in a terminal to sign in with Google.'
        }))
        const api = { getMachineAgyModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useAgyModels({
            api,
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1))
        expect(result.current.error).toBeNull()
        expect(result.current.warning).toContain('Authentication required')
        expect(result.current.isFetching).toBe(false)
    })
})
