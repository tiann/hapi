import { useEffect } from 'react'
import { markSessionSeen } from '@/lib/sessionLastSeen'
import { useDocumentVisibility } from './useDocumentVisibility'

/** Mark the selected session read only while the document is visible. */
export function useSelectedSessionSeen(
    selectedSessionId: string | null,
    activityAt: number | undefined,
): void {
    const isDocumentVisible = useDocumentVisibility()

    useEffect(() => {
        if (!isDocumentVisible || !selectedSessionId || activityAt === undefined) {
            return
        }

        markSessionSeen(selectedSessionId, activityAt)
    }, [isDocumentVisible, selectedSessionId, activityAt])
}
