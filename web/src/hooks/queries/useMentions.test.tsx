import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useMentions } from './useMentions'
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

describe('useMentions', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    it('uses fresh cached session mentions on mount without refetching the CLI', async () => {
        const queryClient = createQueryClient()
        queryClient.setQueryData(queryKeys.mentions('session-1'), {
            success: true,
            mentions: [
                {
                    name: 'files',
                    label: 'Files',
                    insertText: '@files',
                    description: 'cached mention list',
                    kind: 'plugin',
                    pluginName: 'filesystem',
                },
            ],
        })

        const api = {
            getMentions: vi.fn(async () => ({
                success: true,
                mentions: [
                    {
                        name: 'github',
                        label: 'GitHub',
                        insertText: '@github',
                        description: 'new mention list',
                        kind: 'app',
                        pluginName: 'github',
                    },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useMentions(api, 'session-1'), {
            wrapper: createWrapper(queryClient),
        })

        await waitFor(() => {
            expect(result.current.mentions.some((mention) => mention.name === 'files')).toBe(true)
        })
        expect(api.getMentions).not.toHaveBeenCalled()

        const suggestions = await result.current.getSuggestions('@fi')
        expect(suggestions.map((item) => item.label)).toEqual(['Files'])
    })

    it('can defer mention fetch until suggestions are requested', async () => {
        const queryClient = createQueryClient()
        const api = {
            getMentions: vi.fn(async () => ({
                success: true,
                mentions: [
                    {
                        name: 'github',
                        label: 'GitHub',
                        insertText: '@github',
                        description: 'GitHub connector',
                        kind: 'app',
                        pluginName: 'github',
                    },
                ],
            })),
        } as unknown as ApiClient

        const { result } = renderHook(() => useMentions(api, 'session-2', { enabled: false }), {
            wrapper: createWrapper(queryClient),
        })

        expect(api.getMentions).not.toHaveBeenCalled()

        const suggestions = await result.current.getSuggestions('@git')
        expect(api.getMentions).toHaveBeenCalledTimes(1)
        expect(suggestions.map((item) => item.label)).toEqual(['GitHub'])
    })
})
