import { queryOptions, useQuery } from '@tanstack/react-query'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const SESSION_CATALOG_STARTUP_POLLS = 5

function isMissingRpc(error: unknown): boolean {
    return error instanceof ApiError && error.code === RPC_TARGET_MISSING_ERROR_CODE
}

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

    const sessionOptions = queryOptions({
        queryKey: queryKeys.sessionCodexModels(sessionId ?? 'unknown', sessionRuntimeGeneration),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('API unavailable')
            }
            return { ...await api.getSessionCodexModels(sessionId), catalogSource: 'session' as const }
        },
        staleTime: 30_000,
        retry: false,
    })
    const sharedSessionQuery = useQuery({
        ...sessionOptions,
        enabled: preferSession,
        // RPC registration can take a while. Keep checking in the foreground
        // independently of the machine request, and back off after startup.
        refetchInterval: query => {
            const { error, errorUpdateCount } = query.state
            if (!preferSession || !isMissingRpc(error)) return false
            return errorUpdateCount < SESSION_CATALOG_STARTUP_POLLS ? 2_000 : 15_000
        },
    })
    const useMachineFallback = preferSession && Boolean(machineId) && isMissingRpc(sharedSessionQuery.error)
    const machineQuery = useQuery({
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
        enabled: Boolean(enabled && machineId && (!preferSession || useMachineFallback)),
        staleTime: 30_000,
        retry: false,
    })

    // Legacy sessions start with machine discovery and can use the session
    // route when older runners do not expose a machine RPC.
    const useLegacySessionFallback = Boolean(
        enabled
        && sessionId
        && !preferSession
        && (!machineId || isMissingRpc(machineQuery.error))
    )
    const legacySessionQuery = useQuery({ ...sessionOptions, enabled: useLegacySessionFallback })
    const query = preferSession && !useMachineFallback ? sharedSessionQuery
        : useLegacySessionFallback ? legacySessionQuery : machineQuery

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
