import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useKimiModelsForSession } from './useKimiModelsForSession'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useKimiModelsForSession', () => {
    it('reads the catalog over the active session connection', async () => {
        const getSessionKimiModels = vi.fn(async () => ({
            success: true,
            availableModels: [
                { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' }
            ],
            currentModelId: 'GLM-5.3-flash'
        }))
        const api = { getSessionKimiModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useKimiModelsForSession({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1))
        expect(getSessionKimiModels).toHaveBeenCalledWith('session-1')
        expect(result.current.availableModels[0]).toEqual({
            modelId: 'GLM-5.3-flash',
            name: 'thehive / GLM-5.3-flash',
            provider: 'thehive'
        })
        expect(result.current.currentModelId).toBe('GLM-5.3-flash')
        expect(result.current.error).toBeNull()
    })

    it('surfaces a failed session probe as an error with no catalog', async () => {
        const getSessionKimiModels = vi.fn(async () => ({
            success: false,
            error: 'Kimi model discovery timed out'
        }))
        const api = { getSessionKimiModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useKimiModelsForSession({
            api,
            sessionId: 'session-1',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.error).toBe('Kimi model discovery timed out'))
        expect(result.current.availableModels).toEqual([])
        expect(result.current.currentModelId).toBeNull()
    })

    it('does not probe without an active session', () => {
        const getSessionKimiModels = vi.fn()
        const api = { getSessionKimiModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const disabled = renderHook(() => useKimiModelsForSession({
            api,
            sessionId: 'session-1',
            enabled: false
        }), { wrapper: wrapper(queryClient) })
        const withoutSession = renderHook(() => useKimiModelsForSession({
            api,
            sessionId: null,
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        expect(getSessionKimiModels).not.toHaveBeenCalled()
        expect(disabled.result.current.availableModels).toEqual([])
        expect(withoutSession.result.current.availableModels).toEqual([])
    })

    it('keys the cache per session', async () => {
        const getSessionKimiModels = vi.fn(async (sessionId: string) => ({
            success: true,
            availableModels: [{ modelId: `${sessionId}-alias` }],
            currentModelId: null
        }))
        const api = { getSessionKimiModels } as unknown as ApiClient
        const queryClient = createQueryClient()
        const shared = wrapper(queryClient)

        const first = renderHook(() => useKimiModelsForSession({
            api, sessionId: 'session-1', enabled: true
        }), { wrapper: shared })
        const second = renderHook(() => useKimiModelsForSession({
            api, sessionId: 'session-2', enabled: true
        }), { wrapper: shared })

        await waitFor(() => expect(first.result.current.availableModels[0]?.modelId).toBe('session-1-alias'))
        await waitFor(() => expect(second.result.current.availableModels[0]?.modelId).toBe('session-2-alias'))
        expect(getSessionKimiModels).toHaveBeenCalledTimes(2)
    })
})
