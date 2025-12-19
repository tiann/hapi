import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { makeClientSideId, upsertMessagesInCache } from '@/lib/messages'
import { queryKeys } from '@/lib/query-keys'
import { usePlatform } from '@/hooks/usePlatform'

type SendMessageInput = {
    sessionId: string
    text: string
    localId: string
    createdAt: number
}

function updateMessageStatus(
    data: InfiniteData<MessagesResponse> | undefined,
    localId: string,
    status: DecryptedMessage['status'],
): InfiniteData<MessagesResponse> | undefined {
    if (!data) return data

    const pages = data.pages.map((page) => ({
        ...page,
        messages: page.messages.map((message) =>
            message.localId === localId
                ? { ...message, status }
                : message
        ),
    }))

    return {
        ...data,
        pages,
    }
}

function findMessageByLocalId(
    data: InfiniteData<MessagesResponse> | undefined,
    localId: string,
): DecryptedMessage | null {
    if (!data) return null
    for (const page of data.pages) {
        const match = page.messages.find((message) => message.localId === localId)
        if (match) return match
    }
    return null
}

export function useSendMessage(api: ApiClient | null, sessionId: string | null): {
    sendMessage: (text: string) => void
    retryMessage: (localId: string) => void
    isSending: boolean
} {
    const queryClient = useQueryClient()
    const { haptic } = usePlatform()

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            await api.sendMessage(input.sessionId, input.text, input.localId)
        },
        onMutate: async (input) => {
            const optimisticMessage: DecryptedMessage = {
                id: input.localId,
                seq: null,
                localId: input.localId,
                content: { role: 'user', content: input.text },
                createdAt: input.createdAt,
                status: 'sending',
                originalText: input.text,
            }

            queryClient.setQueryData<InfiniteData<MessagesResponse>>(
                queryKeys.messages(input.sessionId),
                (data) => upsertMessagesInCache(data, [optimisticMessage]),
            )
        },
        onSuccess: (_, input) => {
            queryClient.setQueryData<InfiniteData<MessagesResponse>>(
                queryKeys.messages(input.sessionId),
                (data) => updateMessageStatus(data, input.localId, 'sent'),
            )
            haptic.notification('success')
        },
        onError: (_, input) => {
            queryClient.setQueryData<InfiniteData<MessagesResponse>>(
                queryKeys.messages(input.sessionId),
                (data) => updateMessageStatus(data, input.localId, 'failed'),
            )
            haptic.notification('error')
        },
    })

    const sendMessage = (text: string) => {
        if (!api || !sessionId) return
        if (mutation.isPending) return
        const localId = makeClientSideId('local')
        mutation.mutate({
            sessionId,
            text,
            localId,
            createdAt: Date.now(),
        })
    }

    const retryMessage = (localId: string) => {
        if (!api || !sessionId) return
        if (mutation.isPending) return

        const data = queryClient.getQueryData<InfiniteData<MessagesResponse>>(queryKeys.messages(sessionId))
        const message = findMessageByLocalId(data, localId)
        if (!message?.originalText) return

        queryClient.setQueryData<InfiniteData<MessagesResponse>>(
            queryKeys.messages(sessionId),
            (current) => updateMessageStatus(current, localId, 'sending'),
        )

        mutation.mutate({
            sessionId,
            text: message.originalText,
            localId,
            createdAt: message.createdAt,
        })
    }

    return {
        sendMessage,
        retryMessage,
        isSending: mutation.isPending,
    }
}
