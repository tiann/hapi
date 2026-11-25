import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useClaudeModels } from './useClaudeModels'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

const catalog = {
    success: true,
    availableModels: [{ value: 'opus', effortLevels: ['low'] }]
}

describe('useClaudeModels', () => {
    it('returns the machine catalog while enabled', async () => {
        const getMachineClaudeModels = vi.fn(async () => catalog)
        const api = { getMachineClaudeModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useClaudeModels({ api, machineId: 'machine-1', enabled: true }), {
            wrapper: wrapper(queryClient)
        })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1))
    })

    it('does not hand a cached Claude catalog to a session of another agent on the same machine', () => {
        const getMachineClaudeModels = vi.fn(async () => catalog)
        const api = { getMachineClaudeModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        queryClient.setQueryData(queryKeys.machineClaudeModels('machine-1'), catalog)

        const { result } = renderHook(() => useClaudeModels({ api, machineId: 'machine-1', enabled: false }), {
            wrapper: wrapper(queryClient)
        })

        expect(result.current.availableModels).toEqual([])
        expect(getMachineClaudeModels).not.toHaveBeenCalled()
    })

    it('retries a failed discovery the next time a picker mounts', async () => {
        // The machine answers a failed probe with success:false; caching that as
        // a successful result would keep the built-in list for the stale time
        // even after the user signs in.
        const getMachineClaudeModels = vi.fn()
            .mockResolvedValueOnce({
                success: false,
                error: 'Claude model discovery timed out',
                availableModels: catalog.availableModels
            })
            .mockResolvedValueOnce(catalog)
        const api = { getMachineClaudeModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const first = renderHook(() => useClaudeModels({ api, machineId: 'machine-1', enabled: true }), {
            wrapper: wrapper(queryClient)
        })
        await waitFor(() => expect(getMachineClaudeModels).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(queryClient.getQueryState(queryKeys.machineClaudeModels('machine-1'))?.fetchStatus).toBe('idle'))
        expect(first.result.current.availableModels).toEqual([])
        first.unmount()

        const second = renderHook(() => useClaudeModels({ api, machineId: 'machine-1', enabled: true }), {
            wrapper: wrapper(queryClient)
        })
        await waitFor(() => expect(second.result.current.availableModels).toHaveLength(1))
        expect(getMachineClaudeModels).toHaveBeenCalledTimes(2)
    })
})
