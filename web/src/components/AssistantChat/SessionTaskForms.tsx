import { useState } from 'react'
import type { CreateSessionTaskRequest } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import {
    buildQueueRequest,
    buildRepeatRequest,
    minDateTimeLocal,
    parseQueuePrompts,
    SESSION_TASK_INTERVAL_UNITS,
    SESSION_TASK_MAX_PROMPTS,
    type IntervalInput,
    type QueueTaskDraft,
    type RepeatTaskDraft,
    type TaskDraftError
} from '@/lib/sessionTasks'

const FIELD_CLASS = 'w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]'
const LABEL_CLASS = 'mb-1 block text-xs text-[var(--app-hint)]'
const PRIMARY_BUTTON_CLASS = 'w-full rounded-lg bg-blue-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40'

const ERROR_KEY: Record<TaskDraftError | 'failed', string> = {
    interval: 'composer.taskErrorInterval',
    message: 'composer.taskErrorMessage',
    queue: 'composer.taskErrorQueue',
    tooMany: 'composer.taskErrorTooMany',
    firstRun: 'composer.taskErrorFirstRun',
    runs: 'composer.taskErrorRuns',
    failed: 'composer.taskCreateFailed'
}

function IntervalField({ value, onChange, disabled }: {
    value: IntervalInput
    onChange: (next: IntervalInput) => void
    disabled: boolean
}) {
    const { t } = useTranslation()
    const unitLabel: Record<typeof SESSION_TASK_INTERVAL_UNITS[number], string> = {
        minutes: t('composer.taskUnitMinutes'),
        hours: t('composer.taskUnitHours'),
        days: t('composer.taskUnitDays')
    }
    return (
        <div>
            <label className={LABEL_CLASS}>{t('composer.taskInterval')}</label>
            <div className="flex gap-2">
                <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    aria-label={t('composer.taskIntervalValue')}
                    value={value.value}
                    disabled={disabled}
                    onChange={(e) => onChange({ ...value, value: e.target.value })}
                    className={`${FIELD_CLASS} w-24`}
                />
                <select
                    aria-label={t('composer.taskIntervalUnit')}
                    value={value.unit}
                    disabled={disabled}
                    onChange={(e) => onChange({ ...value, unit: e.target.value as IntervalInput['unit'] })}
                    className={`${FIELD_CLASS} flex-1`}
                >
                    {SESSION_TASK_INTERVAL_UNITS.map((unit) => (
                        <option key={unit} value={unit}>{unitLabel[unit]}</option>
                    ))}
                </select>
            </div>
        </div>
    )
}

function FirstRunField({ value, onChange, disabled }: {
    /** '' runs now, a `datetime-local` value runs at that time. */
    value: string
    onChange: (next: string) => void
    disabled: boolean
}) {
    const { t } = useTranslation()
    const scheduled = value !== ''
    return (
        <div>
            <label className={LABEL_CLASS}>{t('composer.taskFirstRun')}</label>
            <div className="flex gap-1 mb-2">
                <button
                    type="button"
                    aria-pressed={!scheduled}
                    disabled={disabled}
                    onClick={() => onChange('')}
                    className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        !scheduled
                            ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                    }`}
                >
                    {t('composer.taskFirstRunNow')}
                </button>
                <button
                    type="button"
                    aria-pressed={scheduled}
                    disabled={disabled}
                    onClick={() => onChange(minDateTimeLocal())}
                    className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        scheduled
                            ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                    }`}
                >
                    {t('composer.taskFirstRunAt')}
                </button>
            </div>
            {scheduled ? (
                <input
                    type="datetime-local"
                    aria-label={t('composer.taskFirstRunAt')}
                    value={value}
                    min={minDateTimeLocal()}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value)}
                    className={FIELD_CLASS}
                />
            ) : null}
        </div>
    )
}

function TaskFormError({ error }: { error: TaskDraftError | 'failed' | null }) {
    const { t } = useTranslation()
    if (!error) return null
    return (
        <p role="alert" className="text-xs text-red-500">
            {t(ERROR_KEY[error], error === 'tooMany' ? { count: SESSION_TASK_MAX_PROMPTS } : undefined)}
        </p>
    )
}

/**
 * The composer clock panel's Repeat and Queue modes. Each form builds its
 * request locally so a mistake is shown inline, then hands a valid one to
 * `createTask`.
 */
