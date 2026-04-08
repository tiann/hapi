import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useMachineSessionProfiles(api: ApiClient | null, machineId: string | null): {
    profiles: Array<{
        id: string
        label: string
        agent: 'codex'
        defaults: {
            model?: string
            modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
            permissionMode?: 'default' | 'read-only' | 'safe-yolo' | 'yolo'
            collaborationMode?: 'default' | 'plan'
            sessionType?: 'simple' | 'worktree'
        }
    }>
    defaults: { codexProfileId?: string | null }
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: machineId ? queryKeys.machineSessionProfiles(machineId) : ['machine-session-profiles', 'none'],
        queryFn: async () => {
            if (!api || !machineId) {
                throw new Error('Machine session profiles unavailable')
            }
            return await api.getMachineSessionProfiles(machineId)
        },
        enabled: Boolean(api && machineId)
    })

    return {
        profiles: query.data?.profiles ?? [],
        defaults: query.data?.defaults ?? { codexProfileId: null },
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load machine session profiles' : null,
        refetch: query.refetch
    }
}
