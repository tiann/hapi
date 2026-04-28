import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useCodexModels } from './useCodexModels'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useCodexModels', () => {
    it('hides cached errors when disabled', async () => {
        const api = {
            getSessionCodexModels: async () => {
                throw new Error('HTTP 409 Conflict: {"error":"Session is inactive"}')
            },
        } as unknown as ApiClient

        const { result, rerender } = renderHook(
            ({ enabled }) => useCodexModels({
                api,
                sessionId: 'session-1',
                enabled,
            }),
            {
                wrapper: createWrapper(),
                initialProps: { enabled: true },
            }
        )

        await waitFor(() => {
            expect(result.current.error).toContain('Session is inactive')
        })

        rerender({ enabled: false })

        expect(result.current.error).toBeNull()
        expect(result.current.isLoading).toBe(false)
    })
})
