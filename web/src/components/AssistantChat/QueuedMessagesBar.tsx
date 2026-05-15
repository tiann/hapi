import { useAssistantApi } from '@assistant-ui/react'
import { useCallback, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'

function ClockIcon() {
    return (
        <svg
            className="h-[14px] w-[14px] shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
        >
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path
                d="M8 5v3.5l2.5 1.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

/**
 * Returns user messages that haven't been invoked yet (invokedAt == null and not sent/failed).
 * Covers both optimistic (status='queued') and server-loaded (status=undefined, invokedAt=null) cases.
 */
function useQueuedMessages(sessionId: string): DecryptedMessage[] {
    const state = useSyncExternalStore(
        useCallback((listener) => subscribeMessageWindow(sessionId, listener), [sessionId]),
        useCallback(() => getMessageWindowState(sessionId), [sessionId]),
        () => EMPTY_STATE
    )

    // `invokedAt` is the source of truth for invocation; see isQueuedForInvocation
    // (lib/messages) for the shared predicate used by the thread filter and the
    // window store trim helpers.
    const allMessages = [...state.messages, ...state.pending]
    return allMessages.filter(isQueuedForInvocation)
}

function getTextFromMessage(msg: DecryptedMessage): string {
    const normalized = normalizeDecryptedMessage(msg)
    if (!normalized || normalized.role !== 'user') {
        return ''
    }
    const text = (normalized.content.text ?? '').trim()
    if (text) {
        return text
    }
    // Attachment-only sends: the composer / POST /messages allow empty text
    // when attachments are present. Fall back to the filenames so the chip
    // is not blank.
    const attachments = normalized.content.attachments ?? []
    if (attachments.length === 0) {
        return ''
    }
    return attachments.map((a) => a.filename ?? 'attachment').join(', ')
}

/**
 * Determines whether the user can cancel or edit a queued message.
 *
 * Two conditions must both be true:
 * 1. hasServerEcho: the hub has persisted the row.
 *    useSendMessage.onMutate creates { id: localId, localId } before POST /messages
 *    completes. Only after the server echo (message-received SSE) does the store
 *    replace the row with a server-assigned UUID id, making id !== localId.
 *    Sending DELETE before that echo would find no row in the hub and return
 *    cancelled/localId:null; the original POST could then still insert and broadcast
 *    the message, letting a canceled message reappear and be invoked.
 * 2. !isPending: no cancel mutation is already in-flight.
 *
 * @internal Exported for unit testing.
 */
export function computeCanCancel({
    id,
    localId,
    isPending,
}: {
    id: string
    localId: string | null | undefined
    isPending: boolean
}): boolean {
    const hasServerEcho = localId ? id !== localId : true
    return hasServerEcho && !isPending
}

/**
 * Floating bar above the composer showing queued (pending invocation) messages.
 * Each item has an edit button (✎) and a cancel button (✕).
 *
 * Edit = client-side cancel + prefill composer with message text (Codex dialect).
 * Cancel = DELETE /sessions/:id/messages/:messageId with optimistic removal.
 */
export function QueuedMessagesBar({ sessionId, api }: { sessionId: string; api: ApiClient | null }) {
    const queued = useQueuedMessages(sessionId)
    const assistantApi = useAssistantApi()
    const cancelMutation = useCancelQueuedMessage(api)

    if (queued.length === 0) {
        return null
    }

    return (
        <div
            role="status"
            aria-label={`${queued.length} queued message${queued.length === 1 ? '' : 's'} pending invocation`}
            className="mx-auto w-full max-w-content mb-1"
        >
            <div className="px-3 py-2 text-sm text-[var(--app-fg-muted)]">
                <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-[var(--app-hint)]">
                    <ClockIcon />
                    <span>Queued</span>
                </div>
                <ul
                    className="flex flex-col gap-1.5 max-h-32 sm:max-h-48 overflow-y-auto"
                    aria-label="Queued messages"
                >
                    {queued.map((msg) => {
                        const text = getTextFromMessage(msg)
                        const localId = msg.localId ?? msg.id
                        const isPending = cancelMutation.isPending && cancelMutation.variables?.localId === localId
                        const canCancel = computeCanCancel({ id: msg.id, localId: msg.localId, isPending })

                        const handleCancel = () => {
                            if (!canCancel) return
                            cancelMutation.mutate({
                                sessionId,
                                messageId: msg.id,
                                localId,
                                snapshot: msg,
                            })
                        }

                        const handleEdit = () => {
                            if (!canCancel) return
                            // Edit = cancel + prefill composer (Codex dialect: no separate edit mode).
                            cancelMutation.mutate(
                                {
                                    sessionId,
                                    messageId: msg.id,
                                    localId,
                                    snapshot: msg,
                                },
                                {
                                    onSuccess: (result) => {
                                        // Race guard: if the agent already consumed this message, skip prefill.
                                        // The hook's own onSuccess already reverted the optimistic removal.
                                        if (result.status === 'invoked') return
                                        // Only prefill if text is available; attachment-only rows get empty string.
                                        const prefillText = text
                                        if (prefillText) {
                                            assistantApi.composer().setText(prefillText)
                                        }
                                    },
                                }
                            )
                        }

                        return (
                            <li
                                key={msg.localId ?? msg.id}
                                className="flex items-start gap-2 min-w-0 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
                            >
                                <span className="flex-1 line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)]">
                                    {text}
                                </span>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        aria-label="Edit queued message"
                                        disabled={!canCancel}
                                        onClick={handleEdit}
                                        onMouseDown={(e) => e.preventDefault()}
                                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        <svg
                                            viewBox="0 0 16 16"
                                            fill="none"
                                            className="h-3.5 w-3.5"
                                            aria-hidden="true"
                                        >
                                            <path
                                                d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H3v-2L11.5 2.5Z"
                                                stroke="currentColor"
                                                strokeWidth="1.4"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            />
                                        </svg>
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Cancel queued message"
                                        disabled={!canCancel}
                                        onClick={handleCancel}
                                        onMouseDown={(e) => e.preventDefault()}
                                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        <svg
                                            viewBox="0 0 16 16"
                                            fill="none"
                                            className="h-3.5 w-3.5"
                                            aria-hidden="true"
                                        >
                                            <path
                                                d="M4 4l8 8M12 4l-8 8"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                            />
                                        </svg>
                                    </button>
                                </div>
                            </li>
                        )
                    })}
                </ul>
            </div>
        </div>
    )
}
