import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CodexSessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCodexSessions(args: {
    api: ApiClient | null
    machineId?: string | null
    includeOld?: boolean
    enabled?: boolean
}): {
    sessions: CodexSessionSummary[]
    isLoading: boolean
    error: string | null
} {
    const { api, machineId } = args
    const includeOld = args.includeOld === true
    const enabled = Boolean(args.enabled && api && machineId)

    const query = useQuery({
        queryKey: queryKeys.machineCodexSessions(machineId ?? 'unknown', includeOld),
        queryFn: async () => {
            if (!api || !machineId) {
                throw new Error('Codex sessions target unavailable')
            }
            return await api.getMachineCodexSessions(machineId, {
                includeOld,
                olderThanDays: 180,
                limit: 200
            })
        },
        enabled,
        staleTime: 30_000,
        retry: false,
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Codex sessions')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Codex sessions'
                    : null,
    }
}
