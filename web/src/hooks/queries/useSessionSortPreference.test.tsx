import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { useSessionSortPreference } from './useSessionSortPreference'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper(props: { children: ReactNode }) {
        return (
            <QueryClientProvider client={queryClient}>
                {props.children}
            </QueryClientProvider>
        )
    }
}

describe('useSessionSortPreference', () => {
    it('loads preference from API', async () => {
        const queryClient = new QueryClient()
        const api = {
            getSessionSortPreference: vi.fn(async () => ({
                preference: {
                    sortMode: 'manual',
                    manualOrder: {
                        groupOrder: ['group-a'],
                        sessionOrder: {
                            'group-a': ['session-1']
                        }
                    },
                    version: 3,
                    updatedAt: 123
                }
            }))
        }

        const { result } = renderHook(() => useSessionSortPreference(api as never), {
            wrapper: createWrapper(queryClient)
        })

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        expect(result.current.preference.sortMode).toBe('manual')
        expect(result.current.preference.version).toBe(3)
        expect(api.getSessionSortPreference).toHaveBeenCalledTimes(1)
    })

    it('returns defaults when API not available', () => {
        const queryClient = new QueryClient()

        const { result } = renderHook(() => useSessionSortPreference(null), {
            wrapper: createWrapper(queryClient)
        })

        expect(result.current.preference.sortMode).toBe('auto')
        expect(result.current.preference.manualOrder.groupOrder).toEqual([])
    })
})
