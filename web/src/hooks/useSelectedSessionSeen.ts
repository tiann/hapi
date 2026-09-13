import { useEffect } from 'react'
import { markSessionSeen } from '@/lib/sessionLastSeen'
import { useDocumentVisibility } from './useDocumentVisibility'

/** Mark the selected session read only while the document is visible. */
export function useSelectedSessionSeen(
    selectedSessionId: string | null,
    updatedAt: number | undefined,
): void {
    const isDocumentVisible = useDocumentVisibility()

    useEffect(() => {
        if (!isDocumentVisible || !selectedSessionId || updatedAt === undefined) {
            return
        }

        markSessionSeen(selectedSessionId, updatedAt)
    }, [isDocumentVisible, selectedSessionId, updatedAt])
}
