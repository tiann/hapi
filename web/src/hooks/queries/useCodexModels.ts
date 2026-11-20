import { queryOptions, useQuery } from '@tanstack/react-query'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const SESSION_CATALOG_STARTUP_POLLS = 10

export function useCodexModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    sessionRuntimeGeneration?: string
    machineId?: string | null
    preferSession?: boolean
    enabled?: boolean
}): {
    catalogSource: 'session' | 'machine' | null
    models: CodexModelSummary[]
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId, sessionRuntimeGeneration, machineId } = args
    const enabled = Boolean(args.enabled && api && (sessionId || machineId))
    const preferSession = Boolean(enabled && args.preferSession && sessionId)

    const machineOptions = queryOptions({
        queryKey: queryKeys.machineCodexModels(machineId ?? 'unknown'),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (machineId) {
                return { ...await api.getMachineCodexModels(machineId), catalogSource: 'machine' as const }
            }
            throw new Error('Codex models target unavailable')
        },
        staleTime: 30_000,
        retry: false,
    })
    const machineQuery = useQuery({ ...machineOptions, enabled: Boolean(enabled && machineId && !preferSession) })

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
        queryKey: queryKeys.sessionCodexModels(sessionId ?? 'unknown', sessionRuntimeGeneration),
        queryFn: async ({ client }) => {
            if (!api || !sessionId) {
                throw new Error('API unavailable')
            }
            try {
                return { ...await api.getSessionCodexModels(sessionId), catalogSource: 'session' as const }
            } catch (error) {
                if (preferSession && machineId && error instanceof ApiError
                    && error.code === RPC_TARGET_MISSING_ERROR_CODE) {
                    return await client.fetchQuery(machineOptions)
                }
                throw error
            }
        },
        enabled: Boolean(preferSession || useLegacySessionFallback),
        staleTime: query => query.state.data?.catalogSource === 'machine' ? 0 : 30_000,
        retry: false,
        // During startup the runner can be online before the session registers
        // its RPC. Keep the provisional machine catalog visible while it does.
        refetchInterval: query => preferSession && query.state.data?.catalogSource === 'machine'
            && query.state.dataUpdateCount < SESSION_CATALOG_STARTUP_POLLS ? 1_000 : false,
    })
    const query = preferSession || useLegacySessionFallback ? sessionQuery : machineQuery

    return {
        catalogSource: query.data?.catalogSource ?? null,
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
