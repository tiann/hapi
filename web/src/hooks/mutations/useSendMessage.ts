import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, MessageStatus } from '@/types/api'
import { makeClientSideId } from '@/lib/messages'
import {
    appendOptimisticMessage,
    getMessageWindowState,
    updateMessageStatus,
} from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'

type SendMessageInput = {
    sessionId: string
    text: string
    localId: string
    createdAt: number
    attachments?: AttachmentMetadata[]
    appendOptimistic?: boolean
}

type BlockedReason = 'no-api' | 'no-session' | 'pending'

type UseSendMessageOptions = {
    resolveSessionId?: (sessionId: string) => Promise<string>
    onSessionResolved?: (sessionId: string) => void
    onBlocked?: (reason: BlockedReason) => void
    isSessionRunning?: boolean
    enableQueue?: boolean
}

function createOptimisticMessage(input: SendMessageInput, status: MessageStatus): DecryptedMessage {
    return {
        id: input.localId,
        seq: null,
        localId: input.localId,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: input.text,
                attachments: input.attachments
            }
        },
        createdAt: input.createdAt,
        status,
        originalText: input.text,
    }
}

function findMessageByLocalId(
    sessionId: string,
    localId: string,
): DecryptedMessage | null {
    const state = getMessageWindowState(sessionId)
    for (const message of state.messages) {
        if (message.localId === localId) return message
    }
    for (const message of state.pending) {
        if (message.localId === localId) return message
    }
    return null
}

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    sendMessage: (text: string, attachments?: AttachmentMetadata[]) => void
    retryMessage: (localId: string) => void
    isSending: boolean
} {
    const { haptic } = usePlatform()
    const [isResolving, setIsResolving] = useState(false)
    const [isDequeuing, setIsDequeuing] = useState(false)
    const [queuedMessages, setQueuedMessages] = useState<SendMessageInput[]>([])
    const resolveGuardRef = useRef(false)

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            await api.sendMessage(input.sessionId, input.text, input.localId, input.attachments)
        },
        onMutate: async (input) => {
            if (input.appendOptimistic === false) {
                return
            }
            appendOptimisticMessage(input.sessionId, createOptimisticMessage(input, 'sending'))
        },
        onSuccess: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'sent')
            haptic.notification('success')
        },
        onError: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'failed')
            haptic.notification('error')
        },
        onSettled: () => {
            setIsDequeuing(false)
        }
    })

    const busy = mutation.isPending || resolveGuardRef.current || isResolving || isDequeuing
    const running = options?.isSessionRunning === true
    const canQueue = options?.enableQueue === true

    useEffect(() => {
        if (!api || busy || running || queuedMessages.length === 0) {
            return
        }

        const [next, ...rest] = queuedMessages
        setQueuedMessages(rest)
        setIsDequeuing(true)
        updateMessageStatus(next.sessionId, next.localId, 'sending')
        mutation.mutate({
            ...next,
            appendOptimistic: false
        })
    }, [api, busy, mutation, queuedMessages, running])

    const sendMessage = (text: string, attachments?: AttachmentMetadata[]) => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return
        }
        const localId = makeClientSideId('local')
        const createdAt = Date.now()

        if ((busy || running) && canQueue) {
            const queuedInput: SendMessageInput = {
                sessionId,
                text,
                localId,
                createdAt,
                attachments,
                appendOptimistic: false
            }
            appendOptimisticMessage(sessionId, createOptimisticMessage(queuedInput, 'queued'))
            setQueuedMessages(prev => [...prev, queuedInput])
            haptic.impact('light')
            return
        }

        if (busy) {
            options?.onBlocked?.('pending')
            return
        }
        void (async () => {
            let targetSessionId = sessionId
            if (options?.resolveSessionId) {
                resolveGuardRef.current = true
                setIsResolving(true)
                try {
                    const resolved = await options.resolveSessionId(sessionId)
                    if (resolved && resolved !== sessionId) {
                        options.onSessionResolved?.(resolved)
                        targetSessionId = resolved
                    }
                } catch (error) {
                    haptic.notification('error')
                    console.error('Failed to resolve session before send:', error)
                    return
                } finally {
                    resolveGuardRef.current = false
                    setIsResolving(false)
                }
            }
            mutation.mutate({
                sessionId: targetSessionId,
                text,
                localId,
                createdAt,
                attachments,
                appendOptimistic: true
            })
        })()
    }

    const retryMessage = (localId: string) => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return
        }
        if (busy) {
            options?.onBlocked?.('pending')
            return
        }

        const message = findMessageByLocalId(sessionId, localId)
        if (!message?.originalText) return

        updateMessageStatus(sessionId, localId, 'sending')

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
        isSending: mutation.isPending || isResolving || isDequeuing,
    }
}
