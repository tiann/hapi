import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@hapi/protocol/types'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow } from '@/lib/message-window-store'
import { isSessionArchivable } from '@/lib/projectGroupActions'

const UNCONFIRMED_ARCHIVE_KEY = ['project-group-archive-unconfirmed'] as const

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
    // instead of re-deriving targets from metadata. Kept in the query client,
    // not the header, because filters can unmount the header mid-request.
    const { data: unconfirmedIds } = useQuery({
        queryKey: UNCONFIRMED_ARCHIVE_KEY,
        queryFn: () => [] as string[],
        initialData: [] as string[],
        enabled: false,
        staleTime: Infinity,
        gcTime: Infinity,
    })
    const updateUnconfirmed = (update: (ids: Set<string>) => void) => {
        queryClient.setQueryData<string[]>(UNCONFIRMED_ARCHIVE_KEY, (previous = []) => {
            const ids = new Set(previous)
            update(ids)
            return [...ids]
        })
    }

    const archiveMutation = useMutation({
        mutationFn: async () => {
            if (!api) {
                throw new Error('Session unavailable')
            }
            const unconfirmed = new Set(queryClient.getQueryData<string[]>(UNCONFIRMED_ARCHIVE_KEY) ?? [])
            const remaining = [...new Set([
                ...sessions.filter(({ id }) => unconfirmed.has(id)).map(({ id }) => id),
                ...sessions.filter(isSessionArchivable).map(({ id }) => id),
            ])]
            while (remaining.length > 0) {
                try {
                    await api.archiveSession(remaining[0]!)
                } catch (error) {
                    updateUnconfirmed((ids) => remaining.forEach((id) => ids.add(id)))
                    throw error
                }
                const confirmed = remaining.shift()!
                updateUnconfirmed((ids) => ids.delete(confirmed))
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
            updateUnconfirmed((ids) => sessions.forEach(({ id }) => ids.delete(id)))
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
        hasUnconfirmedArchive: sessions.some(({ id }) => unconfirmedIds.includes(id)),
    }
}
