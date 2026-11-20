import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import { useCodexModels } from './useCodexModels'

function wrapper(queryClient: QueryClient) {
    return ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false }
        }
    })
}

describe('useCodexModels query scoping', () => {
    it('uses a shared session connection before machine discovery', async () => {
        const getMachineCodexModels = vi.fn()
        const getSessionCodexModels = vi.fn(async () => ({
            success: true,
            models: [{ id: 'session-model', displayName: 'Session Model', isDefault: true }]
        }))
        const api = { getMachineCodexModels, getSessionCodexModels } as unknown as ApiClient

        const result = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-1',
            machineId: 'machine-1',
            preferSession: true,
            enabled: true
        }), { wrapper: wrapper(createQueryClient()) })

        await waitFor(() => expect(result.result.current.models[0]?.id).toBe('session-model'))
        expect(result.result.current.catalogSource).toBe('session')
        expect(getSessionCodexModels).toHaveBeenCalledWith('session-1')
        expect(getMachineCodexModels).not.toHaveBeenCalled()
    })

    it('uses machine discovery when a shared session has no model RPC', async () => {
        const getSessionCodexModels = vi.fn(async () => {
            throw new ApiError('session RPC unavailable', 503, RPC_TARGET_MISSING_ERROR_CODE)
        })
        const getMachineCodexModels = vi.fn(async () => ({
            success: true,
            models: [{ id: 'machine-model', displayName: 'Machine Model', isDefault: true }]
        }))
        const api = { getMachineCodexModels, getSessionCodexModels } as unknown as ApiClient

        const result = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-1',
            machineId: 'machine-1',
            preferSession: true,
            enabled: true
        }), { wrapper: wrapper(createQueryClient()) })

        await waitFor(() => expect(result.result.current.models[0]?.id).toBe('machine-model'))
        expect(result.result.current.catalogSource).toBe('machine')
        expect(getMachineCodexModels).toHaveBeenCalledTimes(1)
    })

    it.each(['available', 'unavailable', 'pending'])('loads the session catalog after slow startup with %s machine discovery', async machine => {
        vi.useFakeTimers()
        try {
            let sessionReady = false
            const getSessionCodexModels = vi.fn(async () => {
                if (!sessionReady) throw new ApiError('session RPC unavailable', 503, RPC_TARGET_MISSING_ERROR_CODE)
                return { success: true, models: [{ id: 'live-model', serviceTiers: ['ultrafast'] }] }
            })
            const getMachineCodexModels = vi.fn(async () => {
                if (machine === 'unavailable') throw new ApiError('machine is unavailable', 503)
                if (machine === 'pending') return await new Promise<never>(() => {})
                return { success: true, models: [{ id: 'fallback-model' }] }
            })
            const api = { getMachineCodexModels, getSessionCodexModels } as unknown as ApiClient
            const { result } = renderHook(() => useCodexModels({
                api,
                sessionId: 'session-1',
                sessionRuntimeGeneration: 'same-generation',
                machineId: 'machine-1',
                preferSession: true,
                enabled: true
            }), { wrapper: wrapper(createQueryClient()) })

            await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
            if (machine === 'available') {
                expect(result.current.models[0]?.id).toBe('fallback-model')
            } else if (machine === 'unavailable') {
                expect(result.current.error).toBe('machine is unavailable')
            } else {
                expect(result.current.isLoading).toBe(true)
            }
            expect(getMachineCodexModels).toHaveBeenCalledTimes(1)

            sessionReady = true
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
            expect(result.current.models[0]?.serviceTiers).toEqual(['ultrafast'])
            expect(result.current.catalogSource).toBe('session')
            expect(result.current.error).toBeNull()
            const settledCalls = getSessionCodexModels.mock.calls.length
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(getSessionCodexModels).toHaveBeenCalledTimes(settledCalls)
        } finally {
            vi.useRealTimers()
        }
    })

    it('shares machine-backed discovery across sessions on the same machine', async () => {
        const getMachineCodexModels = vi.fn(async () => ({
            success: true,
            models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }]
        }))
        const getSessionCodexModels = vi.fn()
        const api = {
            getMachineCodexModels,
            getSessionCodexModels
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        const sharedWrapper = wrapper(queryClient)

        const first = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-1',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })
        const second = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-2',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })

        await waitFor(() => {
            expect(first.result.current.models[0]?.id).toBe('gpt-5.5')
            expect(second.result.current.models[0]?.id).toBe('gpt-5.5')
        })
        expect(getMachineCodexModels).toHaveBeenCalledTimes(1)
        expect(getSessionCodexModels).not.toHaveBeenCalled()
    })

    it('isolates session fallback catalogs after the machine target is missing', async () => {
        const getMachineCodexModels = vi.fn(async () => {
            throw new ApiError(
                'machine RPC unavailable',
                503,
                RPC_TARGET_MISSING_ERROR_CODE
            )
        })
        const getSessionCodexModels = vi.fn(async (sessionId: string) => ({
            success: true,
            models: [{ id: sessionId, displayName: sessionId, isDefault: true }]
        }))
        const api = {
            getMachineCodexModels,
            getSessionCodexModels
        } as unknown as ApiClient
        const queryClient = createQueryClient()
        const sharedWrapper = wrapper(queryClient)

        const first = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-1',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })
        const second = renderHook(() => useCodexModels({
            api,
            sessionId: 'session-2',
            machineId: 'machine-1',
            enabled: true
        }), { wrapper: sharedWrapper })

        await waitFor(() => {
            expect(first.result.current.models[0]?.id).toBe('session-1')
            expect(second.result.current.models[0]?.id).toBe('session-2')
        })
        expect(getSessionCodexModels.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual([
            'session-1',
            'session-2'
        ])
    })
})
