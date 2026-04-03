import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ExternalSessionActionResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useImportableSessionActions(api: ApiClient | null, agent: 'codex'): {
    importSession: (externalSessionId: string) => Promise<ExternalSessionActionResponse>
    refreshSession: (externalSessionId: string) => Promise<ExternalSessionActionResponse>
    importingSessionId: string | null
    refreshingSessionId: string | null
    error: string | null
} {
    const queryClient = useQueryClient()

    const invalidate = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            queryClient.invalidateQueries({ queryKey: queryKeys.importableSessions(agent) }),
        ])
    }

    const importMutation = useMutation({
        mutationFn: async (externalSessionId: string) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.importExternalSession(agent, externalSessionId)
        },
        onSuccess: invalidate,
    })

    const refreshMutation = useMutation({
        mutationFn: async (externalSessionId: string) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.refreshExternalSession(agent, externalSessionId)
        },
        onSuccess: invalidate,
    })

    return {
        importSession: importMutation.mutateAsync,
        refreshSession: refreshMutation.mutateAsync,
        importingSessionId: importMutation.isPending ? importMutation.variables ?? null : null,
        refreshingSessionId: refreshMutation.isPending ? refreshMutation.variables ?? null : null,
        error: importMutation.error instanceof Error
            ? importMutation.error.message
            : refreshMutation.error instanceof Error
                ? refreshMutation.error.message
                : importMutation.error || refreshMutation.error
                    ? 'Failed to update importable session'
                    : null,
    }
}
