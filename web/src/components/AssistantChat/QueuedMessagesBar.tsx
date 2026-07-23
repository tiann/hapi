import { useAssistantApi } from '@assistant-ui/react'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useSteerQueuedMessage } from '@/hooks/mutations/useSteerQueuedMessage'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { isSteeringSupportedForSession } from '@hapi/protocol'
import { formatScheduledTime } from '@/lib/scheduledTime'

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

/** Inject-into-stream glyph: mid-turn soft steer (icon-only; label via title/aria). */
function SteerIcon() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            className="h-3.5 w-3.5"
            aria-hidden="true"
        >
            <path
                d="M3 12h10"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
            />
            <path
                d="M5 3v5.5L9 12"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M7.5 10.5 9 12l1.5-1.5"
                stroke="currentColor"
                strokeWidth="1.4"
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

/** @internal Exported for unit testing. */
export function getQueuedMessagePreview(msg: DecryptedMessage): { text: string; attachmentNames: string[] } {
    const normalized = normalizeDecryptedMessage(msg)
    if (!normalized || normalized.role !== 'user') {
        return { text: '', attachmentNames: [] }
    }
    const text = (normalized.content.text ?? '').trim()
    const attachments = normalized.content.attachments ?? []
    return {
        text,
        attachmentNames: attachments.map((a) => a.filename ?? 'attachment'),
    }
}

/** @internal Exported for unit testing. */
export function getQueuedMessageEditText(preview: { text: string; attachmentNames: string[] }): string {
    return preview.text || preview.attachmentNames.join(', ')
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
 * Each item has edit, optional Steer (when the agent supports mid-turn delivery),
 * and cancel.
 *
 * Edit = client-side cancel + prefill composer with message text.
 * Steer = soft mid-turn delivery now (Codex turn/steer / Cursor ACP soft-send).
 * Cancel = DELETE /sessions/:id/messages/:messageId with optimistic removal.
 */
export function QueuedMessagesBar({
    sessionId,
    api,
    sessionMetadata,
    isThinking,
    onEdit,
}: {
    sessionId: string
    api: ApiClient | null
    /** Session metadata — gates the Steer button (flavor + Cursor protocol). */
    sessionMetadata?: {
        flavor?: string | null
        cursorSessionId?: string | null
        cursorSessionProtocol?: 'acp' | 'stream-json' | null
    } | null
    /** True while an agent turn is in flight. */
    isThinking?: boolean
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
    const steerMutation = useSteerQueuedMessage(api)
    const { t } = useTranslation()
    const { addToast } = useToast()
    const steeringSupported = isSteeringSupportedForSession(sessionMetadata)

    if (queued.length === 0) {
        return null
    }

    return (
        <div
            role="status"
            aria-label={t('queuedMessages.pendingAriaLabel', { count: queued.length })}
            className="mx-auto w-full max-w-content mb-1"
        >
            <div className="px-3 py-2 text-sm text-[var(--app-fg-muted)]">
                <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-[var(--app-hint)]">
                    <ClockIcon />
                    <span>{t('queuedMessages.title')}</span>
                </div>
                <ul
                    className="flex flex-col gap-1.5 max-h-32 sm:max-h-48 overflow-y-auto"
                    aria-label={t('queuedMessages.listAriaLabel')}
                >
                    {queued.map((msg) => {
                        const preview = getQueuedMessagePreview(msg)
                        const { text, attachmentNames } = preview
                        const editText = getQueuedMessageEditText(preview)
                        const hasAttachments = attachmentNames.length > 0
                        const localId = msg.localId ?? msg.id
                        const isCancelPending = cancelMutation.isPending && cancelMutation.variables?.localId === localId
                        const isSteerPending = steerMutation.isPending && steerMutation.variables?.localId === localId
                        const canCancel = computeCanCancel({
                            id: msg.id,
                            localId: msg.localId,
                            isPending: isCancelPending || isSteerPending,
                        })
                        const isFutureScheduled = msg.scheduledAt != null && msg.scheduledAt > Date.now()
                        const canSteer = steeringSupported
                            && Boolean(isThinking)
                            && !isFutureScheduled
                            && canCancel

                        const handleCancel = () => {
                            if (!canCancel) return
                            cancelMutation.mutate({
                                sessionId,
                                messageId: msg.id,
                                localId,
                                snapshot: msg,
                            })
                        }

                        const handleSteer = () => {
                            if (!canSteer) return
                            steerMutation.mutate({
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
                                        if (editText) {
                                            assistantApi.composer().setText(editText)
                                        }
                                        // Restore schedule via parent callback (if provided)
                                        onEdit?.({ text: editText, pendingSchedule: restoredPendingSchedule })
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
                                    {text ? (
                                        <span className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)]">
                                            {text}
                                        </span>
                                    ) : null}
                                    {hasAttachments ? (
                                        <div className={text ? 'mt-1 flex flex-wrap gap-1' : 'flex flex-wrap gap-1'}>
                                            {attachmentNames.map((name, index) => (
                                                <span
                                                    key={`${name}-${index}`}
                                                    className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--app-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
                                                    title={name}
                                                >
                                                    <span aria-hidden="true">📎</span>
                                                    <span className="truncate">{name}</span>
                                                </span>
                                            ))}
                                        </div>
                                    ) : null}
                                    {isFutureScheduled && (
                                        <div className="mt-1 flex items-center gap-1 text-xs text-[var(--app-hint)]">
                                            <ClockIcon />
                                            <span>
                                                {t('queuedMessages.scheduledFor', { time: formatScheduledTime(msg.scheduledAt!) })}
                                            </span>
                                        </div>
                                    )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        aria-label={t('queuedMessages.edit')}
                                        title={t('queuedMessages.edit')}
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
                                    {steeringSupported && (
                                        <button
                                            type="button"
                                            aria-label={t('queuedMessages.steerNow')}
                                            title={t('queuedMessages.steerNow')}
                                            disabled={!canSteer}
                                            onClick={handleSteer}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className="flex h-6 items-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            {isSteerPending ? (
                                                <span className="flex h-6 w-6 items-center justify-center text-xs" aria-hidden="true">…</span>
                                            ) : (
                                                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                                                    <SteerIcon />
                                                </span>
                                            )}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        aria-label={t('queuedMessages.cancel')}
                                        title={t('queuedMessages.cancel')}
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
