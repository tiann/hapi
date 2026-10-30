import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, markMessagesConsumed, markMessagesDispatching, markMessagesIndeterminate, markMessagesRequeued, reconcileQueuedLocalIds } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'

type SteerQueuedMessageInput = {
    sessionId: string
    messageId: string
}

/**
 * Mutation: deliver one queued message into the active Pi turn (native steer).
 *
 * Non-optimistic on purpose: the CLI acknowledges the steer via the existing
 * `messages-consumed` event, which flips the row to invoked and removes it from
 * the floating bar. An optimistic removal here would fight that event and
 * would need a revert path for the failure case anyway.
 *
 * Failure surfaces as a toast; the row stays queued and can be retried.
 */
export function useSteerQueuedMessage(api: ApiClient | null) {
    const { t } = useTranslation()
    const { addToast } = useToast()

    const mutation = useMutation({
        mutationFn: async (input: SteerQueuedMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return api.steerMessage(input.sessionId, input.messageId)
        },
        onSuccess: async (result, input) => {
            if (result.status === 'failed') {
                addToast({
                    title: t('queuedMessages.steerFailed'),
                    body: result.error ?? '',
                    sessionId: input.sessionId,
                    url: window.location.href,
                })
                return
            }
            if (result.status === 'invoked' && result.message.localId && typeof result.message.invokedAt === 'number') {
                // The CLI consumed this message before the steer arrived. If the
                // messages-consumed SSE was missed while the row was still
                // queued, reconcile it now so the queued bar cannot keep a
                // stale actionable row (mirrors useCancelQueuedMessage).
                markMessagesConsumed(input.sessionId, [result.message.localId], result.message.invokedAt)
            }
            if (result.status === 'steered' && result.localId && api) {
                const localId = result.localId
                const current = () => getMessageWindowState(input.sessionId).messages.find(message => message.localId === localId)
                const before = current()
                // A successful RPC can beat the pending SSE. Hold the row without
                // claiming invocation, but never replace an already observed outcome.
                if (!before || before.invokedAt !== null || before.deliveryState === 'indeterminate') return
                markMessagesDispatching(input.sessionId, [localId])
                const pending = current()
                try {
                    const state = await api.getQueuedState(input.sessionId, [localId])
                    const invoked = state.invokedLocalMessages.find(message => message.localId === localId)
                    if (invoked) {
                        markMessagesConsumed(input.sessionId, [localId], invoked.invokedAt)
                    } else if (current() === pending) {
                        if (state.dispatchingLocalIds?.includes(localId)) {
                            markMessagesDispatching(input.sessionId, [localId])
                        } else if (state.indeterminateLocalIds?.includes(localId)) {
                            markMessagesIndeterminate(input.sessionId, [localId])
                        } else if (state.queuedLocalIds.includes(localId)) {
                            markMessagesRequeued(input.sessionId, [localId])
                        } else {
                            reconcileQueuedLocalIds(input.sessionId, [localId], [])
                        }
                    }
                } catch {
                    // An unavailable readback is not evidence of rejection or
                    // delivery. Preserve the hold until SSE/reconnect reconciles it.
                }
            }
        },
        onError: (error, input) => {
            addToast({
                title: t('queuedMessages.steerFailed'),
                body: error instanceof Error ? error.message : '',
                sessionId: input.sessionId,
                url: window.location.href,
            })
        },
    })

    return mutation
}
