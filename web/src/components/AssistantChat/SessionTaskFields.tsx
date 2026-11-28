import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import {
    getPermissionModeLabel,
    SESSION_TASK_MAX_ACTIVE_PER_SESSION,
    SESSION_TASK_MAX_INTERVAL_MS,
    SESSION_TASK_MAX_ITEMS,
    SESSION_TASK_MAX_START_OFFSET_MS,
    SESSION_TASK_MAX_TEXT_LENGTH,
    type PermissionMode
} from '@hapi/protocol'
import { ApiError, apiErrorMessage } from '@/api/client'
import { isYoloStylePermissionMode } from '@/lib/permissionModes'
import {
    formatTaskIntervalCount,
    maxDateTimeLocal,
    minDateTimeLocal,
    SESSION_TASK_INTERVAL_UNITS,
    type IntervalInput,
    type TaskDraftError
} from '@/lib/sessionTasks'
import { useTranslation } from '@/lib/use-translation'

export const FIELD_CLASS = 'rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]'
export const LABEL_CLASS = 'mb-1 block text-xs text-[var(--app-hint)]'
export const PRIMARY_BUTTON_CLASS = 'w-full rounded-lg bg-blue-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40'
export const SECONDARY_BUTTON_CLASS = 'rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-40'
/** A small text action: the task row's buttons, and Retry next to a failed load. */
export const TEXT_BUTTON_CLASS = 'rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'

const DAY_MS = 24 * 60 * 60 * 1000

const ERROR_KEY: Record<TaskDraftError, string> = {
    interval: 'composer.taskErrorInterval',
    intervalTooLong: 'composer.taskErrorIntervalTooLong',
    message: 'composer.taskErrorMessage',
    messageTooLong: 'composer.taskErrorMessageTooLong',
    queue: 'composer.taskErrorQueue',
    tooMany: 'composer.taskErrorTooMany',
    firstRun: 'composer.taskErrorFirstRun',
    firstRunTooFar: 'composer.taskErrorFirstRunTooFar',
    runs: 'composer.taskErrorRuns',
    runsBelowSent: 'composer.taskErrorRunsBelowSent',
    queueStale: 'composer.taskErrorQueueStale'
}

/** Why a form submission did not go through: the draft itself, or the hub's refusal. */
export type TaskFailure = { draft: TaskDraftError; sent?: number } | { request: unknown }

/** Grows a textarea with its text, from `rows` lines up to `maxPx`. */
function useAutosize(maxPx: number, value: string) {
    const ref = useRef<HTMLTextAreaElement | null>(null)
    useLayoutEffect(() => {
        const element = ref.current
        if (!element) return
        element.style.height = 'auto'
        const next = element.scrollHeight
        // jsdom reports no scroll height; the `rows` attribute keeps the field usable there.
        if (next > 0) element.style.height = `${Math.min(next, maxPx)}px`
    }, [maxPx, value])
    return ref
}

/**
 * One prompt. Enter inserts a newline, so a prompt may hold code, lists or
 * several paragraphs; the form is submitted only by its button (or Ctrl/Cmd+Enter).
 */
export function TaskPromptTextarea({ id, value, onChange, disabled, placeholder, rows = 2, onSubmit }: {
    id: string
    value: string
    onChange: (next: string) => void
    disabled: boolean
    placeholder?: string
    rows?: number
    /** Ctrl/Cmd+Enter submits the surrounding form; plain Enter is left to the textarea. */
    onSubmit?: () => void
}) {
    const ref = useAutosize(320, value)
    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmit) {
            event.preventDefault()
            onSubmit()
        }
    }
    return (
        <textarea
            ref={ref}
            id={id}
            rows={rows}
            value={value}
            placeholder={placeholder}
            maxLength={SESSION_TASK_MAX_TEXT_LENGTH}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onSubmit ? handleKeyDown : undefined}
            className={`${FIELD_CLASS} w-full resize-none overflow-y-auto`}
        />
    )
}

const UNIT_OPTION_KEY = {
    minutes: 'composer.taskUnitOptionMinutes',
    hours: 'composer.taskUnitOptionHours',
    days: 'composer.taskUnitOptionDays'
} as const

export function IntervalField({ id, label = 'composer.taskInterval', value, onChange, disabled }: {
    /** `id` of the number input, so the label names it. */
    id: string
    /** `composer.taskInterval` ("Every") for a repeat task, `composer.taskGap` ("Gap") for a queue. */
    label?: string
    value: IntervalInput
    onChange: (next: IntervalInput) => void
    disabled: boolean
}) {
    const { t } = useTranslation()
    return (
        <div>
            <label className={LABEL_CLASS} htmlFor={id}>{t(label)}</label>
            <div className="flex gap-2">
                <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
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
                    className={`${FIELD_CLASS} min-w-0 flex-1`}
                >
                    {SESSION_TASK_INTERVAL_UNITS.map((unit) => (
                        <option key={unit} value={unit}>{t(UNIT_OPTION_KEY[unit])}</option>
                    ))}
                </select>
            </div>
        </div>
    )
}

