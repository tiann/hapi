import { useQuery } from '@tanstack/react-query'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCodexModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    machineId?: string | null
    preferSession?: boolean
    enabled?: boolean
}): {
    models: CodexModelSummary[]
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId, machineId } = args
    const enabled = Boolean(args.enabled && api && (sessionId || machineId))
    const preferSession = Boolean(enabled && args.preferSession && sessionId)

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
        enabled: Boolean(enabled && machineId && !preferSession),
        staleTime: 30_000,
        retry: false,
    })

    // Legacy sessions use the shared machine catalog. A shared session uses
    // its live app-server; only missing RPC targets need the other route.
    const useLegacySessionFallback = Boolean(
        enabled
        && sessionId
        && !preferSession
        && (!machineId || (
            machineQuery.error instanceof ApiError
            && machineQuery.error.code === RPC_TARGET_MISSING_ERROR_CODE
        ))
    )
    const sessionQuery = useQuery({
        queryKey: queryKeys.sessionCodexModels(sessionId ?? 'unknown'),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('API unavailable')
            }
            try {
                return await api.getSessionCodexModels(sessionId)
            } catch (error) {
                if (preferSession && machineId && error instanceof ApiError
                    && error.code === RPC_TARGET_MISSING_ERROR_CODE) {
                    return await api.getMachineCodexModels(machineId)
                }
                throw error
            }
        },
        enabled: Boolean(preferSession || useLegacySessionFallback),
        staleTime: 30_000,
        retry: false,
    })
    const query = preferSession || useLegacySessionFallback ? sessionQuery : machineQuery

    return {
        models: query.data?.models ?? [],
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
