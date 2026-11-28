import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import {
    HERMES_SESSION_RPC_REGISTERING_MAX_RETRIES,
    useHermesModelsForSession
} from './useHermesModels'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useHermesModelsForSession', () => {
    it('retries transient 503 rpc_target_missing errors and resolves once ListHermesModels registers', async () => {
        const getSessionHermesModels = vi.fn()
            .mockRejectedValueOnce(new ApiError('RPC target missing', 503, RPC_TARGET_MISSING_ERROR_CODE))
            .mockResolvedValueOnce({
                success: true,
                availableModels: [
                    { modelId: 'openrouter:openai/gpt-5', name: 'openai/gpt-5' }
                ],
                currentModelId: 'openrouter:openai/gpt-5'
            })
        const api = { getSessionHermesModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useHermesModelsForSession({
            api,
            sessionId: 'hermes-1',
            enabled: true,
            retryDelayMs: 0
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.availableModels).toHaveLength(1))
        expect(getSessionHermesModels).toHaveBeenCalledTimes(2)
        expect(result.current.currentModelId).toBe('openrouter:openai/gpt-5')
        expect(result.current.error).toBeNull()
    })

    it('does not retry non-503 errors', async () => {
        const getSessionHermesModels = vi.fn().mockRejectedValue(
            new ApiError('Bad request', 400, 'bad_request')
        )
        const api = { getSessionHermesModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useHermesModelsForSession({
            api,
            sessionId: 'hermes-2',
            enabled: true,
            retryDelayMs: 0
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.error).toBe('Bad request'))
        expect(getSessionHermesModels).toHaveBeenCalledTimes(1)
    })

    it('stops retrying 503 rpc_target_missing after the retry bound', async () => {
        const getSessionHermesModels = vi.fn().mockRejectedValue(
            new ApiError('RPC target missing', 503, RPC_TARGET_MISSING_ERROR_CODE)
        )
        const api = { getSessionHermesModels } as unknown as ApiClient
        const queryClient = createQueryClient()

        const { result } = renderHook(() => useHermesModelsForSession({
            api,
            sessionId: 'hermes-3',
            enabled: true,
            retryDelayMs: 0
        }), { wrapper: wrapper(queryClient) })

        await waitFor(() => expect(result.current.error).toBe('RPC target missing'))
        expect(getSessionHermesModels).toHaveBeenCalledTimes(HERMES_SESSION_RPC_REGISTERING_MAX_RETRIES + 1)
    })
})
