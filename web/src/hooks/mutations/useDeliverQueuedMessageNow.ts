import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { markMessagesConsumed } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'

type DeliverQueuedMessageNowInput = {
    sessionId: string
    messageId: string
}

/**
 * Mutation: force re-deliver one queued message to the CLI right now
 * (the queued bar's ↑ affordance).
 *
 * Non-optimistic on purpose: the CLI consumes the row into a fresh turn and
 * the existing `messages-consumed` event flips it to invoked, removing the
 * row from the floating bar. This is the recovery path for rows stranded by
 * an abort (DSH/Codex drop their in-memory queue on stop and the hub's
 * session-alive replay is deduped away by the CLI).
 *
 * Failure surfaces as a toast; the row stays queued and can be retried.
 */
export function useDeliverQueuedMessageNow(api: ApiClient | null) {
    const { t } = useTranslation()
    const { addToast } = useToast()

    const mutation = useMutation({
        mutationFn: async (input: DeliverQueuedMessageNowInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return api.deliverQueuedMessageNow(input.sessionId, input.messageId)
        },
        onSuccess: (result, input) => {
            if (result.status === 'invoked'
                && result.message.localId
                && typeof result.message.invokedAt === 'number') {
                // The CLI consumed this message before the request arrived.
                // Reconcile now so the queued bar cannot keep a stale
                // actionable row (mirrors useSteerQueuedMessage).
                markMessagesConsumed(input.sessionId, [result.message.localId], result.message.invokedAt)
            }
            if (result.status === 'unavailable') {
                addToast({
                    title: t('queuedMessages.deliverNowUnavailable'),
                    body: '',
                    sessionId: input.sessionId,
                    url: window.location.href,
                })
            }
        },
        onError: (error, input) => {
            addToast({
                title: t('queuedMessages.deliverNowFailed'),
                body: error instanceof Error ? error.message : '',
                sessionId: input.sessionId,
                url: window.location.href,
            })
        },
    })

    return mutation
}
