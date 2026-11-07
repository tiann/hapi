import { useCallback, useEffect, useState } from 'react'
import type { Metadata } from '@hapi/protocol/types'
import type { ApiClient } from '@/api/client'

/** The HTTP acknowledgement can arrive before the metadata SSE update. */
export function useRewindPending(metadata: Metadata | null | undefined) {
    const [accepted, setAccepted] = useState<{ operationId?: string; previousRewind: Metadata['claudeRewind'] } | null>(null)
    const rewind = metadata?.claudeRewind
    const terminal = rewind?.phase === 'committed' || rewind?.phase === 'rejected'
    const settled = accepted !== null && terminal && (accepted.operationId
        ? rewind?.operationId === accepted.operationId
        : rewind !== accepted?.previousRewind)
    const awaitingMetadata = accepted !== null && !settled
    const pending = awaitingMetadata || rewind?.phase === 'requested'
        || rewind?.phase === 'pending' || rewind?.phase === 'applied' || rewind?.phase === 'unknown'

    useEffect(() => {
        if (settled) setAccepted(null)
    }, [settled])
    const acceptPending = useCallback((operationId?: string) => {
        setAccepted({ operationId, previousRewind: rewind })
    }, [rewind])

    const runRewind = useCallback(async (
        request: () => ReturnType<ApiClient['rewindConversation']>,
        onCommitted: () => Promise<void>,
    ) => {
        const result = await request()
        if (result.pending) {
            acceptPending(result.session.metadata?.claudeRewind?.operationId)
            return
        }
        await onCommitted()
    }, [acceptPending])

    return { pending, acceptPending, runRewind }
}
