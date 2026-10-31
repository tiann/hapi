import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, markMessagesConsumed, removeOptimisticMessage } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'

export function useAbandonIndeterminateMessage(api: ApiClient | null) {
    const { t } = useTranslation()
    return useMutation({
        mutationFn: async (input: { sessionId: string; messageId: string; localId: string }) => {
            if (!api) throw new Error('API unavailable')
            // A disconnected worker can leave a native queued submission marked
            // unknown in the Hub. Preserve confirmed cancellation after reconnect.
            const cancellation = await api.cancelMessage(input.sessionId, input.messageId)
            if (cancellation.status !== 'busy') return cancellation
            const result = await api.abandonIndeterminateMessage(input.sessionId, input.messageId)
            if (result.status === 'unavailable') throw new Error(t('queuedMessages.abandonUnavailable'))
            return result
        },
        onSuccess: (result, input) => {
            if (result.status === 'invoked') {
                if (result.message.localId && typeof result.message.invokedAt === 'number') {
                    markMessagesConsumed(input.sessionId, [result.message.localId], result.message.invokedAt)
                }
            } else {
                // Authoritative consumption may arrive through SSE before this
                // older HTTP response. Never remove its newer delivered row.
                const consumed = getMessageWindowState(input.sessionId).messages.some(message =>
                    (message.localId === input.localId || message.id === input.localId)
                    && message.invokedAt !== null)
                if (consumed) return
                removeOptimisticMessage(input.sessionId, input.localId)
            }
        },
    })
}