export function RepeatTaskForm({ draft, onDraftChange, composerDraft, createTask, onCreated }: {
    draft: RepeatTaskDraft
    onDraftChange: (next: RepeatTaskDraft) => void
    /** The composer's text; it is the message until the user types their own. */
    composerDraft: string
    createTask: (request: CreateSessionTaskRequest) => Promise<void>
    /** Called after the task was created; the message came from the composer when `fromComposer`. */
    onCreated: (result: { fromComposer: boolean }) => void
}) {
    const { t } = useTranslation()
    const [error, setError] = useState<TaskDraftError | 'failed' | null>(null)
    const [busy, setBusy] = useState(false)
    const update = (patch: Partial<RepeatTaskDraft>) => {
        setError(null)
        onDraftChange({ ...draft, ...patch })
    }

    const submit = async () => {
        const built = buildRepeatRequest(draft, composerDraft)
        if ('error' in built) {
            setError(built.error)
            return
        }
        setBusy(true)
        try {
            await createTask(built.request)
        } catch {
            setBusy(false)
            setError('failed')
            return
        }
        setBusy(false)
        onCreated({ fromComposer: built.fromComposer })
    }

    return (
        <div className="flex flex-col gap-2">
            <div>
                <label className={LABEL_CLASS} htmlFor="repeat-task-message">{t('composer.taskMessage')}</label>
                <textarea
                    id="repeat-task-message"
                    rows={3}
                    value={draft.text}
                    placeholder={composerDraft.trim() ? composerDraft : t('composer.taskMessagePlaceholder')}
                    disabled={busy}
                    onChange={(e) => update({ text: e.target.value })}
                    className={`${FIELD_CLASS} resize-y`}
                />
            </div>
            <IntervalField value={draft.interval} onChange={(interval) => update({ interval })} disabled={busy} />
            <FirstRunField value={draft.firstRunAt} onChange={(firstRunAt) => update({ firstRunAt })} disabled={busy} />
            <div>
                <label className={LABEL_CLASS} htmlFor="repeat-task-runs">{t('composer.taskStopAfter')}</label>
                <div className="flex items-baseline gap-2">
                    <input
                        id="repeat-task-runs"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        value={draft.stopAfterRuns}
                        disabled={busy}
                        onChange={(e) => update({ stopAfterRuns: e.target.value })}
                        className={`${FIELD_CLASS} w-24`}
                    />
                    <span className="text-xs text-[var(--app-hint)]">{t('composer.taskStopAfterHint')}</span>
                </div>
            </div>
            <TaskFormError error={error} />
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

export function QueueTaskForm({ draft, onDraftChange, createTask, onCreated }: {
    draft: QueueTaskDraft
    onDraftChange: (next: QueueTaskDraft) => void
    createTask: (request: CreateSessionTaskRequest) => Promise<void>
    onCreated: () => void
}) {
    const { t } = useTranslation()
    const [error, setError] = useState<TaskDraftError | 'failed' | null>(null)
    const [busy, setBusy] = useState(false)
    const update = (patch: Partial<QueueTaskDraft>) => {
        setError(null)
        onDraftChange({ ...draft, ...patch })
    }
    const count = parseQueuePrompts(draft.prompts).length

    const submit = async () => {
        const built = buildQueueRequest(draft)
        if ('error' in built) {
            setError(built.error)
            return
        }
        setBusy(true)
        try {
            await createTask(built.request)
        } catch {
            setBusy(false)
            setError('failed')
            return
        }
        setBusy(false)
        onCreated()
    }

    return (
        <div className="flex flex-col gap-2">
            <div>
                <label className={LABEL_CLASS} htmlFor="queue-task-prompts">{t('composer.taskQueueMessages')}</label>
                <textarea
                    id="queue-task-prompts"
                    rows={5}
                    value={draft.prompts}
                    placeholder={t('composer.taskQueuePlaceholder')}
                    disabled={busy}
                    onChange={(e) => update({ prompts: e.target.value })}
                    className={`${FIELD_CLASS} resize-y`}
                />
                <p className="mt-1 text-xs text-[var(--app-hint)]">
                    {count > 0 ? t('composer.taskQueueCount', { count }) : t('composer.taskQueueHint')}
                </p>
            </div>
            <IntervalField value={draft.interval} onChange={(interval) => update({ interval })} disabled={busy} />
            <FirstRunField value={draft.firstRunAt} onChange={(firstRunAt) => update({ firstRunAt })} disabled={busy} />
            <TaskFormError error={error} />
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
