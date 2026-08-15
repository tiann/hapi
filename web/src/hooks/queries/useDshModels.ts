import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DshModelSelection, DshModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useDshModels(args: {
    api: ApiClient | null
    machineId?: string | null
    sessionId?: string | null
    enabled?: boolean
}): {
    availableModels: DshModelSummary[]
    current: DshModelSelection | null
    isLoading: boolean
    error: string | null
    refetch: () => Promise<void>
} {
    const enabled = Boolean(args.enabled && args.api && (args.sessionId || args.machineId))
    const target = args.sessionId
        ? { kind: 'session' as const, id: args.sessionId }
        : args.machineId
            ? { kind: 'machine' as const, id: args.machineId }
            : null

    const query = useQuery({
        queryKey: target?.kind === 'session'
            ? queryKeys.sessionDshModels(target.id)
            : target?.kind === 'machine'
                ? queryKeys.machineDshModels(target.id)
                : ['dsh-models', 'unknown'] as const,
        queryFn: async () => {
            if (!args.api || !target) throw new Error('DeepSeek Harness models target unavailable')
            return target.kind === 'session'
                ? await args.api.getSessionDshModels(target.id)
                : await args.api.getMachineDshModels(target.id)
        },
        enabled,
        staleTime: 30_000,
        retry: false
    })

    return {
        availableModels: query.data?.availableModels ?? [],
        current: query.data?.current ?? null,
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load DeepSeek Harness models')
            : query.error instanceof Error
                ? query.error.message
                : null,
        refetch: async () => {
            await query.refetch()
        }
    }
}
