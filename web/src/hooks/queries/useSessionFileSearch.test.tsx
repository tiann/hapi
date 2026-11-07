import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { FileSearchResponse } from '@/types/api'
import {
    SESSION_FILE_SEARCH_DEBOUNCE_MS,
    useSessionFileSearch,
} from './useSessionFileSearch'

type PendingRequest = {
    query: string
    signal: AbortSignal | undefined
    resolve: (response: FileSearchResponse) => void
}

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useSessionFileSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('debounces changed queries and aborts the previous request', async () => {
        const pending: PendingRequest[] = []
        const api = {
            searchSessionFiles: vi.fn((_sessionId: string, query: string, _limit?: number, signal?: AbortSignal) => (
                new Promise<FileSearchResponse>((resolve) => {
                    pending.push({ query, signal, resolve })
                })
            ))
        } as unknown as ApiClient
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        })
        const rendered = renderHook(
            ({ query }) => useSessionFileSearch(api, 'session-1', query, { enabled: true }),
            {
                initialProps: { query: 'src' },
                wrapper: createWrapper(queryClient),
            },
        )

        await act(async () => {
            await Promise.resolve()
        })
        expect(pending.map((request) => request.query)).toEqual(['src'])

        await act(async () => {
            rendered.rerender({ query: 'src/components' })
            await Promise.resolve()
        })
        expect(pending[0]?.signal?.aborted).toBe(true)
        expect(pending).toHaveLength(1)
        expect(rendered.result.current.isLoading).toBe(true)

        await act(async () => {
            vi.advanceTimersByTime(SESSION_FILE_SEARCH_DEBOUNCE_MS - 1)
            await Promise.resolve()
        })
        expect(pending).toHaveLength(1)

        await act(async () => {
            vi.advanceTimersByTime(1)
            await Promise.resolve()
            await Promise.resolve()
        })
        expect(pending.map((request) => request.query)).toEqual(['src', 'src/components'])
        expect(pending[1]?.signal?.aborted).toBe(false)

        pending[0]?.resolve({ success: true, files: [] })
        pending[1]?.resolve({ success: true, files: [] })
        await act(async () => {
            await Promise.resolve()
        })
        rendered.unmount()
    })

    it('aborts an in-flight request immediately when search is cleared', async () => {
        const pending: PendingRequest[] = []
        const api = {
            searchSessionFiles: vi.fn((_sessionId: string, query: string, _limit?: number, signal?: AbortSignal) => (
                new Promise<FileSearchResponse>((resolve) => {
                    pending.push({ query, signal, resolve })
                })
            ))
        } as unknown as ApiClient
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        })
        const rendered = renderHook(
            ({ query }) => useSessionFileSearch(api, 'session-1', query, { enabled: Boolean(query) }),
            {
                initialProps: { query: 'src' },
                wrapper: createWrapper(queryClient),
            },
        )

        await act(async () => {
            await Promise.resolve()
            rendered.rerender({ query: '' })
            await Promise.resolve()
        })

        expect(pending).toHaveLength(1)
        expect(pending[0]?.signal?.aborted).toBe(true)
        expect(rendered.result.current.isLoading).toBe(false)

        pending[0]?.resolve({ success: true, files: [] })
        rendered.unmount()
    })
})
