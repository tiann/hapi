import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ClaudeModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

const NO_MODELS: ClaudeModelSummary[] = []

/**
 * The models a machine's `claude` CLI offers. While loading, on failure, or on
 * a runner without discovery the list is empty and callers keep their
 * built-in presets, so a selection is never lost to a missing catalog.
 */
export function useClaudeModels(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): {
    availableModels: ClaudeModelSummary[]
} {
    const { api, machineId } = args
    const enabled = Boolean(args.enabled && api && machineId)

    const query = useQuery({
        queryKey: machineId
            ? queryKeys.machineClaudeModels(machineId)
            : ['machine-claude-models', 'unknown'] as const,
        queryFn: async () => {
            if (!api || !machineId) {
                throw new Error('Claude models target unavailable')
            }
            const response = await api.getMachineClaudeModels(machineId)
            // A failed probe arrives as success:false; as a query error it is
            // not cached as an answer, so the next picker to open asks again.
            if (!response.success) {
                throw new Error(response.error ?? 'Failed to load Claude models')
            }
            return response
        },
        enabled,
        staleTime: 60_000,
        retry: false,
    })

    return {
        // Gated on `enabled` too: the query key is per machine, so a catalog
        // cached by a Claude session would otherwise reach other agents' sessions.
        availableModels: enabled ? (query.data?.availableModels ?? NO_MODELS) : NO_MODELS,
    }
}
