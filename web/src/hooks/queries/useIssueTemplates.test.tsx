import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useIssueTemplates } from './useIssueTemplates'
import type { ApiClient } from '@/api/client'
import type { GetIssueTemplatesResponse } from '@/types/api'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useIssueTemplates', () => {
    it('does not fetch when disabled, even with a repo and boardId set', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const getIssueTemplates = vi.fn()
        const api = { getIssueTemplates } as unknown as ApiClient

        renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', false), { wrapper: createWrapper(queryClient) })

        expect(getIssueTemplates).not.toHaveBeenCalled()
    })

    it('does not fetch when enabled but repo is null', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const getIssueTemplates = vi.fn()
        const api = { getIssueTemplates } as unknown as ApiClient

        renderHook(() => useIssueTemplates(api, 'board-1', null, true), { wrapper: createWrapper(queryClient) })

        expect(getIssueTemplates).not.toHaveBeenCalled()
    })

    it('fetches when enabled with both boardId and repo, and surfaces the response', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const response: GetIssueTemplatesResponse = {
            templates: [{ id: 'bug_report.yml', name: 'Bug report', kind: 'form', fields: [], labels: [], assignees: [] }],
            blankAllowed: true,
            githubNewIssueUrl: 'https://github.com/heavygee/hapi/issues/new/choose'
        }
        const getIssueTemplates = vi.fn().mockResolvedValue(response)
        const api = { getIssueTemplates } as unknown as ApiClient

        const { result } = renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', true), { wrapper: createWrapper(queryClient) })

        await waitFor(() => expect(result.current.isLoading).toBe(false))

        expect(getIssueTemplates).toHaveBeenCalledWith('board-1', 'heavygee/hapi')
        expect(result.current.templates).toEqual(response.templates)
        expect(result.current.blankAllowed).toBe(true)
        expect(result.current.githubNewIssueUrl).toBe(response.githubNewIssueUrl)
        expect(result.current.error).toBeNull()
    })

    it('defaults blankAllowed to true and templates to empty before data arrives', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const api = { getIssueTemplates: vi.fn(() => new Promise(() => {})) } as unknown as ApiClient

        const { result } = renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', true), { wrapper: createWrapper(queryClient) })

        expect(result.current.templates).toEqual([])
        expect(result.current.blankAllowed).toBe(true)
        expect(result.current.githubNewIssueUrl).toBeNull()
        expect(result.current.isLoading).toBe(true)
    })

    it('reports isLoading true on a warm-cache reopen while the live refetch is still in flight (review finding)', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const githubNewIssueUrl = 'https://github.com/heavygee/hapi/issues/new/choose'
        const staleResponse: GetIssueTemplatesResponse = { templates: [], blankAllowed: false, githubNewIssueUrl }
        const freshResponse: GetIssueTemplatesResponse = { templates: [], blankAllowed: true, githubNewIssueUrl }
        let resolveSecondFetch: (value: GetIssueTemplatesResponse) => void = () => {}
        const getIssueTemplates = vi.fn()
            .mockResolvedValueOnce(staleResponse)
            .mockImplementationOnce(() => new Promise(resolve => { resolveSecondFetch = resolve }))
        const api = { getIssueTemplates } as unknown as ApiClient

        // First open — populates the cache for this exact boardId+repo key.
        const first = renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', true), { wrapper: createWrapper(queryClient) })
        await waitFor(() => expect(first.result.current.isLoading).toBe(false))
        expect(first.result.current.blankAllowed).toBe(false)
        first.unmount()

        // Reopen with the same board+repo — a cache hit, so the stale value
        // is available immediately, but a live refetch is still in flight.
        const second = renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', true), { wrapper: createWrapper(queryClient) })
        expect(second.result.current.blankAllowed).toBe(false)
        expect(second.result.current.isLoading).toBe(true)

        resolveSecondFetch(freshResponse)
        await waitFor(() => expect(second.result.current.blankAllowed).toBe(true))
        expect(second.result.current.isLoading).toBe(false)
    })

    it('still fetches on reopen within the app\'s 5s global staleTime window, not just once that window has passed (review finding, second pass)', async () => {
        // Matches the app's real default (web/src/lib/query-client.ts) —
        // the test above used a bare QueryClient with no staleTime override,
        // which never exercises this at all: vanilla React Query's own
        // staleTime defaults to 0, so that test's "reopen" would have
        // refetched even without this hook's own staleTime/refetchOnMount
        // override (review finding: the prior regression missed this case).
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } })
        const githubNewIssueUrl = 'https://github.com/heavygee/hapi/issues/new/choose'
        const firstResponse: GetIssueTemplatesResponse = { templates: [], blankAllowed: false, githubNewIssueUrl }
        const secondResponse: GetIssueTemplatesResponse = { templates: [], blankAllowed: true, githubNewIssueUrl }
        const getIssueTemplates = vi.fn()
            .mockResolvedValueOnce(firstResponse)
            .mockResolvedValueOnce(secondResponse)
        const api = { getIssueTemplates } as unknown as ApiClient

        const first = renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', true), { wrapper: createWrapper(queryClient) })
        await waitFor(() => expect(first.result.current.isLoading).toBe(false))
        first.unmount()

        // Reopen immediately — well inside the 5s staleTime window. Without
        // this hook's own staleTime: 0 override, React Query would see
        // "fresh" cached data and skip the fetch entirely.
        const second = renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', true), { wrapper: createWrapper(queryClient) })
        await waitFor(() => expect(getIssueTemplates).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(second.result.current.blankAllowed).toBe(true))
    })

    it('surfaces a thrown error message', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const api = { getIssueTemplates: vi.fn().mockRejectedValue(new Error('rate limited')) } as unknown as ApiClient

        const { result } = renderHook(() => useIssueTemplates(api, 'board-1', 'heavygee/hapi', true), { wrapper: createWrapper(queryClient) })

        await waitFor(() => expect(result.current.error).toBe('rate limited'))
    })
})
