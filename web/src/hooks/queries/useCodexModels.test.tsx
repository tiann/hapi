import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
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

describe('shared Codex session catalogs', () => {
    it('uses the live session account, excludes it from machine caches, and refreshes without polling', async () => {
        const getMachineCodexModels = vi.fn()
        const getSessionCodexModels = vi.fn(async (id: string) => ({ success: true, models: [
            { id: id === 'eligible' ? 'gpt-reserve' : 'gpt-6-astra', displayName: id, isDefault: false }
        ] }))
        const api = { getMachineCodexModels, getSessionCodexModels } as unknown as ApiClient
        const queryClient = createQueryClient()
        const sharedWrapper = wrapper(queryClient)
        const first = renderHook(() => useCodexModels({ api, sessionId: 'eligible', machineId: 'm', enabled: true, sessionScoped: true }), { wrapper: sharedWrapper })
        const second = renderHook(() => useCodexModels({ api, sessionId: 'ordinary', machineId: 'm', enabled: true, sessionScoped: true }), { wrapper: sharedWrapper })
        await waitFor(() => expect(first.result.current.models[0]?.id).toBe('gpt-reserve'))
        await waitFor(() => expect(second.result.current.models[0]?.id).toBe('gpt-6-astra'))
        expect(getMachineCodexModels).not.toHaveBeenCalled()
        first.result.current.refresh()
        await waitFor(() => expect(getSessionCodexModels).toHaveBeenCalledTimes(3))
    })
})
