import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { markMessagesConsumed, removeOptimisticMessage } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'

export function useAbandonIndeterminateMessage(api: ApiClient | null) {
    const { t } = useTranslation()
    return useMutation({
        mutationFn: async (input: { sessionId: string; messageId: string; localId: string }) => {
            if (!api) throw new Error('API unavailable')
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
                removeOptimisticMessage(input.sessionId, input.localId)
            }
        },
    })
}
