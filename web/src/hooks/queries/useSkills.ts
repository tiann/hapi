import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SkillSummary } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'
import { searchSkills, skillSearchResultsToSuggestions } from '@/lib/skill-search'

export function useSkills(
    api: ApiClient | null,
    sessionId: string | null,
    enabled: boolean = true
): {
    skills: SkillSummary[]
    isLoading: boolean
    error: string | null
    refreshSkills: () => Promise<SkillSummary[]>
    getSuggestions: (query: string) => Promise<Suggestion[]>
} {
    const resolvedSessionId = sessionId ?? 'unknown'

    const query = useQuery({
        queryKey: queryKeys.skills(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSkills(sessionId)
        },
        enabled: Boolean(api && sessionId && enabled),
        staleTime: 0,
        gcTime: 30 * 60 * 1000,
        retry: false,
    })

    const skills = useMemo(() => {
        if (Array.isArray(query.data)) {
            return query.data
        }
        return []
    }, [query.data])

    const refetchSkills = query.refetch

    const refreshSkills = useCallback(async (): Promise<SkillSummary[]> => {
        if (!api || !sessionId || !enabled) {
            return []
        }

        return await refetchSkills({ throwOnError: false })
            .then((result) => Array.isArray(result.data) ? result.data : [])
            .catch(() => [])
    }, [api, sessionId, enabled, refetchSkills])

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        if (!api || !sessionId || !enabled) {
            return []
        }

        const loadedSkills = await refreshSkills()
        return skillSearchResultsToSuggestions(searchSkills(loadedSkills, queryText))
    }, [api, sessionId, enabled, refreshSkills])

    return {
        skills,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load skills' : null,
        refreshSkills,
        getSuggestions,
    }
}

export const useSessionSkills = useSkills
