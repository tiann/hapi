import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'

import { useSessionSortPreferenceMutation } from './useSessionSortPreference'
import { queryKeys } from '@/lib/query-keys'
import type { SessionSortPreferenceResponse } from '@/types/api'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper(props: { children: ReactNode }) {
        return (
            <QueryClientProvider client={queryClient}>
                {props.children}
            </QueryClientProvider>
        )
    }
}

describe('useSessionSortPreferenceMutation', () => {
    it('updates cache optimistically on mutate', async () => {
        const queryClient = new QueryClient()
        const serverPreference = {
            sortMode: 'manual' as const,
            manualOrder: { groupOrder: ['g1'], sessionOrder: { g1: ['s1'] } },
            version: 3,
            updatedAt: 999
        }
        const api = {
            setSessionSortPreference: vi.fn(async () => ({
                status: 'success' as const,
                preference: serverPreference
            }))
        }

        queryClient.setQueryData<SessionSortPreferenceResponse>(
            queryKeys.sessionSortPreference,
            {
                preference: {
                    sortMode: 'auto',
                    manualOrder: { groupOrder: [], sessionOrder: {} },
                    version: 2,
                    updatedAt: 100
                }
            }
        )

        const { result } = renderHook(() => useSessionSortPreferenceMutation(api as never), {
            wrapper: createWrapper(queryClient)
        })

        await act(async () => {
            await result.current.setSessionSortPreference({
                sortMode: 'manual',
                manualOrder: { groupOrder: ['g1'], sessionOrder: { g1: ['s1'] } },
                expectedVersion: 2
            })
        })

        const cached = queryClient.getQueryData<SessionSortPreferenceResponse>(queryKeys.sessionSortPreference)
        expect(cached?.preference.sortMode).toBe('manual')
        expect(cached?.preference.version).toBe(3)
    })

    it('rolls back cache on error', async () => {
        const queryClient = new QueryClient()
        const api = {
            setSessionSortPreference: vi.fn(async () => {
                throw new Error('Network error')
            })
        }

        queryClient.setQueryData<SessionSortPreferenceResponse>(
            queryKeys.sessionSortPreference,
            {
                preference: {
                    sortMode: 'auto',
                    manualOrder: { groupOrder: [], sessionOrder: {} },
                    version: 1,
                    updatedAt: 100
                }
            }
        )

        const { result } = renderHook(() => useSessionSortPreferenceMutation(api as never), {
            wrapper: createWrapper(queryClient)
        })

        await act(async () => {
            try {
                await result.current.setSessionSortPreference({
                    sortMode: 'manual',
                    manualOrder: { groupOrder: ['g1'], sessionOrder: {} },
                    expectedVersion: 1
                })
            } catch {
                // expected
            }
        })

        await waitFor(() => {
            const cached = queryClient.getQueryData<SessionSortPreferenceResponse>(queryKeys.sessionSortPreference)
            expect(cached?.preference.sortMode).toBe('auto')
            expect(cached?.preference.version).toBe(1)
        })
    })

    it('throws when API is not available', async () => {
        const queryClient = new QueryClient()

        const { result } = renderHook(() => useSessionSortPreferenceMutation(null), {
            wrapper: createWrapper(queryClient)
        })

        await expect(
            act(async () => {
                await result.current.setSessionSortPreference({
                    sortMode: 'manual',
                    manualOrder: { groupOrder: [], sessionOrder: {} }
                })
            })
        ).rejects.toThrow('API unavailable')
    })
})
