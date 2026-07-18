import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { MentionSummary } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'

export function useMentions(
    api: ApiClient | null,
    sessionId: string | null,
    options?: { enabled?: boolean }
): {
    mentions: MentionSummary[]
    isLoading: boolean
    error: string | null
    getSuggestions: (query: string) => Promise<Suggestion[]>
    suggestionsVersion: number
} {
    const resolvedSessionId = sessionId ?? 'unknown'

    const query = useQuery({
        queryKey: queryKeys.mentions(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getMentions(sessionId)
        },
        enabled: Boolean(api && sessionId) && (options?.enabled ?? true),
        staleTime: 30_000,
        gcTime: 30 * 60 * 1000,
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: false,
    })

    const mentions = useMemo(() => {
        if (query.data?.success && query.data.mentions) {
            return query.data.mentions
        }
        return []
    }, [query.data])

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        const searchTerm = queryText.startsWith('@')
            ? queryText.slice(1).toLowerCase()
            : queryText.toLowerCase()

        let currentMentions = mentions
        if (api && sessionId && !query.isFetching && (!query.data || query.isStale)) {
            const refreshed = await query.refetch()
            if (refreshed.data?.success && refreshed.data.mentions) {
                currentMentions = refreshed.data.mentions
            }
        }

        return currentMentions
            .filter((mention) => !searchTerm || mention.name.toLowerCase().includes(searchTerm))
            .map((mention) => ({
                key: `@${mention.name}`,
                text: mention.insertText,
                label: mention.label,
                description: mention.description,
                source: 'plugin' as const,
            }))
    }, [api, mentions, query, sessionId])

    return {
        mentions,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load mentions' : null,
        getSuggestions,
        suggestionsVersion: query.dataUpdatedAt,
    }
}
