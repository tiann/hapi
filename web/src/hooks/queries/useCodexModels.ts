import { useQuery } from '@tanstack/react-query'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import type { CodexAccountUsage } from '@hapi/protocol/apiTypes'

export function useCodexModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    machineId?: string | null
    enabled?: boolean
    sessionScoped?: boolean
}): {
    models: CodexModelSummary[]
    isLoading: boolean
    error: string | null
    usage: CodexAccountUsage | null
    refresh: () => void
} {
    const { api, sessionId, machineId } = args
    const enabled = Boolean(args.enabled && api && (sessionId || machineId))

    const machineQuery = useQuery({
        queryKey: queryKeys.machineCodexModels(machineId ?? 'unknown'),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (machineId) {
                return await api.getMachineCodexModels(machineId)
            }
            throw new Error('Codex models target unavailable')
        },
        enabled: Boolean(enabled && machineId && !args.sessionScoped),
        staleTime: 30_000,
        retry: false,
    })

    // Shared runtimes own their account/provider context and conditional Reserve
    // options. Keep those separate from machine discovery used by New Session.
    const useSessionFallback = Boolean(
        enabled
        && sessionId
        && (args.sessionScoped || !machineId || (
            machineQuery.error instanceof ApiError
            && machineQuery.error.code === RPC_TARGET_MISSING_ERROR_CODE
        ))
    )
    const sessionQuery = useQuery({
        queryKey: queryKeys.sessionCodexModels(sessionId ?? 'unknown'),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (sessionId) {
                return await api.getSessionCodexModels(sessionId)
            }
            throw new Error('Codex models fallback target unavailable')
        },
        enabled: useSessionFallback,
        staleTime: 30_000,
        retry: false,
    })
    const query = useSessionFallback ? sessionQuery : machineQuery

    return {
        models: query.data?.models ?? [],
        usage: query.data?.usage ?? null,
        refresh: () => { if (enabled) void query.refetch({ cancelRefetch: false }) },
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Codex models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Codex models'
                    : null,
    }
}
