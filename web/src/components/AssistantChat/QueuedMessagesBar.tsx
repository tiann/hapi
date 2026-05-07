import { useAssistantApi } from '@assistant-ui/react'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'

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
 * Orders queued messages so the floating bar reads top-down as a single timeline:
 *   1. Immediate-queued messages first, in the order they were submitted.
 *   2. Scheduled messages after, ordered by their fire time (soonest first).
 *
 * Without this the bar follows insertion order, which mixes immediate and
 * scheduled rows arbitrarily and makes the "what fires next" question
 * harder to answer at a glance.
 *
 * @internal Exported for unit testing.
 */
export function sortQueuedMessages(msgs: DecryptedMessage[]): DecryptedMessage[] {
    return [...msgs].sort((a, b) => {
        const aSched = a.scheduledAt != null
        const bSched = b.scheduledAt != null
        if (aSched !== bSched) return aSched ? 1 : -1
        // Both scheduledAt values are non-null here (aSched && bSched is true above).
        if (aSched && bSched) return a.scheduledAt! - b.scheduledAt!
        return (a.createdAt ?? 0) - (b.createdAt ?? 0)
    })
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
    // useSyncExternalStore guarantees a stable reference when the snapshot is
    // unchanged, so [state] as the dependency avoids unnecessary re-sorts.
    return useMemo(() => {
        const allMessages = [...state.messages, ...state.pending]
        return sortQueuedMessages(allMessages.filter(isQueuedForInvocation))
    }, [state])
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
 * Computes the PendingSchedule to restore when editing a queued message.
 *
 * - If the message has a future scheduledAt, return { type: 'absolute', ms } so the
 *   user can re-send with the same specific time (or adjust it).
 * - If scheduledAt is null, undefined, or in the past (message already matured),
 *   return null so the re-sent message goes out immediately.
 *
 * @internal Exported for unit testing.
 */
export function computeEditPendingSchedule(
    scheduledAt: number | null | undefined,
    now: number
): PendingSchedule | null {
    if (scheduledAt == null || scheduledAt <= now) return null
    return { type: 'absolute', ms: scheduledAt }
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
/** @internal Exported for unit testing. */
export function formatScheduledTime(scheduledAt: number): string {
    const date = new Date(scheduledAt)
    const now = new Date()
    const opts: Intl.DateTimeFormatOptions = {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }
    if (date.getFullYear() !== now.getFullYear()) {
        opts.year = 'numeric'
    }
    return date.toLocaleString(undefined, opts)
}

export function QueuedMessagesBar({
    sessionId,
    api,
    onEdit,
}: {
    sessionId: string
    api: ApiClient | null
    /**
     * Called when the user clicks Edit on a queued message.
     * The parent should restore `text` into the composer and `pendingSchedule` into the schedule state.
     * Edit is always cancel + prefill, regardless of whether the message is scheduled or immediate.
     */
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
}) {
    const queued = useQueuedMessages(sessionId)
    const assistantApi = useAssistantApi()
    const cancelMutation = useCancelQueuedMessage(api)
    const { t } = useTranslation()
    const { addToast } = useToast()

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
                            // Edit = cancel + restore composer (text + schedule).
                            // Works the same for immediate-queued and future-scheduled messages.
                            const restoredPendingSchedule = computeEditPendingSchedule(msg.scheduledAt, Date.now())

                            cancelMutation.mutate(
                                {
                                    sessionId,
                                    messageId: msg.id,
                                    localId,
                                    snapshot: msg,
                                },
                                {
                                    onSuccess: (result) => {
                                        // Race guard: if the agent already consumed this message, skip prefill
                                        // and inform the user so they aren't confused by the row disappearing.
                                        if (result.status === 'invoked') {
                                            addToast({
                                                title: t('queuedMessages.editAlreadyInvoked'),
                                                body: '',
                                                sessionId,
                                                url: window.location.href,
                                            })
                                            return
                                        }
                                        // Restore text into composer
                                        if (text) {
                                            assistantApi.composer().setText(text)
                                        }
                                        // Restore schedule via parent callback (if provided)
                                        onEdit?.({ text, pendingSchedule: restoredPendingSchedule })
                                    },
                                }
                            )
                        }

                        const canEdit = canCancel

                        return (
                            <li
                                key={msg.localId ?? msg.id}
                                className="flex items-start gap-2 min-w-0 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
                            >
                                <div className="flex-1 min-w-0">
                                    <span className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)]">
                                        {text}
                                    </span>
                                    {msg.scheduledAt != null && msg.scheduledAt > Date.now() && (
                                        <div className="mt-1 flex items-center gap-1 text-xs text-[var(--app-hint)]">
                                            <ClockIcon />
                                            <span>
                                                {t('queuedMessages.scheduledFor', { time: formatScheduledTime(msg.scheduledAt) })}
                                            </span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        aria-label="Edit queued message"
                                        disabled={!canEdit}
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
