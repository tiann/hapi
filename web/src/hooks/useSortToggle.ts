import { useMemo } from 'react'

import type { ApiClient } from '@/api/client'
import type { SessionManualOrder } from '@/types/api'
import { useSessionSortPreference } from '@/hooks/queries/useSessionSortPreference'
import { useSessionSortPreferenceMutation } from '@/hooks/mutations/useSessionSortPreference'
import {
    reconcileManualOrder,
    snapshotManualOrder,
    applyManualOrder,
    moveGroup,
    moveSession,
} from '@/lib/sessionSortOrder'

type SortableSession = { id: string }
type SortableGroup<TSession extends SortableSession = SortableSession> = {
    key: string
    sessions: TSession[]
}

export function useSortToggle<
    TSession extends SortableSession,
    TGroup extends SortableGroup<TSession>
>(api: ApiClient | null, groups: TGroup[]) {
    const { preference } = useSessionSortPreference(api)
    const { setSessionSortPreference, isPending: isSortPreferencePending } = useSessionSortPreferenceMutation(api)
    const sortMode = preference.sortMode

    const reconciledManualOrder = useMemo(
        () => reconcileManualOrder(groups, preference.manualOrder),
        [groups, preference.manualOrder]
    )

    const orderedGroups = useMemo(
        () => (sortMode === 'manual' ? applyManualOrder(groups, reconciledManualOrder) : groups),
        [groups, reconciledManualOrder, sortMode]
    )

    const persistSortPreference = (nextSortMode: 'auto' | 'manual', nextManualOrder: SessionManualOrder = reconciledManualOrder) => {
        if (!api) return
        void setSessionSortPreference({
            sortMode: nextSortMode,
            manualOrder: nextManualOrder,
            expectedVersion: preference.version
        }).catch((error) => {
            console.error('Failed to persist session sort preference:', error)
        })
    }

    const toggleSortMode = () => {
        if (sortMode === 'auto') {
            persistSortPreference('manual', snapshotManualOrder(groups))
            return
        }
        persistSortPreference('auto', reconciledManualOrder)
    }

    const moveGroupInPreference = (groupKey: string, direction: 'up' | 'down') => {
        if (sortMode !== 'manual') return
        const nextManualOrder = moveGroup(reconciledManualOrder, groupKey, direction)
        if (nextManualOrder === reconciledManualOrder) return
        persistSortPreference('manual', nextManualOrder)
    }

    const moveSessionInPreference = (groupKey: string, sessionId: string, direction: 'up' | 'down') => {
        if (sortMode !== 'manual') return
        const nextManualOrder = moveSession(reconciledManualOrder, groupKey, sessionId, direction)
        if (nextManualOrder === reconciledManualOrder) return
        persistSortPreference('manual', nextManualOrder)
    }

    return {
        sortMode,
        orderedGroups,
        isSortPreferencePending,
        toggleSortMode,
        moveGroupInPreference,
        moveSessionInPreference,
    }
}
