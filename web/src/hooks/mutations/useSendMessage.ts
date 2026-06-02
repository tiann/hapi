import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'
import { makeClientSideId } from '@/lib/messages'
import {
    appendOptimisticMessage,
    getMessageWindowState,
    removeOptimisticMessage,
    updateMessageStatus,
} from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'

type SendMessageInput = {
    sessionId: string
    text: string
    localId: string
    createdAt: number
    attachments?: AttachmentMetadata[]
    scheduledAt?: number | null
}

type BlockedReason = 'no-api' | 'no-session' | 'pending'

/**
 * Information about a send that the underlying mutation rejected.
 *
 * Surfaced via the `onError` option so the consumer can keep the typed
 * text in the composer (composer must NOT clear on 4xx/5xx or network
 * failure) and render an inline affordance.
 *
 * - `sessionId` is the session the failed send was actually targeting
 *   (post-`resolveSessionId`).  Inactive-session resume can resolve a
 *   target id, kick off async navigation, and then have the POST fail
 *   before navigation completes; without this id the consumer would
 *   restore the text into the wrong composer (the old session) and the
 *   sessionId-change effect would clear it again.
 * - `text` is the original input the user typed, captured before the
 *   mutation cleared the composer.
 * - `error` is the raw thrown value (typically `Error`) so the consumer
 *   can inspect status / message.
 * - `scheduledAt` is the absolute epoch-ms the send was bound for, or
 *   null for an immediate send.  Carried through so a failed scheduled
 *   send can be restored as a scheduled send instead of silently
 *   downgrading to immediate -- `SessionChat.handleSend` clears the
 *   pendingSchedule the moment the mutation is accepted, so without
 *   this the schedule is gone by the time onError fires.
 *
 * Only fired for text-only sends.  Sends with attachments fall back to
 * the legacy failed-bubble UX (the optimistic row stays as `failed` and
 * the user retries via the in-thread retry button); the composer-restore
 * path can't reinstate uploaded attachment metadata, so doing the swap
 * for attachment sends would silently drop the attachments.
 */
export type SendErrorInfo = {
    sessionId: string
    text: string
    error: unknown
    scheduledAt: number | null
}

type UseSendMessageOptions = {
    resolveSessionId?: (sessionId: string) => Promise<string>
    onSessionResolved?: (sessionId: string) => void
    onBlocked?: (reason: BlockedReason) => void
    onSuccess?: (sessionId: string) => void
    onError?: (info: SendErrorInfo) => void
    isSessionThinking?: boolean
}

/** Create an optimistic message for display. Extracted as an extension point
 *  so a future floating-UI PR can route queued messages to a separate area. */
function createOptimisticMessage(input: SendMessageInput, status: 'queued' | 'sending'): DecryptedMessage {
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
        // Explicit null so the strict-null queued check matches. A pre-V8 hub
        // response that omits the field entirely (`undefined`) is treated as
        // already-invoked and stays in the thread, not the floating bar.
        invokedAt: null,
        scheduledAt: input.scheduledAt ?? null,
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

/** Pull attachments off a stored optimistic user message.  The schema types
 *  `content` as `unknown`, so this is a defensive narrow: we accept only the
 *  exact shape `createOptimisticMessage` produces (`role: 'user'`, text-typed
 *  content, attachments array) and return undefined otherwise.  Used by
 *  retryMessage so an attachment send retried from the failed-bubble button
 *  re-fires with its attachments instead of becoming a text-only send. */
function getMessageAttachments(message: DecryptedMessage): AttachmentMetadata[] | undefined {
    const content = message.content as unknown
    if (
        typeof content !== 'object' ||
        content === null
    ) {
        return undefined
    }
    const outer = content as { role?: unknown; content?: unknown }
    if (outer.role !== 'user') return undefined
    const inner = outer.content as { type?: unknown; attachments?: unknown } | null
    if (!inner || inner.type !== 'text') return undefined
    if (!Array.isArray(inner.attachments) || inner.attachments.length === 0) {
        return undefined
    }
    return inner.attachments as AttachmentMetadata[]
}

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    // Resolves true when a mutation was actually started, false when the call was
    // rejected pre-mutation (no-api / no-session / pending) OR the async
    // resolveSessionId step threw. Async is required because inactive-session
    // resume happens before mutation.mutate(), and a sync `true` would let the
    // caller clear UI state (e.g. pendingSchedule) before knowing whether
    // resume succeeded — see SessionChat.handleSend.
    sendMessage: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    retryMessage: (localId: string) => boolean
    isSending: boolean
} {
    const { haptic } = usePlatform()
    const [isResolving, setIsResolving] = useState(false)
    const resolveGuardRef = useRef(false)
    const isSessionThinkingRef = useRef(options?.isSessionThinking ?? false)
    isSessionThinkingRef.current = options?.isSessionThinking ?? false

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            await api.sendMessage(input.sessionId, input.text, input.localId, input.attachments, input.scheduledAt)
        },
        onMutate: async (input) => {
            const status = isSessionThinkingRef.current ? 'queued' as const : 'sending' as const
            appendOptimisticMessage(input.sessionId, createOptimisticMessage(input, status))
            return { status }
        },
        onSuccess: (_, input, context) => {
            updateMessageStatus(
                input.sessionId,
                input.localId,
                context?.status === 'queued' ? 'queued' : 'sent'
            )
            haptic.notification('success')
            options?.onSuccess?.(input.sessionId)
        },
        onError: (error, input) => {
            // Attachment sends keep the legacy failed-bubble UX: the
            // composer-restore path can only re-seat text + scheduledAt,
            // not the uploaded attachment metadata.  Removing the row
            // would destroy the attachment preview AND leave the operator
            // with no retry surface for it.  Keep the row as `failed` so
            // the in-thread retry button can re-fire the send (with
            // attachments) via retryMessage.
            if (input.attachments && input.attachments.length > 0) {
                updateMessageStatus(input.sessionId, input.localId, 'failed')
                haptic.notification('error')
                return
            }
            // Text-only sends use the composer-restore path: drop the
            // optimistic row from the thread (otherwise the failed bubble
            // would visually duplicate the same text the composer is
            // about to restore, and the operator could stack a stale
            // failed turn next to a fresh send) and hand the text +
            // scheduledAt + sessionId back so the route can put both
            // back into the composer keyed to the right session.
            removeOptimisticMessage(input.sessionId, input.localId)
            haptic.notification('error')
            options?.onError?.({
                sessionId: input.sessionId,
                text: input.text,
                error,
                scheduledAt: input.scheduledAt ?? null
            })
        },
    })

    const sendMessage = async (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null): Promise<boolean> => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return false
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return false
        }
        if (mutation.isPending || resolveGuardRef.current) {
            options?.onBlocked?.('pending')
            return false
        }
        const localId = makeClientSideId('local')
        const createdAt = Date.now()
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
                return false
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
            scheduledAt,
        })
        return true
    }

    const retryMessage = (localId: string): boolean => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return false
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return false
        }
        if (mutation.isPending || resolveGuardRef.current) {
            options?.onBlocked?.('pending')
            return false
        }

        const message = findMessageByLocalId(sessionId, localId)
        if (!message?.originalText) return false

        updateMessageStatus(sessionId, localId, 'sending')

        mutation.mutate({
            sessionId,
            text: message.originalText,
            localId,
            createdAt: message.createdAt,
            attachments: getMessageAttachments(message),
            scheduledAt: message.scheduledAt ?? null,
        })
        return true
    }

    return {
        sendMessage,
        retryMessage,
        isSending: mutation.isPending || isResolving,
    }
}
