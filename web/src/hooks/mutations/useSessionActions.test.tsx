import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSessionActions } from './useSessionActions'
import { ApiError, type ApiClient } from '@/api/client'

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createMockApi(reopenSession: (sessionId: string) => Promise<{ ok: true; sessionId: string; resumed: boolean }>): ApiClient {
    return { reopenSession } as unknown as ApiClient
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('useSessionActions - reopenSession', () => {
    it('invokes api.reopenSession with the session id and forwards the response', async () => {
        const reopen = vi.fn(async (_sessionId: string) => ({
            ok: true as const,
            sessionId: 'session-A-spawned',
            resumed: true
        }))
        const api = createMockApi(reopen)

        const { result } = renderHook(
            () => useSessionActions(api, 'session-A', 'cursor'),
            { wrapper: createWrapper() },
        )

        let response: { ok: true; sessionId: string; resumed: boolean } | undefined
        await act(async () => {
            response = await result.current.reopenSession()
        })

        expect(reopen).toHaveBeenCalledWith('session-A')
        // The mutation must propagate the response so the UI can navigate to the
        // possibly-new spawn id when resumeSession merges the row.
        expect(response).toEqual({ ok: true, sessionId: 'session-A-spawned', resumed: true })
    })

    it('throws when api or sessionId is missing', async () => {
        const { result } = renderHook(
            () => useSessionActions(null, null, null),
            { wrapper: createWrapper() },
        )

        await expect(result.current.reopenSession()).rejects.toThrow('Session unavailable')
    })

    it('surfaces an ApiError so the UI can render the 422 missing-metadata payload', async () => {
        const reopen = vi.fn(async () => {
            throw new ApiError(
                'HTTP 422 Unprocessable Entity: {"error":"Cursor session id is missing from metadata; reopen requires the original cursor chat id","missing":["cursorSessionId"]}',
                422,
                'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                '{"error":"Cursor session id is missing from metadata; reopen requires the original cursor chat id","missing":["cursorSessionId"]}'
            )
        })
        const api = createMockApi(reopen as unknown as ApiClient['reopenSession'])

        const { result } = renderHook(
            () => useSessionActions(api, 'session-X', 'cursor'),
            { wrapper: createWrapper() },
        )

        let captured: unknown
        await act(async () => {
            try {
                await result.current.reopenSession()
            } catch (error) {
                captured = error
            }
        })

        expect(captured).toBeInstanceOf(ApiError)
        const apiError = captured as ApiError
        expect(apiError.status).toBe(422)
        expect(apiError.body).toContain('cursorSessionId')

        await waitFor(() => {
            // The hook should not get stuck pending after the failure.
            expect(result.current.isPending).toBe(false)
        })
    })
})
