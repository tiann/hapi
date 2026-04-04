import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ExternalSessionActionResponse, ImportableSessionAgent } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { fetchLatestMessages } from '@/lib/message-window-store'

export function useImportableSessionActions(api: ApiClient | null, agent: ImportableSessionAgent): {
    importSession: (externalSessionId: string) => Promise<ExternalSessionActionResponse>
    reimportSession: (externalSessionId: string) => Promise<ExternalSessionActionResponse>
    importingSessionId: string | null
    reimportingSessionId: string | null
    error: string | null
} {
    const queryClient = useQueryClient()

    const invalidate = async (result?: ExternalSessionActionResponse) => {
        const tasks: Array<Promise<unknown>> = [
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            queryClient.invalidateQueries({ queryKey: queryKeys.importableSessions(agent) }),
        ]

        if (result?.sessionId) {
            tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.session(result.sessionId) }))
            if (api) {
                tasks.push(fetchLatestMessages(api, result.sessionId))
            }
        }

        await Promise.all(tasks)
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

    const reimportMutation = useMutation({
        mutationFn: async (externalSessionId: string) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.refreshExternalSession(agent, externalSessionId)
        },
        onSuccess: invalidate,
    })

    useEffect(() => {
        importMutation.reset()
        reimportMutation.reset()
    }, [agent])

    return {
        importSession: importMutation.mutateAsync,
        reimportSession: reimportMutation.mutateAsync,
        importingSessionId: importMutation.isPending ? importMutation.variables ?? null : null,
        reimportingSessionId: reimportMutation.isPending ? reimportMutation.variables ?? null : null,
        error: importMutation.error instanceof Error
            ? importMutation.error.message
            : reimportMutation.error instanceof Error
                ? reimportMutation.error.message
                : importMutation.error || reimportMutation.error
                    ? 'Failed to update importable session'
                    : null,
    }
}
