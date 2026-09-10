import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useAgyModels } from './useAgyModels'
import { applyAgyCatalogAnnouncement } from '@/lib/agyCatalogAnnouncement'

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

describe('useAgyModels catalog invalidation', () => {
    const OLD = [{ modelId: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' }]
    const NEW = [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }]

    it('redraws an open picker onto the newer listing when the machine announces one', async () => {
        let call = 0
        const getMachineAgyModels = vi.fn(async () => ({
            success: true,
            availableModels: (call += 1) === 1 ? OLD : NEW
        }))
        const api = { getMachineAgyModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useAgyModels({
            api, machineId: 'machine-1', enabled: true
        }), { wrapper: wrapper(queryClient) })
        await waitFor(() => expect(result.current.availableModels).toEqual(OLD))

        await act(async () => {
            await applyAgyCatalogAnnouncement(queryClient, 'machine-1')
        })

        await waitFor(() => expect(result.current.availableModels).toEqual(NEW))
        queryClient.clear()
    })

    it('does not let a reply carrying the superseded listing land on top of the newer one', async () => {
        // The announcement can arrive while the request that will answer with the
        // old listing is still in flight.
        let release: (() => void) | null = null
        let call = 0
        const getMachineAgyModels = vi.fn(async () => {
            call += 1
            if (call === 2) {
                await new Promise<void>((resolve) => { release = resolve })
                return { success: true, availableModels: OLD }
            }
            return { success: true, availableModels: call === 1 ? OLD : NEW }
        })
        const api = { getMachineAgyModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useAgyModels({
            api, machineId: 'machine-1', enabled: true
        }), { wrapper: wrapper(queryClient) })
        await waitFor(() => expect(result.current.availableModels).toEqual(OLD))

        act(() => { result.current.refetch() })
        await waitFor(() => expect(getMachineAgyModels).toHaveBeenCalledTimes(2))

        await act(async () => {
            await applyAgyCatalogAnnouncement(queryClient, 'machine-1')
        })
        await waitFor(() => expect(result.current.availableModels).toEqual(NEW))

        await act(async () => {
            release?.()
            await new Promise((resolve) => setTimeout(resolve, 50))
        })
        expect(result.current.availableModels).toEqual(NEW)
        queryClient.clear()
    })

    it('does not let the very first reply win when the announcement beat it', async () => {
        // `Query.fetch` cancels an in-flight request only when the query already
        // holds data, so a cold first mount has to be forced a second fetch.
        let release: (() => void) | null = null
        let call = 0
        const getMachineAgyModels = vi.fn(async () => {
            call += 1
            if (call === 1) {
                await new Promise<void>((resolve) => { release = resolve })
                return { success: true, availableModels: OLD }
            }
            return { success: true, availableModels: NEW }
        })
        const api = { getMachineAgyModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        const { result } = renderHook(() => useAgyModels({
            api, machineId: 'machine-1', enabled: true
        }), { wrapper: wrapper(queryClient) })
        await waitFor(() => expect(getMachineAgyModels).toHaveBeenCalledTimes(1))
        expect(result.current.availableModels).toEqual([])

        // The announcement lands while that first request is still open.
        await act(async () => {
            await applyAgyCatalogAnnouncement(queryClient, 'machine-1')
        })
        await act(async () => {
            release?.()
            await new Promise((resolve) => setTimeout(resolve, 50))
        })

        await waitFor(() => expect(result.current.availableModels).toEqual(NEW))
        queryClient.clear()
    })

    it('makes one request for two consumers of the same machine, not two', async () => {
        const getMachineAgyModels = vi.fn(async () => ({ success: true, availableModels: NEW }))
        const api = { getMachineAgyModels } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const shared = wrapper(queryClient)

        const first = renderHook(() => useAgyModels({ api, machineId: 'machine-1', enabled: true }), { wrapper: shared })
        const second = renderHook(() => useAgyModels({ api, machineId: 'machine-1', enabled: true }), { wrapper: shared })

        await waitFor(() => expect(first.result.current.availableModels).toHaveLength(1))
        await waitFor(() => expect(second.result.current.availableModels).toHaveLength(1))
        expect(getMachineAgyModels).toHaveBeenCalledTimes(1)

        await act(async () => {
            await applyAgyCatalogAnnouncement(queryClient, 'machine-1')
        })
        expect(getMachineAgyModels).toHaveBeenCalledTimes(2)
        queryClient.clear()
    })
})
