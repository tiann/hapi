import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type { CancelMessageResponse } from '@hapi/protocol/schemas'
import {
    appendOptimisticMessage,
    markMessagesConsumed,
    markMessagesRequeued,
    removeOptimisticMessage,
} from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'

type CancelQueuedMessageInput = {
    sessionId: string
    messageId: string
    /** localId used for optimistic removal and revert on error. */
    localId: string
    /** Snapshot for onError revert (network failure path only).
     *  For the invoked-race path, the server-validated row from the response is used instead. */
    snapshot: DecryptedMessage
}

/**
 * Mutation: cancel a single queued (uninvoked) message.
 *
 * Optimistic flow:
 *  1. Remove message from store immediately (floating bar clears).
 *  2. Fire DELETE /sessions/:id/messages/:messageId.
 *  3a. On success with status='cancelled': nothing to do (SSE `message-cancelled` confirms server side).
 *  3b. On success with status='invoked': the CLI beat us to it.
 *      Restore using the server-validated row (with authoritative invokedAt), NOT the stale
 *      client snapshot (invokedAt: null / status: queued). The `messages-consumed` SSE may
 *      have already arrived while the web row was optimistically removed (markMessagesConsumed
 *      no-op on missing row), so no later event will fix the stuck chip.
 *      appendOptimisticMessage with status='sent' shows the message in the thread correctly.
 *  3c. On success with status='busy': the row is inside an async steer / unknown outcome.
 *      First-time busy restores a held indeterminate copy so the user can retry or cancel.
 *      Cancel/Edit on an *already* indeterminate row force-dismisses from the floating bar
 *      (#1839) via queueDismissed — restored before getQueuedState so a concurrent
 *      messages-consumed SSE can still mark the row sent, then left alone in onSuccess
 *      so we do not overwrite that acknowledgement with an uninvoked snapshot.
 *      If getQueuedState reports the row was already consumed, mutationFn upgrades the
 *      result to `invoked` so Edit toasts instead of prefilling a duplicate.
 *  4. On error: re-insert the snapshot so the bar comes back; haptic error feedback.
 */
export function useCancelQueuedMessage(api: ApiClient | null) {
    const { haptic } = usePlatform()

    const mutation = useMutation({
        mutationFn: async (input: CancelQueuedMessageInput): Promise<CancelMessageResponse> => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const result = await api.cancelMessage(input.sessionId, input.messageId)
            // Force-dismiss (#1839): learn whether the steer already landed before
            // callers (Edit) decide to prefill. Returning synthetic `invoked` keeps
            // the existing Edit toast path and avoids a duplicate composer send.
            if (result.status === 'busy' && input.snapshot.deliveryState === 'indeterminate') {
                // Restore a hidden hold BEFORE the queued-state lookup so a
                // messages-consumed SSE during that await can still land.
                appendOptimisticMessage(input.sessionId, {
                    ...input.snapshot,
                    deliveryState: 'indeterminate',
                    queueDismissed: true,
                })
                try {
                    const state = await api.getQueuedState(input.sessionId, [input.localId])
                    const invoked = state.invokedLocalMessages.find((item) => item.localId === input.localId)
                    if (invoked) {
                        return {
                            status: 'invoked',
                            message: {
                                id: input.snapshot.id,
                                seq: input.snapshot.seq ?? null,
                                localId: input.localId,
                                content: input.snapshot.content,
                                createdAt: input.snapshot.createdAt,
                                invokedAt: invoked.invokedAt,
                            },
                        }
                    }
                    // Steer may have failed and returned the row to FIFO while DELETE
                    // was still in flight. Clear the hidden hold so Edit/Cancel return.
                    if (state.queuedLocalIds.includes(input.localId)) {
                        markMessagesRequeued(input.sessionId, [input.localId])
                    }
                } catch {
                    // Fall through to busy force-dismiss; SSE / reconnect may still reconcile.
                }
            }
            return result
        },
        onMutate: (input) => {
            // Optimistic: remove from the floating bar immediately.
            removeOptimisticMessage(input.sessionId, input.localId)
        },
        onSuccess: async (result, input) => {
            if (result.status === 'busy') {
                if (input.snapshot.deliveryState === 'indeterminate') {
                    // mutationFn already restored the queueDismissed hold (and may
                    // have been upgraded by a concurrent messages-consumed SSE).
                    // Do not overwrite with a fresh uninvoked snapshot.
                    return
                }
                // The row is inside an async steer: restore a held copy, not a
                // normal FIFO row. A concurrent consumed ACK may have arrived
                // while the optimistic row was absent, so reconcile once.
                appendOptimisticMessage(input.sessionId, {
                    ...input.snapshot,
                    deliveryState: 'indeterminate',
                })
                if (api) {
                    try {
                        const state = await api.getQueuedState(input.sessionId, [input.localId])
                        const invoked = state.invokedLocalMessages.find((item) => item.localId === input.localId)
                        if (invoked) {
                            markMessagesConsumed(input.sessionId, [input.localId], invoked.invokedAt)
                        }
                    } catch {
                        // SSE / the next reconnect will reconcile the held row.
                    }
                }
                return
            }
            if (result.status === 'invoked') {
                // Race: CLI consumed this message before cancel arrived.
                // Restore using the server-validated invoked row so invokedAt is correct.
                // Without this, messages-consumed SSE was a no-op (web row was missing)
                // so the chip would be stuck as queued forever.
                appendOptimisticMessage(input.sessionId, {
                    id: result.message.id,
                    seq: result.message.seq,
                    localId: result.message.localId,
                    content: result.message.content,
                    createdAt: result.message.createdAt,
                    invokedAt: result.message.invokedAt,
                    status: 'sent',
                })
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
