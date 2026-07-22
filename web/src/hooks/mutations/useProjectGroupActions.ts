import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow } from '@/lib/message-window-store'
import { isOldInactiveSession, isSessionArchivable } from '@/lib/projectGroupActions'

/**
 * Bulk actions over every session in a sidebar project group (tiann/hapi#881).
 *
 * There is no atomic bulk route, so the operations fan out to the existing
 * per-session endpoints sequentially. A mid-loop rejection (e.g. a 409 from a
 * session that became active) aborts the run, mirroring single-session
 * behaviour; React Query surfaces it to the caller.
 */
export function useProjectGroupActions(
    api: ApiClient | null,
    sessions: SessionSummary[]
): {
    archiveAll: () => Promise<void>
    deleteAll: () => Promise<void>
    cleanOldSessions: () => Promise<void>
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
            for (const session of sessions) {
                await api.deleteSession(session.id)
            }
        },
        onSuccess: async () => {
            for (const session of sessions) {
                queryClient.removeQueries({ queryKey: queryKeys.session(session.id) })
                clearMessageWindow(session.id)
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    const cleanOldMutation = useMutation({
        mutationFn: async () => {
            if (!api) {
                throw new Error('Session unavailable')
            }
            const now = Date.now()
            const deletedSessions: SessionSummary[] = []
            for (const session of sessions) {
                if (isOldInactiveSession(session, now)) {
                    await api.deleteSession(session.id)
                    deletedSessions.push(session)
                }
            }
            return deletedSessions
        },
        onSuccess: async (deletedSessions) => {
            for (const session of deletedSessions) {
                queryClient.removeQueries({ queryKey: queryKeys.session(session.id) })
                clearMessageWindow(session.id)
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    return {
        archiveAll: archiveMutation.mutateAsync,
        deleteAll: deleteMutation.mutateAsync,
        cleanOldSessions: async () => {
            await cleanOldMutation.mutateAsync()
        },
        isPending: archiveMutation.isPending || deleteMutation.isPending || cleanOldMutation.isPending,
    }
}
