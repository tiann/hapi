import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { appendOptimisticMessage } from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

type SteerQueuedMessageInput = {
    sessionId: string
    messageId: string
    localId: string
    snapshot: DecryptedMessage
}

/**
 * Mutation: steer one waiting-queue message into the active turn.
 * Success is confirmed by messages-consumed (steered:true) SSE; this call only
 * asks the CLI to start the steer.
 */
export function useSteerQueuedMessage(api: ApiClient | null) {
    const { haptic } = usePlatform()
    const { addToast } = useToast()
    const { t } = useTranslation()

    return useMutation({
        mutationFn: async (input: SteerQueuedMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return api.steerQueuedMessage(input.sessionId, input.messageId)
        },
        onSuccess: (result, input) => {
            if (result.status === 'failed') {
                addToast({
                    title: t('queuedMessages.steerFailed'),
                    body: result.error,
                    sessionId: input.sessionId,
                    url: window.location.href,
                })
                haptic.notification('error')
                return
            }
            if (result.status === 'invoked') {
                // Race: CLI already consumed the row. Merge the authoritative
                // invoked message so the queued bar clears even if SSE was missed
                // (same pattern as useCancelQueuedMessage).
                appendOptimisticMessage(input.sessionId, {
                    id: result.message.id,
                    seq: result.message.seq,
                    localId: result.message.localId,
                    content: result.message.content,
                    createdAt: result.message.createdAt,
                    invokedAt: result.message.invokedAt,
                    scheduledAt: result.message.scheduledAt,
                    status: 'sent',
                })
                addToast({
                    title: t('queuedMessages.steerAlreadyInvoked'),
                    body: '',
                    sessionId: input.sessionId,
                    url: window.location.href,
                })
            }
            haptic.notification('success')
        },
        onError: (error, input) => {
            addToast({
                title: t('queuedMessages.steerFailed'),
                body: error instanceof Error ? error.message : String(error),
                sessionId: input.sessionId,
                url: window.location.href,
            })
            haptic.notification('error')
        },
    })
}
