import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { FileSearchItem } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export const SESSION_FILE_SEARCH_DEBOUNCE_MS = 300

function useDebouncedValue(value: string, delayMs: number): string {
    const [debouncedValue, setDebouncedValue] = useState(value)

    useEffect(() => {
        if (value === debouncedValue) return
        const timer = window.setTimeout(() => setDebouncedValue(value), delayMs)
        return () => window.clearTimeout(timer)
    }, [debouncedValue, delayMs, value])

    return debouncedValue
}

export function useSessionFileSearch(
    api: ApiClient | null,
    sessionId: string | null,
    query: string,
    options?: { limit?: number; enabled?: boolean }
): {
    files: FileSearchItem[]
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const limit = options?.limit ?? 200
    const enabled = options?.enabled ?? Boolean(api && sessionId)
    const debouncedQuery = useDebouncedValue(query, SESSION_FILE_SEARCH_DEBOUNCE_MS)
    const querySettled = query === debouncedQuery

    const result = useQuery({
        // Keep the raw query in the key so React Query aborts the previous
        // request immediately; gate the new key until the 300ms debounce ends.
        queryKey: queryKeys.sessionFiles(resolvedSessionId, query),
        queryFn: async ({ signal }) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const response = await api.searchSessionFiles(sessionId, query, limit, signal)
            if (!response.success) {
                return { files: [], error: response.error ?? 'Failed to search files' }
            }
            return { files: response.files ?? [], error: null }
        },
        enabled: enabled && querySettled,
    })

    const queryError = result.error instanceof Error
        ? result.error.message
        : result.error
            ? 'Failed to search files'
            : null

    return {
        files: result.data?.files ?? [],
        error: queryError ?? result.data?.error ?? null,
        isLoading: result.isLoading || (enabled && !querySettled),
        refetch: result.refetch
    }
}
