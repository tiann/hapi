import { useEffect } from 'react'
import { markSessionSeen, useSessionReadReady } from '@/lib/sessionLastSeen'
import { useDocumentVisibility } from './useDocumentVisibility'

/** Mark the selected session read only while the document is visible. */
export function useSelectedSessionSeen(
    selectedSessionId: string | null,
    updatedAt: number | undefined,
): void {
    const isDocumentVisible = useDocumentVisibility()
    const readReady = useSessionReadReady()

    useEffect(() => {
        if (!readReady || !isDocumentVisible || !selectedSessionId || updatedAt === undefined) {
            return
        }

        markSessionSeen(selectedSessionId, updatedAt)
    }, [readReady, isDocumentVisible, selectedSessionId, updatedAt])
}
