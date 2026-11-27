import { useState } from 'react'
import type { CreateSessionTaskRequest } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import {
    buildQueueRequest,
    buildRepeatRequest,
    queueDraftItems,
    queueUsesComposer,
    readIntervalMs,
    type QueueTaskDraft,
    type RepeatTaskDraft
} from '@/lib/sessionTasks'
import {
    FirstRunField,
    IntervalField,
    PRIMARY_BUTTON_CLASS,
    QueueEditor,
    QueueHints,
    RunLimitField,
    TaskFormError,
    TaskPromptTextarea,
    useMountedFlag,
    type TaskFailure
} from './SessionTaskFields'

/** What the composer panel hands a form so it can create a task. */
export type CreateTaskFromForm = (
    request: CreateSessionTaskRequest,
    /** The composer text that became the task; it is cleared from the composer once the task exists. */
    consumed?: { composerText: string }
) => Promise<void>

/**
 * The composer clock panel's Repeat and Queue modes. Each form builds its
 * request locally so a mistake is shown inline, then hands a valid one to
 * `createTask`. A create that completes after the form is gone (the panel
 * closed) still consumes the composer text it used, but touches nothing else.
 */
export function RepeatTaskForm({ draft, onDraftChange, composerDraft, createTask, onCreated }: {
    draft: RepeatTaskDraft
    onDraftChange: (next: RepeatTaskDraft) => void
    /** The composer's text; it is the message until the user types their own. */
    composerDraft: string
    createTask: CreateTaskFromForm
    /** Called once the task exists, while the form is still on screen. */
    onCreated: () => void
}) {
    const { t } = useTranslation()
    const [failure, setFailure] = useState<TaskFailure | null>(null)
    const [busy, setBusy] = useState(false)
    const mounted = useMountedFlag()
    const update = (patch: Partial<RepeatTaskDraft>) => {
        setFailure(null)
        onDraftChange({ ...draft, ...patch })
    }

    const submit = async () => {
        const built = buildRepeatRequest(draft, composerDraft)
        if ('error' in built) {
            setFailure({ draft: built.error })
            return
        }
        setBusy(true)
        try {
            await createTask(built.request, built.fromComposer ? { composerText: composerDraft } : undefined)
        } catch (error) {
            if (mounted.current) {
                setBusy(false)
                setFailure({ request: error })
            }
            return
        }
        // The panel closed while the request was out: leave the composer and the drafts alone.
        if (!mounted.current) return
        setBusy(false)
        onCreated()
    }

    return (
        <div className="flex flex-col gap-2">
            <div>
                <label className="mb-1 block text-xs text-[var(--app-hint)]" htmlFor="repeat-task-message">{t('composer.taskMessage')}</label>
                <TaskPromptTextarea
                    id="repeat-task-message"
                    rows={3}
                    value={draft.text}
                    placeholder={composerDraft.trim() ? composerDraft : t('composer.taskMessagePlaceholder')}
                    disabled={busy}
                    onSubmit={() => { void submit() }}
                    onChange={(text) => update({ text })}
                />
            </div>
            <IntervalField id="repeat-task-interval" value={draft.interval} onChange={(interval) => update({ interval })} disabled={busy} />
            <p className="text-xs text-[var(--app-hint)]">{t('composer.taskHintSkip')}</p>
            <FirstRunField id="repeat-task-first-run" value={draft.firstRunAt} onChange={(firstRunAt) => update({ firstRunAt })} disabled={busy} />
            <RunLimitField id="repeat-task-runs" value={draft.stopAfterRuns} onChange={(stopAfterRuns) => update({ stopAfterRuns })} disabled={busy} />
            <TaskFormError failure={failure} fallbackKey="composer.taskCreateFailed" />
            <button
                type="button"
                disabled={busy}
                onClick={() => { void submit() }}
                className={PRIMARY_BUTTON_CLASS}
            >
                {t('composer.taskCreateRepeat')}
            </button>
        </div>
    )
}

export function QueueTaskForm({ draft, onDraftChange, composerDraft, createTask, onCreated }: {
    draft: QueueTaskDraft
    onDraftChange: (next: QueueTaskDraft) => void
    /** The composer's text; it is the first prompt until the user types one. */
    composerDraft: string
    createTask: CreateTaskFromForm
    /** Called once the task exists, while the form is still on screen. */
    onCreated: () => void
}) {
    const { t } = useTranslation()
    const [failure, setFailure] = useState<TaskFailure | null>(null)
    const [busy, setBusy] = useState(false)
    const mounted = useMountedFlag()
    const update = (patch: Partial<QueueTaskDraft>) => {
        setFailure(null)
        onDraftChange({ ...draft, ...patch })
    }
    const intervalMs = readIntervalMs(draft.interval)

    const submit = async () => {
        const built = buildQueueRequest(draft, composerDraft)
        if ('error' in built) {
            setFailure({ draft: built.error })
            return
        }
        setBusy(true)
        try {
            await createTask(built.request, built.fromComposer ? { composerText: composerDraft } : undefined)
        } catch (error) {
            if (mounted.current) {
                setBusy(false)
                setFailure({ request: error })
            }
            return
        }
        if (!mounted.current) return
        setBusy(false)
        onCreated()
    }

    return (
        <div className="flex flex-col gap-2">
            <QueueEditor
                idPrefix="queue-task-prompt"
                items={draft.items}
                firstPlaceholder={queueUsesComposer(draft, composerDraft) ? composerDraft : undefined}
                firstPromptCount={queueDraftItems(draft, composerDraft).length}
                disabled={busy}
                onSubmit={() => { void submit() }}
                onChange={(items) => update({ items })}
            />
            <QueueHints intervalMs={intervalMs} />
            <IntervalField id="queue-task-interval" label="composer.taskGap" value={draft.interval} onChange={(interval) => update({ interval })} disabled={busy} />
            <FirstRunField id="queue-task-first-run" value={draft.firstRunAt} onChange={(firstRunAt) => update({ firstRunAt })} disabled={busy} />
            <p className="text-xs text-[var(--app-hint)]">{t('composer.taskHintWake')}</p>
            <TaskFormError failure={failure} fallbackKey="composer.taskCreateFailed" />
            <button
                type="button"
                disabled={busy}
                onClick={() => { void submit() }}
                className={PRIMARY_BUTTON_CLASS}
            >
                {t('composer.taskCreateQueue')}
            </button>
        </div>
    )
}
