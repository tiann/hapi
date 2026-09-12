import { useAui, useAuiState } from '@assistant-ui/react'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useSteerQueuedMessage } from '@/hooks/mutations/useSteerQueuedMessage'
import { useRetryIndeterminateMessage } from '@/hooks/mutations/useRetryIndeterminateMessage'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { formatScheduledTime } from '@/lib/scheduledTime'
import {
    beginQueuedOperation,
    clearQueuedEditRecovery,
    endQueuedOperation,
    getQueuedEditRecovery,
    isQueuedOperationPending,
    saveQueuedEditRecovery,
    subscribeQueuedEditRecovery,
    subscribeQueuedOperation,
} from '@/lib/queued-edit-recovery'

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

function SteerIcon() {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            className="h-3.5 w-3.5"
            aria-hidden="true"
        >
            <path
                d="M9.5 1 3 9h3.8L6 15l6.5-8H8.7L9.5 1Z"
                stroke="currentColor"
                strokeWidth="1.2"
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
        return sortQueuedMessages(state.messages.filter(isQueuedForInvocation))
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

function pendingSchedulesEqual(a: PendingSchedule | null, b: PendingSchedule | null): boolean {
    if (a === b) return true
    if (a === null || b === null) return false
    switch (a.type) {
        case 'preset':
            return b.type === 'preset' && a.preset === b.preset
        case 'absolute':
            return b.type === 'absolute' && a.ms === b.ms
    }
    const exhaustive: never = a
    return exhaustive
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
export function QueuedMessagesBar({
    sessionId,
    api,
    pendingSchedule,
    pendingScheduleRevision,
    onEdit,
    canSteer,
}: {
    sessionId: string
    api: ApiClient | null
    /** Current composer schedule, used only to guard an asynchronous edit restore. */
    pendingSchedule: PendingSchedule | null
    /** Monotonic per-session revision; schedule selections win over an async edit restore. */
    pendingScheduleRevision: number
    /**
     * Called when the user clicks Edit on a queued message.
     * The parent should restore `text` into the composer and `pendingSchedule` into the schedule state.
     * Edit is always cancel + prefill, regardless of whether the message is scheduled or immediate.
     */
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
    /**
     * When true, each queued row gets a Steer button that delivers that
     * message into the active turn (Pi native steer). The parent computes it
     * as: pi flavor && session thinking && remote-controlled.
     */
    canSteer?: boolean
}) {
    const queued = useQueuedMessages(sessionId)
    const assistantApi = useAui()
    const composerText = useAuiState((state) => state.composer.text)
    const cancelMutation = useCancelQueuedMessage(api)
    const steerMutation = useSteerQueuedMessage(api)
    const retryMutation = useRetryIndeterminateMessage(api)
    const { t } = useTranslation()
    const { addToast } = useToast()
    const pendingScheduleRef = useRef(pendingSchedule)
    const pendingScheduleRevisionRef = useRef(pendingScheduleRevision)
    const composerTextRef = useRef(composerText)
    const onEditRef = useRef(onEdit)
    const mountedRef = useRef(true)
    const attemptedRecoveryIdsRef = useRef(new Set<string>())
    // onSuccess runs after the cancel request completes, so it must read the
    // newest schedule rather than the render that initiated the request.
    pendingScheduleRef.current = pendingSchedule
    pendingScheduleRevisionRef.current = pendingScheduleRevision
    composerTextRef.current = composerText
    onEditRef.current = onEdit

    const queuedOperationPending = useSyncExternalStore(
        useCallback((listener) => subscribeQueuedOperation(sessionId, listener), [sessionId]),
        useCallback(() => isQueuedOperationPending(sessionId), [sessionId]),
        () => false,
    )

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const restoreQueuedEditRecovery = useCallback(() => {
        const recovery = getQueuedEditRecovery(sessionId)
        if (!recovery || attemptedRecoveryIdsRef.current.has(recovery.id)) return
        attemptedRecoveryIdsRef.current.add(recovery.id)

        const currentText = assistantApi.composer().getState().text
        // A new session starts at revision 0. Any schedule interaction, even
        // select-then-clear back to null, increments it and wins over recovery.
        const textCompatible = currentText === recovery.composerTextAtEdit
        const scheduleCompatible = pendingScheduleRevisionRef.current === 0
        if (!textCompatible || !scheduleCompatible) {
            if (mountedRef.current) {
                addToast({
                    title: t('queuedMessages.editCurrentDraftKept'),
                    body: '',
                    sessionId,
                    url: window.location.href,
                })
            }
            clearQueuedEditRecovery(sessionId)
            return
        }

        if (recovery.text) {
            assistantApi.composer().setText(recovery.text)
        }
        onEditRef.current?.({ text: recovery.text, pendingSchedule: recovery.pendingSchedule })
        clearQueuedEditRecovery(sessionId)
    }, [addToast, assistantApi, sessionId, t])

    useEffect(() => {
        let disposed = false
        let generation = 0
        const scheduledHandles = new Set<number>()
        const scheduleFrame = (callback: FrameRequestCallback): number => {
            if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
            return window.setTimeout(() => callback(Date.now()), 0)
        }
        const cancelFrame = (handle: number): void => {
            if (typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(handle)
            } else {
                window.clearTimeout(handle)
            }
        }
        const attemptAfterComposerDraft = () => {
            const attemptGeneration = ++generation
            const scheduleAttemptFrame = (callback: FrameRequestCallback) => {
                let handle = 0
                handle = scheduleFrame((timestamp) => {
                    scheduledHandles.delete(handle)
                    if (disposed || attemptGeneration !== generation) return
                    callback(timestamp)
                })
                scheduledHandles.add(handle)
            }
            scheduleAttemptFrame(() => {
                scheduleAttemptFrame(restoreQueuedEditRecovery)
            })
        }
        attemptAfterComposerDraft()
        const unsubscribe = subscribeQueuedEditRecovery(sessionId, attemptAfterComposerDraft)
        return () => {
            disposed = true
            generation++
            unsubscribe()
            for (const handle of scheduledHandles) {
                cancelFrame(handle)
            }
            scheduledHandles.clear()
        }
    }, [restoreQueuedEditRecovery, sessionId])

    if (queued.length === 0) {
        return null
    }

    return (
        <div
            role="status"
            aria-label={`${queued.length} queued message${queued.length === 1 ? '' : 's'} pending invocation`}
            className="mx-auto w-full max-w-content"
        >
            <div className="px-3 pb-0 pt-2 text-sm text-[var(--app-fg-muted)]">
                <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-[var(--app-hint)]">
                    <ClockIcon />
                    <span>Queued</span>
                </div>
                <ul
                    className="flex flex-col gap-1.5 max-h-32 sm:max-h-48 overflow-y-auto"
                    aria-label="Queued messages"
                >
                    {queued.map((msg) => {
                        const preview = getQueuedMessagePreview(msg)
                        const { text, attachmentNames } = preview
                        const editText = getQueuedMessageEditText(preview)
                        const hasAttachments = attachmentNames.length > 0
                        const localId = msg.localId ?? msg.id
                        const isPending = cancelMutation.isPending || queuedOperationPending
                        const canCancel = computeCanCancel({ id: msg.id, localId: msg.localId, isPending })

                        const handleCancel = () => {
                            if (!canCancel) return
                            const token = beginQueuedOperation(sessionId)
                            if (!token) return
                            void cancelMutation.mutateAsync({
                                sessionId,
                                messageId: msg.id,
                                localId,
                                snapshot: msg,
                            }).catch(() => {
                                // useCancelQueuedMessage restores the optimistic row and gives haptic feedback.
                            }).finally(() => {
                                endQueuedOperation(sessionId, token)
                            })
                        }

                        // Steer delivers this message into the active Pi turn. Gated
                        // on the same server-echo + no-pending-op conditions as
                        // Edit/Cancel, and never offered for future-scheduled rows
                        // (the hub rejects those).
                        const canSteerRow = Boolean(
                            canSteer
                            && msg.deliveryState !== 'indeterminate'
                            && msg.scheduledAt == null
                            && canCancel
                        )
                        const steerPending = steerMutation.isPending
                            && steerMutation.variables?.messageId === msg.id
                        const handleSteer = () => {
                            if (!canSteerRow) return
                            const token = beginQueuedOperation(sessionId)
                            if (!token) return
                            void steerMutation.mutateAsync({
                                sessionId,
                                messageId: msg.id,
                            }).catch(() => {
                                // useSteerQueuedMessage already toasts the failure.
                            }).finally(() => {
                                endQueuedOperation(sessionId, token)
                            })
                        }

                        const retryPending = retryMutation.isPending
                            && retryMutation.variables?.messageId === msg.id
                        const handleRetry = () => {
                            if (msg.deliveryState !== 'indeterminate' || !canCancel) return
                            const token = beginQueuedOperation(sessionId)
                            if (!token) return
                            void retryMutation.mutateAsync({
                                sessionId,
                                messageId: msg.id,
                            }).catch(() => {
                                // The row remains held if the explicit retry fails.
                            }).finally(() => {
                                endQueuedOperation(sessionId, token)
                            })
                        }

                        const handleEdit = async () => {
                            if (!canCancel) return
                            // Edit = cancel + restore composer (text + schedule).
                            // Works the same for immediate-queued and future-scheduled messages.
                            const restoredPendingSchedule = computeEditPendingSchedule(msg.scheduledAt, Date.now())
                            // The cancel request is asynchronous. Keep the exact composer text from the
                            // click so a newer draft or schedule is never replaced when success arrives.
                            const composerTextAtEdit = assistantApi.composer().getState().text
                            const pendingScheduleAtEdit = pendingScheduleRef.current
                            const pendingScheduleRevisionAtEdit = pendingScheduleRevisionRef.current
                            const token = beginQueuedOperation(sessionId)
                            if (!token) return

                            try {
                                const result = await cancelMutation.mutateAsync({
                                    sessionId,
                                    messageId: msg.id,
                                    localId,
                                    snapshot: msg,
                                })
                                // Race guard: if the agent already consumed this message, skip prefill
                                // and inform the user so they aren't confused by the row disappearing.
                                // A 'busy' cancel means the row is inside an async steer — it was
                                // NOT cancelled, so never prefill (the instruction may still be
                                // delivered; prefilling invites a duplicate send).
                                if (result.status === 'busy') {
                                    return
                                }
                                if (result.status === 'invoked') {
                                    if (mountedRef.current) {
                                        addToast({
                                            title: t('queuedMessages.editAlreadyInvoked'),
                                            body: '',
                                            sessionId,
                                            url: window.location.href,
                                        })
                                    }
                                    return
                                }

                                const currentText = mountedRef.current
                                    ? assistantApi.composer().getState().text
                                    : composerTextRef.current
                                const composerChanged = currentText !== composerTextAtEdit
                                const scheduleChanged = pendingScheduleRevisionRef.current !== pendingScheduleRevisionAtEdit
                                    || !pendingSchedulesEqual(pendingScheduleRef.current, pendingScheduleAtEdit)
                                // Restore text and schedule as one unit. If either changed while the
                                // cancel was pending, the user's newer composer state wins.
                                if (composerChanged || scheduleChanged) {
                                    if (mountedRef.current) {
                                        addToast({
                                            title: t('queuedMessages.editCurrentDraftKept'),
                                            body: '',
                                            sessionId,
                                            url: window.location.href,
                                        })
                                    }
                                    return
                                }
                                if (!mountedRef.current) {
                                    // The original composer is gone. Persist both values and notify a
                                    // same-session remount so the result is not lost or delayed until a
                                    // later navigation cycle.
                                    saveQueuedEditRecovery(sessionId, {
                                        text: editText,
                                        pendingSchedule: restoredPendingSchedule,
                                        composerTextAtEdit,
                                        pendingScheduleAtEdit,
                                    })
                                    return
                                }
                                if (editText) {
                                    assistantApi.composer().setText(editText)
                                }
                                onEdit?.({ text: editText, pendingSchedule: restoredPendingSchedule })
                            } catch {
                                // useCancelQueuedMessage restores the optimistic row and gives haptic feedback.
                            } finally {
                                endQueuedOperation(sessionId, token)
                            }
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
                                    {msg.deliveryState === 'indeterminate' ? (
                                        <div className="mt-1 text-xs text-[var(--app-warning-text)]">
                                            {t('queuedMessages.steerOutcomeUnknown')}
                                        </div>
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
                                    {msg.deliveryState === 'indeterminate' ? (
                                        <button
                                            type="button"
                                            aria-label={t('queuedMessages.retryOutcome')}
                                            title={t('queuedMessages.retryOutcome')}
                                            disabled={!canCancel || retryPending}
                                            onClick={handleRetry}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            <span aria-hidden="true">↻</span>
                                        </button>
                                    ) : null}
                                    {canSteerRow ? (
                                        <button
                                            type="button"
                                            aria-label="Steer queued message"
                                            title={t('queuedMessages.steer')}
                                            disabled={steerPending}
                                            onClick={handleSteer}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className="flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            <SteerIcon />
                                        </button>
                                    ) : null}
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
