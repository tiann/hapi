import { useState } from 'react'
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
    /** A previous Archive All failed; its members may already read archived. */
    hasUnconfirmedArchive: boolean
} {
    const queryClient = useQueryClient()
    // SSE can mark a member archived before its archive request (runner
    // cleanup) fails, so a retry must re-send the IDs that were not confirmed
    // instead of re-deriving targets from metadata.
    const [unconfirmedIds, setUnconfirmedIds] = useState<string[]>([])

    const archiveMutation = useMutation({
        mutationFn: async () => {
            if (!api) {
                throw new Error('Session unavailable')
            }
            const memberIds = new Set(sessions.map(({ id }) => id))
            const remaining = [...new Set([
                ...unconfirmedIds.filter((id) => memberIds.has(id)),
                ...sessions.filter(isSessionArchivable).map(({ id }) => id),
            ])]
            while (remaining.length > 0) {
                try {
                    await api.archiveSession(remaining[0]!)
                } catch (error) {
                    setUnconfirmedIds(remaining)
                    throw error
                }
                remaining.shift()
            }
            setUnconfirmedIds([])
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
        hasUnconfirmedArchive: unconfirmedIds.length > 0,
    }
}
