import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    appendOptimisticMessage,
    removeOptimisticMessage,
} from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'

type CancelQueuedMessageInput = {
    sessionId: string
    messageId: string
    /** localId used for optimistic removal and revert on error. */
    localId: string
    /** Full message snapshot for revert if the DELETE fails. */
    snapshot: DecryptedMessage
}

/**
 * Mutation: cancel a single queued (uninvoked) message.
 *
 * Optimistic flow:
 *  1. Remove message from store immediately (floating bar clears).
 *  2. Fire DELETE /sessions/:id/messages/:messageId.
 *  3. On success: nothing to do (SSE `message-cancelled` confirms server side).
 *  4. On error: re-insert the snapshot so the bar comes back; haptic error feedback.
 *
 * The `alreadyGone` response (HTTP 200) is treated as success — the row was
 * already cancelled or invoked, so the optimistic removal is correct.
 */
export function useCancelQueuedMessage(api: ApiClient | null) {
    const { haptic } = usePlatform()

    const mutation = useMutation({
        mutationFn: async (input: CancelQueuedMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return api.cancelMessage(input.sessionId, input.messageId)
        },
        onMutate: (input) => {
            // Optimistic: remove from the floating bar immediately.
            removeOptimisticMessage(input.sessionId, input.localId)
        },
        onError: (_error, input) => {
            // Revert: put the message back so it re-appears in the bar.
            appendOptimisticMessage(input.sessionId, input.snapshot)
            haptic.notification('error')
        },
    })

    return mutation
}
