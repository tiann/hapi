import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@hapi/protocol/types'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow } from '@/lib/message-window-store'
import { isSessionArchivable } from '@/lib/projectGroupActions'

/**
 * Bulk actions over every session in a sidebar project group (tiann/hapi#881).
 *
 * Group deletion uses the server-side all-or-nothing archived bulk route so a
 * race cannot partially delete a confirmed group.
 */
export function useProjectGroupActions(
    api: ApiClient | null,
    sessions: SessionSummary[]
): {
    archiveAll: () => Promise<void>
    deleteGroup: () => Promise<void>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const archiveMutation = useMutation({
        mutationFn: async () => {
            if (!api) {
                throw new Error('Session unavailable')
            }
            for (const session of sessions) {
                if (isSessionArchivable(session)) {
                    await api.archiveSession(session.id)
                }
            }
        },
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            if (!api) {
                throw new Error('Session unavailable')
            }
            await api.deleteArchivedSessions({
                sessionIds: sessions.map(({ id }) => id),
                requireAllArchived: true,
            })
        },
        onSuccess: async () => {
            for (const session of sessions) {
                queryClient.removeQueries({ queryKey: queryKeys.session(session.id) })
                clearMessageWindow(session.id)
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    return {
        archiveAll: archiveMutation.mutateAsync,
        deleteGroup: deleteMutation.mutateAsync,
        isPending: archiveMutation.isPending || deleteMutation.isPending,
    }
}
