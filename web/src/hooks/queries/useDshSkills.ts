import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DshSkillsResponse } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'

export function useDshSkills(args: {
    api: ApiClient | null
    sessionId?: string | null
    enabled?: boolean
}): {
    skills: DshSkillsResponse['skills']
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId } = args
    const enabled = Boolean(args.enabled && api && sessionId)

    const query = useQuery({
        queryKey: sessionId
            ? queryKeys.sessionDshSkills(sessionId)
            : ['session-dsh-skills', 'unknown'] as const,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!sessionId) {
                throw new Error('DSH skills target unavailable')
            }
            return await api.dshSkills(sessionId)
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        skills: query.data?.skills ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : (query.error ?? null),
    }
}
