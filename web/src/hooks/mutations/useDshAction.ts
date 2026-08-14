import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DshAction } from '@hapi/protocol'
import { queryKeys } from '@/lib/query-keys'

/**
 * Dispatches one allowlisted DeepSeek Harness session action and returns the
 * CLI result. On success the session message window is invalidated so fresh
 * dsh_state snapshots (queue/jobs/approvals) and projected messages appear.
 */
export function useDshAction(api: ApiClient | null, sessionId: string | null) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (action: DshAction) => {
            if (!api || !sessionId) {
                throw new Error('DSH session unavailable')
            }
            return await api.dshAction(sessionId, action)
        },
        onSuccess: () => {
            if (sessionId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.messages(sessionId) })
            }
        },
    })
}
