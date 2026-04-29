import { useCallback, useSyncExternalStore } from 'react'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'

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
 * Floating bar above the composer showing queued (pending invocation) messages.
 * Disappears automatically when all queued messages are invoked or consumed.
 *
 * TODO PR 2: add cancel/edit buttons per item.
 */
export function QueuedMessagesBar({ sessionId }: { sessionId: string }) {
    const queued = useQueuedMessages(sessionId)

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
                        return (
                            <li
                                key={msg.localId ?? msg.id}
                                className="flex items-start gap-2 min-w-0 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
                            >
                                <span className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)]">{text}</span>
                                {/* TODO PR 2: cancel/edit buttons */}
                            </li>
                        )
                    })}
                </ul>
            </div>
        </div>
    )
}
