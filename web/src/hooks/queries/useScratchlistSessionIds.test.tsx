import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useScratchlistSessionIds } from './useScratchlistSessionIds'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
}

describe('useScratchlistSessionIds', () => {
    it('loads a namespaced batch of session ids when enabled', async () => {
        const getScratchlistSessionIds = vi.fn().mockResolvedValue(['session-a', 'session-c'])
        const api = { getScratchlistSessionIds } as unknown as ApiClient

        const { result } = renderHook(() => useScratchlistSessionIds(api, true), {
            wrapper: createWrapper()
        })

        await waitFor(() => expect(result.current.sessionIds).toEqual(new Set(['session-a', 'session-c'])))
        expect(getScratchlistSessionIds).toHaveBeenCalledTimes(1)
        expect(result.current.error).toBeNull()
    })

    it('does not request status while the filter is disabled', async () => {
        const getScratchlistSessionIds = vi.fn()
        const api = { getScratchlistSessionIds } as unknown as ApiClient

        const { result } = renderHook(() => useScratchlistSessionIds(api, false), {
            wrapper: createWrapper()
        })

        expect(result.current.sessionIds).toEqual(new Set())
        expect(result.current.isLoading).toBe(false)
        expect(getScratchlistSessionIds).not.toHaveBeenCalled()
    })
})
