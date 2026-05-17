import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import {
    appendOptimisticMessage,
    markMessagesConsumed,
    removeOptimisticMessage,
} from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'

type SteerQueuedMessageInput = {
    sessionId: string
    messageId: string
    localId: string
}

export function useSteerQueuedMessage(api: ApiClient | null) {
    const { haptic } = usePlatform()

    return useMutation({
        mutationFn: async (input: SteerQueuedMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return api.steerQueuedMessage(input.sessionId, input.messageId)
        },
        onSuccess: (result, input) => {
            if (result.status === 'steered') {
                markMessagesConsumed(input.sessionId, [input.localId], result.invokedAt)
                haptic.notification('success')
                return
            }
            if (result.status === 'invoked') {
                removeOptimisticMessage(input.sessionId, input.localId)
                appendOptimisticMessage(input.sessionId, {
                    id: result.message.id,
                    seq: result.message.seq,
                    localId: result.message.localId,
                    content: result.message.content,
                    createdAt: result.message.createdAt,
                    invokedAt: result.message.invokedAt,
                    status: 'sent',
                })
                haptic.notification('success')
                return
            }
            haptic.notification('error')
        },
        onError: (_error, _input) => {
            haptic.notification('error')
        },
    })
}