export function FirstRunField({ id, value, onChange, disabled }: {
    /** Prefix for the group's label id. */
    id: string
    /** null runs now; a `datetime-local` value runs at that time, '' while it is incomplete. */
    value: string | null
    onChange: (next: string | null) => void
    disabled: boolean
}) {
    const { t } = useTranslation()
    // The mode is the value's kind, not whether it is filled in: a datetime-local input reports
    // '' for as long as any segment is missing, which must not read as "now" and take the field away mid-edit.
    const scheduled = value !== null
    const labelId = `${id}-label`
    return (
        <div role="group" aria-labelledby={labelId}>
            <span id={labelId} className={LABEL_CLASS}>{t('composer.taskFirstRun')}</span>
            <div className="flex gap-1 mb-2">
                <button
                    type="button"
                    aria-pressed={!scheduled}
                    disabled={disabled}
                    onClick={() => onChange(null)}
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
                    onClick={() => onChange(value ?? minDateTimeLocal())}
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
                    aria-label={t('composer.taskFirstRunAtValue')}
                    value={value}
                    min={minDateTimeLocal()}
                    max={maxDateTimeLocal()}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value)}
                    className={`${FIELD_CLASS} w-full`}
                />
            ) : null}
        </div>
    )
}

export function RunLimitField({ id, value, onChange, disabled }: {
    id: string
    /** '' repeats until the task is paused or deleted. */
    value: string
    onChange: (next: string) => void
    disabled: boolean
}) {
    const { t } = useTranslation()
    return (
        <div>
            <label className={LABEL_CLASS} htmlFor={id}>{t('composer.taskStopAfter')}</label>
            <div className="flex items-baseline gap-2">
                <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value)}
                    className={`${FIELD_CLASS} w-24`}
                />
                <span className="text-xs text-[var(--app-hint)]">{t('composer.taskStopAfterHint')}</span>
            </div>
        </div>
    )
}

export function moveQueueItem(items: string[], from: number, to: number): string[] {
    if (to < 0 || to >= items.length || from === to) return items
    const next = items.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
}

/** 24 px here, 32 px where a finger does the tapping, like the task row's icon buttons. */
const ROW_BUTTON_CLASS = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-8 pointer-coarse:w-8'

/**
 * The prompts of a queue, one auto-growing field each, with add, remove and
 * reorder. Blank rows are allowed here and ignored when the request is built.
 */
export function QueueEditor({ idPrefix, items, onChange, disabled, firstPlaceholder, firstPromptCount, onSubmit }: {
    idPrefix: string
    /** One entry per row; the last row is never removed, only blanked, so there is always a field to type in. */
    items: string[]
    onChange: (next: string[]) => void
    disabled: boolean
    /** Offered by the first row while it is blank (the composer's text). */
    firstPlaceholder?: string
    /** How many prompts the queue will send (the composer's text counts while it stands in for a blank first row). */
    firstPromptCount: number
    onSubmit?: () => void
}) {
    const { t } = useTranslation()
    const set = (index: number, text: string) => onChange(items.map((item, at) => at === index ? text : item))
    const remove = (index: number) => onChange(items.length > 1 ? items.filter((_, at) => at !== index) : [''])
    const add = () => onChange([...items, ''])
    const count = firstPromptCount

    return (
        <div>
            <span className={LABEL_CLASS}>{t('composer.taskQueueMessages')}</span>
            <ul className="flex flex-col gap-2" aria-label={t('composer.taskQueueMessages')}>
                {items.map((item, index) => {
                    const id = `${idPrefix}-${index}`
                    return (
                        <li key={index} className="flex items-start gap-1">
                            <div className="min-w-0 flex-1">
                                <label className={`${LABEL_CLASS} sr-only`} htmlFor={id}>{t('composer.taskQueuePrompt', { n: index + 1 })}</label>
                                <TaskPromptTextarea
                                    id={id}
                                    value={item}
                                    disabled={disabled}
                                    placeholder={index === 0 ? firstPlaceholder : undefined}
                                    onSubmit={onSubmit}
                                    onChange={(text) => set(index, text)}
                                />
                            </div>
                            <div className="flex shrink-0 flex-col gap-0.5">
                                <button
                                    type="button"
                                    aria-label={t('composer.taskQueueMoveUp', { n: index + 1 })}
                                    title={t('composer.taskQueueMoveUp', { n: index + 1 })}
                                    disabled={disabled || index === 0}
                                    onClick={() => onChange(moveQueueItem(items, index, index - 1))}
                                    className={ROW_BUTTON_CLASS}
                                >
                                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                                        <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                </button>
                                <button
                                    type="button"
                                    aria-label={t('composer.taskQueueMoveDown', { n: index + 1 })}
                                    title={t('composer.taskQueueMoveDown', { n: index + 1 })}
                                    disabled={disabled || index === items.length - 1}
                                    onClick={() => onChange(moveQueueItem(items, index, index + 1))}
                                    className={ROW_BUTTON_CLASS}
                                >
                                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                </button>
                                <button
                                    type="button"
                                    aria-label={t('composer.taskQueueRemove', { n: index + 1 })}
                                    title={t('composer.taskQueueRemove', { n: index + 1 })}
                                    disabled={disabled}
                                    onClick={() => remove(index)}
                                    className={ROW_BUTTON_CLASS}
                                >
                                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                    </svg>
                                </button>
                            </div>
                        </li>
                    )
                })}
            </ul>
            <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-xs text-[var(--app-hint)]" aria-live="polite">
                    {t(count === 1 ? 'composer.taskQueueCountOne' : 'composer.taskQueueCount', { count })}
                </p>
                <button
                    type="button"
                    disabled={disabled || items.length >= SESSION_TASK_MAX_ITEMS}
                    onClick={add}
                    className="rounded-md px-2 py-1 text-xs font-medium text-[var(--app-link)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {t('composer.taskQueueAdd')}
                </button>
            </div>
        </div>
    )
}

