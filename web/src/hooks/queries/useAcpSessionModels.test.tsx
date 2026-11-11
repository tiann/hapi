import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import * as acpSessionModels from './useAcpSessionModels'
import { useHermesModelsForSession } from './useAcpSessionModels'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useAcpSessionModels after the berry rail retirement', () => {
    it('keeps fetching the live Hermes catalog over the session connection', async () => {
        const getSessionHermesModels = vi.fn(async () => ({
            success: true,
            availableModels: [{ modelId: 'newapi:glm-5.3', name: 'GLM 5.3' }],
            currentModelId: 'newapi:glm-5.3'
        }))
        const api = { getSessionHermesModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useHermesModelsForSession({
            api,
            sessionId: 'session-hermes',
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1))
        expect(getSessionHermesModels).toHaveBeenCalledWith('session-hermes')
        expect(result.current.currentModelId).toBe('newapi:glm-5.3')
        expect(result.current.error).toBeNull()
    })

    it('does not probe hermes models without an enabled session', () => {
        const getSessionHermesModels = vi.fn()
        const api = { getSessionHermesModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        renderHook(() => useHermesModelsForSession({
            api,
            sessionId: 'session-hermes',
            enabled: false
        }), { wrapper: wrapper(queryClient) })
        renderHook(() => useHermesModelsForSession({
            api,
            sessionId: null,
            enabled: true
        }), { wrapper: wrapper(queryClient) })

        expect(getSessionHermesModels).not.toHaveBeenCalled()
    })

    it('exposes no berry session-model hook (berry has no runtime model face)', () => {
        // Berry's only model lever is the spawn-time BERRY_AGENT_MODEL env
        // (CLI-owned): the ListBerryModels rail — hook, api client method and
        // hub route — is retired. Guard against an accidental reintroduction
        // of the dead fetch path on the shared hook module.
        expect(acpSessionModels).not.toHaveProperty('useBerryModelsForSession')
    })
})
