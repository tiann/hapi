import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSkills } from './useSkills'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    })
}

describe('useSkills', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    it('uses fresh cached session skills on mount without refetching the CLI', async () => {
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.skills('session-1'), {
            success: true,
            skills: [
                { name: 'cached-skill', description: 'fresh cached skill list' },
            ],
        })

        const api = {
            getSkills: vi.fn(async () => ({
                success: true,
                skills: [
                    { name: 'playwright', description: 'old cached skill list' },
                    { name: 'superpowers:using-superpowers', description: 'new plugin skill' },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSkills(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(result.current.skills.some((skill) => skill.name === 'cached-skill')).toBe(true)
        })
        expect(api.getSkills).not.toHaveBeenCalled()
    })

    it('shows the full skill catalog in stable alphabetical order for bare $ suggestions', async () => {
        localStorage.setItem('hapi-recent-skills', JSON.stringify({
            playwright: Date.now(),
            sora: Date.now() - 1_000,
            doc: Date.now() - 2_000,
        }))

        const queryClient = createQueryClient()
        const api = {
            getSkills: vi.fn(async () => ({
                success: true,
                skills: [
                    { name: 'playwright', description: 'recent local skill' },
                    { name: 'superpowers:using-superpowers', description: 'plugin skill' },
                    { name: 'browser-use:browser', description: 'plugin browser skill' },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSkills(api, 'session-2'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(result.current.skills).toHaveLength(3)
        })

        const suggestions = await result.current.getSuggestions('$')
        expect(suggestions.map((item) => item.label)).toEqual([
            '$browser-use:browser',
            '$playwright',
            '$superpowers:using-superpowers',
        ])
    })

    it('can defer initial skill fetch until suggestions are requested', async () => {
        const queryClient = createQueryClient()
        const api = {
            getSkills: vi.fn(async () => ({
                success: true,
                skills: [
                    { name: 'playwright', description: 'browser automation' },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useSkills(api, 'session-3', { enabled: false }), {
            wrapper: createWrapper(queryClient),
        })

        expect(api.getSkills).not.toHaveBeenCalled()

        const suggestions = await result.current.getSuggestions('$play')
        expect(api.getSkills).toHaveBeenCalledTimes(1)
        expect(suggestions.map((item) => item.label)).toEqual(['$playwright'])
    })
})