/** The two rules a queue follows: the order, and the gap measured from the agent's take. */
export function QueueHints({ intervalMs }: { intervalMs: number | null }) {
    const { t } = useTranslation()
    return (
        <div className="text-xs text-[var(--app-hint)]">
            <p>{t('composer.taskQueueHint')}</p>
            {intervalMs !== null ? (
                <p className="mt-0.5">{t('composer.taskQueueGapHint', { interval: formatTaskIntervalCount(intervalMs, t) })}</p>
            ) : null}
        </div>
    )
}

/** What the form says when the hub refuses a task request. */
export function taskRequestErrorMessage(
    error: unknown,
    t: (key: string, params?: Record<string, string | number>) => string,
    fallbackKey: string
): string {
    if (error instanceof ApiError) {
        if (error.status === 404) return t('composer.taskHubTooOld')
        switch (error.code) {
            case 'too_many_tasks':
                return t('composer.taskTooManyActive', { count: SESSION_TASK_MAX_ACTIVE_PER_SESSION })
            case 'wrong_task_kind':
                return t('composer.taskWrongKind')
            case 'invalid_max_runs':
                return t('composer.taskInvalidMaxRuns')
            case 'prompt_pending':
                return t('composer.taskPromptPending')
        }
        // Any other client error: the hub's own sentence beats a generic one.
        if (error.status >= 400 && error.status < 500) return apiErrorMessage(error, t(fallbackKey))
    }
    return t(fallbackKey)
}

const ERROR_PARAMS: Partial<Record<TaskDraftError, Record<string, number>>> = {
    tooMany: { count: SESSION_TASK_MAX_ITEMS },
    messageTooLong: { count: SESSION_TASK_MAX_TEXT_LENGTH },
    intervalTooLong: { count: SESSION_TASK_MAX_INTERVAL_MS / DAY_MS },
    firstRunTooFar: { count: SESSION_TASK_MAX_START_OFFSET_MS / DAY_MS }
}

/** The sentence for a failed submission. */
export function taskFailureText(
    failure: TaskFailure,
    t: (key: string, params?: Record<string, string | number>) => string,
    fallbackKey: string
): string {
    if ('request' in failure) return taskRequestErrorMessage(failure.request, t, fallbackKey)
    return t(ERROR_KEY[failure.draft], failure.draft === 'runsBelowSent' ? { count: failure.sent ?? 0 } : ERROR_PARAMS[failure.draft])
}

export function TaskFormError({ failure, fallbackKey }: { failure: TaskFailure | null; fallbackKey: string }) {
    const { t } = useTranslation()
    if (!failure) return null
    return (
        <p role="alert" className="text-xs text-red-500">{taskFailureText(failure, t, fallbackKey)}</p>
    )
}

/**
 * A task sends its prompts with the session's stored permission mode, which
 * the hub also resumes the session with. Said in the forms only where that
 * mode does not ask before it acts: one the web calls YOLO.
 */
export function TaskPermissionHint({ permissionMode }: { permissionMode: PermissionMode | undefined }) {
    const { t } = useTranslation()
    if (!permissionMode || !isYoloStylePermissionMode(permissionMode)) return null
    return (
        <p className="text-xs text-[var(--app-warning-text)]">
            {t('composer.taskHintPermissionMode', { mode: getPermissionModeLabel(permissionMode) })}
        </p>
    )
}

/** True once the component unmounted, so a late answer does not act on a form that is gone. */
export function useMountedFlag() {
    const ref = useRef(true)
    useEffect(() => {
        ref.current = true
        return () => {
            ref.current = false
        }
    }, [])
    return ref
}
