import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CodexSubscriptionLimits } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCodexSubscriptionLimits(args: {
    api: ApiClient | null
    sessionId?: string | null
    model?: string | null
    enabled?: boolean
    thinking?: boolean
}): {
    limits: CodexSubscriptionLimits | null
    isLoading: boolean
    isFetching: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const model = args.model ?? null
    const thinking = args.thinking === true
    const enabled = Boolean(args.enabled && api && sessionId)
    const query = useQuery({
        queryKey: queryKeys.sessionCodexSubscriptionLimits(sessionId ?? 'unknown', model),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('API unavailable')
            }
            return await api.getSessionCodexSubscriptionLimits(sessionId)
        },
        enabled,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
        retry: false
    })

    const prevThinkingRef = useRef(thinking)
    useEffect(() => {
        prevThinkingRef.current = thinking
    }, [sessionId, model])

    useEffect(() => {
        if (enabled && prevThinkingRef.current && !thinking) {
            void query.refetch()
        }
        prevThinkingRef.current = thinking
    }, [enabled, thinking, query, sessionId, model])

    return {
        limits: query.data?.limits ?? null,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to read Codex subscription limits')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to read Codex subscription limits'
                    : null
    }
}
