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
    /** Full message snapshot for revert if the cancel is rejected or the message was already invoked. */
    snapshot: DecryptedMessage
}

/**
 * Mutation: cancel a single queued (uninvoked) message.
 *
 * Optimistic flow:
 *  1. Remove message from store immediately (floating bar clears).
 *  2. Fire DELETE /sessions/:id/messages/:messageId.
 *  3a. On success with status='cancelled': nothing to do (SSE `message-cancelled` confirms server side).
 *  3b. On success with status='invoked': the CLI beat us to it — revert the optimistic
 *      removal by re-inserting the snapshot so the message stays visible in the thread.
 *  4. On error: re-insert the snapshot so the bar comes back; haptic error feedback.
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
        onSuccess: (result, input) => {
            if (result.status === 'invoked') {
                // Race: the CLI consumed this message before the cancel request arrived.
                // Revert the optimistic removal so the message remains visible to the user.
                appendOptimisticMessage(input.sessionId, input.snapshot)
            }
            // status === 'cancelled': optimistic removal stands — nothing extra to do.
        },
        onError: (_error, input) => {
            // Revert: put the message back so it re-appears in the bar.
            appendOptimisticMessage(input.sessionId, input.snapshot)
            haptic.notification('error')
        },
    })

    return mutation
}
