import { useEffect, useRef, useState } from 'react'
import type { SessionTask, UpdateSessionTaskRequest } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import {
    buildQueueEditRequest,
    buildRepeatEditRequest,
    readIntervalMs,
    taskToDraft,
    type QueueTaskDraft,
    type RepeatTaskDraft
} from '@/lib/sessionTasks'
import {
    IntervalField,
    PRIMARY_BUTTON_CLASS,
    QueueEditor,
    QueueHints,
    RunLimitField,
    SECONDARY_BUTTON_CLASS,
    TaskFormError,
    TaskPromptTextarea,
    useMountedFlag,
    type TaskFailure
} from './SessionTaskFields'

/**
 * The row's task, editable in place: the same fields as the composer panel's
 * form, under the row instead of in the clock panel. A repeat task's message,
 * interval and run limit; a queue's prompts still to send and its gap. Only
 * what changed is sent.
 */
export function SessionTaskInlineEditor({ task, save, onCancel }: {
    task: SessionTask
    /** Sends the change; resolves once the hub accepted it. */
    save: (request: UpdateSessionTaskRequest) => Promise<void>
    /** `returnFocus` is true when the keyboard was inside the editor, so focus goes back to the Edit button. */
    onCancel: (returnFocus: boolean) => void
}) {
    const { t } = useTranslation()
    const [draft, setDraft] = useState<RepeatTaskDraft | QueueTaskDraft>(() => taskToDraft(task))
    const [failure, setFailure] = useState<TaskFailure | null>(null)
    const [busy, setBusy] = useState(false)
    const mounted = useMountedFlag()
    const rootRef = useRef<HTMLDivElement | null>(null)
    // Keyboard users come in from the Edit button; a finger did not open a keyboard to begin with.
    useEffect(() => {
        if (!window.matchMedia('(pointer: fine)').matches) return
        rootRef.current?.querySelector<HTMLElement>('textarea, input')?.focus()
    }, [])
    const hadFocus = () => {
        const root = rootRef.current
        return root !== null && document.activeElement !== null && root.contains(document.activeElement)
    }
    const cancel = () => onCancel(hadFocus())
    const id = `task-edit-${task.id}`
    const isRepeat = 'text' in draft
    const built = isRepeat
        ? buildRepeatEditRequest(task, draft)
        : buildQueueEditRequest(task, draft)
    const update = (patch: Partial<RepeatTaskDraft> | Partial<QueueTaskDraft>) => {
        setFailure(null)
        setDraft((previous) => ({ ...previous, ...patch }))
    }

    const submit = async () => {
        if ('error' in built) {
            setFailure({ draft: built.error, sent: task.runCount })
            return
        }
        if (!built.changed) {
            onCancel(false)
            return
        }
        setBusy(true)
        setFailure(null)
        try {
            await save(built.request)
        } catch (error) {
            if (mounted.current) {
                setBusy(false)
                setFailure({ request: error })
            }
        }
    }

    return (
        <div
            ref={rootRef}
            className="mt-2 flex flex-col gap-2 border-t border-[var(--app-border)] pt-2"
            role="group"
            aria-label={t('tasks.edit')}
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                event.stopPropagation()
                cancel()
            }}
        >
            {isRepeat ? (
                <>
                    <div>
                        <label className="mb-1 block text-xs text-[var(--app-hint)]" htmlFor={`${id}-message`}>{t('composer.taskMessage')}</label>
                        <TaskPromptTextarea
                            id={`${id}-message`}
                            value={draft.text}
                            disabled={busy}
                            onSubmit={() => { void submit() }}
                            onChange={(text) => update({ text })}
                        />
                    </div>
                    <IntervalField id={`${id}-interval`} value={draft.interval} onChange={(interval) => update({ interval })} disabled={busy} />
                    <p className="text-xs text-[var(--app-hint)]">{t('composer.taskHintSkip')}</p>
                    <RunLimitField id={`${id}-runs`} value={draft.stopAfterRuns} onChange={(stopAfterRuns) => update({ stopAfterRuns })} disabled={busy} />
                </>
            ) : (
                <>
                    <QueueEditor
                        idPrefix={`${id}-prompt`}
                        items={draft.items}
                        firstPromptCount={draft.items.filter((item) => item.trim().length > 0).length}
                        disabled={busy}
                        onSubmit={() => { void submit() }}
                        onChange={(items) => update({ items })}
                    />
                    <QueueHints intervalMs={readIntervalMs(draft.interval)} />
                    <IntervalField id={`${id}-interval`} label="composer.taskGap" value={draft.interval} onChange={(interval) => update({ interval })} disabled={busy} />
                </>
            )}
            <p className="text-xs text-[var(--app-hint)]">{t('composer.taskHintWake')}</p>
            <TaskFormError failure={failure} fallbackKey="composer.taskEditFailed" />
            <div className="flex gap-2">
                <button
                    type="button"
                    disabled={busy || (!('error' in built) && !built.changed)}
                    onClick={() => { void submit() }}
                    className={`${PRIMARY_BUTTON_CLASS} flex-1`}
                >
                    {t('tasks.saveChanges')}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={cancel}
                    className={`${SECONDARY_BUTTON_CLASS} flex-1`}
                >
                    {t('tasks.cancelEdit')}
                </button>
            </div>
        </div>
    )
}
