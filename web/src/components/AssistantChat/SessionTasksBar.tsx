import { useEffect, useRef, useState } from 'react'
import type { SessionTask, UpdateSessionTaskRequest } from '@hapi/protocol'
import { ApiError, type ApiClient } from '@/api/client'
import { useSessionTaskHistory, useSessionTaskMutations, useSessionTasks } from '@/hooks/queries/useSessionTasks'
import { formatTaskInterval, taskStatus } from '@/lib/sessionTasks'
import { useOptionalAddToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { SessionTaskHistory } from './SessionTaskHistory'
import { SessionTaskInlineEditor } from './SessionTaskInlineEditor'

/** The "next run" line counts down; re-render often enough for it to stay honest. */
const COUNTDOWN_TICK_MS = 30_000

/** 28 px here, a full 32 px where a finger does the tapping. */
const ICON_BUTTON_CLASS = 'flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-8 pointer-coarse:w-8'
const TEXT_BUTTON_CLASS = 'rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'

type Translate = (key: string, params?: Record<string, string | number>) => string

function RepeatIcon() {
    return (
        <svg className="h-[14px] w-[14px] shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
                d="M13 8a5 5 0 0 1-8.7 3.4M3 8a5 5 0 0 1 8.7-3.4M11.5 2v2.7H8.8M4.5 14v-2.7h2.7"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

function PauseIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
    )
}

function PlayIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M5 3.2v9.6l7-4.8-7-4.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
    )
}

function DeleteIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

function RunNowIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M2.5 8h9M8 4.5L11.5 8 8 11.5M13 3.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function EditIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path
                d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H3v-2L11.5 2.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

/** While a prompt is out, that one; otherwise the one the task sends next. */
export function displayedSessionTaskPrompt(task: SessionTask): string {
    const index = task.pending ? task.runCount - 1 : task.runCount
    return task.items[Math.min(Math.max(index, 0), task.items.length - 1)]?.text ?? ''
}

/** The hub kept the task as it was because one of its prompts is still waiting to be taken. */
export function isPromptPendingError(error: unknown): boolean {
    return error instanceof ApiError && error.code === 'prompt_pending'
}

/** `Every 10 minutes` for a repeat task; `Gap 10 minutes` for a queue, whose clock starts when the agent takes a prompt. */
export function taskCadenceLabel(task: SessionTask, t: Translate): string {
    const interval = formatTaskInterval(task.intervalMs, t)
    return t(task.kind === 'queue' ? 'tasks.gap' : 'tasks.every', { interval })
}

function SessionTaskRow({ task, mutations, editing, onEditChange }: {
    task: SessionTask
    mutations: ReturnType<typeof useSessionTaskMutations>
    editing: boolean
    /** Names the row to edit, or none. Only one editor is open at a time. */
    onEditChange: (taskId: string | null) => void
}) {
    const { t } = useTranslation()
    const addToast = useOptionalAddToast()
    const [confirming, setConfirming] = useState(false)
    // Set when the question is dismissed, so focus returns to the Delete button,
    // which only exists again once the icon row is back.
    const returnFocusRef = useRef(false)
    const deleteButtonRef = useRef<HTMLButtonElement | null>(null)
    const editButtonRef = useRef<HTMLButtonElement | null>(null)
    const keepButtonRef = useRef<HTMLButtonElement | null>(null)
    const status = taskStatus(task, t)
    const paused = task.state === 'paused'
    const pausePending = mutations.setPaused.isPending && mutations.setPaused.variables?.taskId === task.id
    const runPending = mutations.runNow.isPending && mutations.runNow.variables === task.id
    const editPending = mutations.updateTask.isPending && mutations.updateTask.variables?.taskId === task.id
    const deletePending = mutations.deleteTask.isPending && mutations.deleteTask.variables === task.id
    const busy = pausePending || runPending || editPending || deletePending

    const toast = (title: string) => {
        addToast?.({ title, body: '', sessionId: task.sessionId, url: window.location.href })
    }
    const confirmDelete = () => {
        setConfirming(false)
        mutations.deleteTask.mutate(task.id, {
            onSuccess: (result) => {
                // The prompt the agent had not taken: say when it could not be pulled back.
                if (result.prompt === 'unconfirmed') toast(t('tasks.deleteUnconfirmed'))
                else if (result.prompt === 'taken') toast(t('tasks.deletePromptTaken'))
            }
        })
    }
    const keepTask = () => {
        returnFocusRef.current = true
        setConfirming(false)
    }
    const runNow = () => {
        mutations.runNow.mutate(task.id, {
            onError: (error) => toast(t(isPromptPendingError(error) ? 'composer.taskPromptPending' : 'composer.taskRunFailed'))
        })
    }
    const save = async (request: UpdateSessionTaskRequest) => {
        await mutations.updateTask.mutateAsync({ taskId: task.id, request })
        onEditChange(null)
    }
    const stopEditing = (returnFocus: boolean) => {
        onEditChange(null)
        if (returnFocus) editButtonRef.current?.focus()
    }

    // The question starts on the safe answer, and ends back on the Delete button.
    useEffect(() => {
        if (confirming) {
            keepButtonRef.current?.focus()
            return
        }
        if (returnFocusRef.current) {
            returnFocusRef.current = false
            deleteButtonRef.current?.focus()
        }
    }, [confirming])

    // A task with a prompt still waiting cannot run again: the hub keeps one prompt per task.
    const runNowTitle = task.pending ? t('composer.taskPromptPending') : t('tasks.runNow')

    return (
        <li
            data-task-id={task.id}
            className="flex flex-col gap-1 min-w-0 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
        >
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--app-hint)]">
                        <span>{t(task.kind === 'queue' ? 'tasks.kindQueue' : 'tasks.kindRepeat')}</span>
                        {task.totalRuns !== null ? (
                            <span>{t('tasks.progress', { done: task.runCount, total: task.totalRuns })}</span>
                        ) : null}
                        <span>{taskCadenceLabel(task, t)}</span>
                    </div>
                    <span className="line-clamp-2 whitespace-pre-wrap break-words text-[var(--app-fg)]">
                        {displayedSessionTaskPrompt(task)}
                    </span>
                    {confirming ? (
                        // The group's label carries the question for screen readers.
                        <div className="mt-1 text-xs text-[var(--app-fg)]" aria-hidden="true">{t('tasks.confirmDelete')}</div>
                    ) : (
                        // The visible line counts down every minute; only the stable sentence is announced.
                        <div className={`mt-1 text-xs ${status.tone === 'warning' ? 'text-[var(--app-warning-text)]' : 'text-[var(--app-hint)]'}`}>
                            <span aria-hidden="true" title={status.live}>{status.text}</span>
                            <span className="sr-only" aria-live="polite">{status.live}</span>
                        </div>
                    )}
                </div>
                {confirming ? (
                    <div
                        role="group"
                        aria-label={t('tasks.confirmDelete')}
                        className="flex shrink-0 items-center gap-1"
                        onKeyDown={(event) => {
                            if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
                            event.preventDefault()
                            event.stopPropagation()
                            keepTask()
                        }}
                    >
                        <button
                            ref={keepButtonRef}
                            type="button"
                            disabled={deletePending}
                            onClick={keepTask}
                            className={`${TEXT_BUTTON_CLASS} bg-[var(--app-bg)] text-[var(--app-fg)] hover:bg-[var(--app-border)]`}
                        >
                            {t('tasks.keepTask')}
                        </button>
                        <button
                            type="button"
                            disabled={deletePending}
                            onClick={confirmDelete}
                            className={`${TEXT_BUTTON_CLASS} bg-red-500 text-white hover:bg-red-600`}
                        >
                            {t('tasks.confirmDeleteButton')}
                        </button>
                    </div>
                ) : (
                    <div className="flex shrink-0 items-center gap-1">
                        <button
                            type="button"
                            aria-label={t(paused ? 'tasks.resume' : 'tasks.pause')}
                            title={t(paused ? 'tasks.resume' : 'tasks.pause')}
                            disabled={busy}
                            onClick={() => mutations.setPaused.mutate({ taskId: task.id, paused: !paused })}
                            onMouseDown={(e) => e.preventDefault()}
                            className={ICON_BUTTON_CLASS}
                        >
                            {paused ? <PlayIcon /> : <PauseIcon />}
                        </button>
                        <button
                            type="button"
                            aria-label={t('tasks.runNow')}
                            title={runNowTitle}
                            disabled={busy || task.pending}
                            onClick={runNow}
                            onMouseDown={(e) => e.preventDefault()}
                            className={ICON_BUTTON_CLASS}
                        >
                            <RunNowIcon />
                        </button>
                        <button
                            ref={editButtonRef}
                            type="button"
                            aria-label={t('tasks.edit')}
                            title={t('tasks.edit')}
                            aria-expanded={editing}
                            disabled={busy}
                            onClick={() => (editing ? stopEditing(false) : onEditChange(task.id))}
                            onMouseDown={(e) => e.preventDefault()}
                            className={ICON_BUTTON_CLASS}
                        >
                            <EditIcon />
                        </button>
                        <button
                            ref={deleteButtonRef}
                            type="button"
                            aria-label={t('tasks.delete')}
                            title={t('tasks.delete')}
                            disabled={busy}
                            onClick={() => setConfirming(true)}
                            onMouseDown={(e) => e.preventDefault()}
                            className={ICON_BUTTON_CLASS}
                        >
                            <DeleteIcon />
                        </button>
                    </div>
                )}
            </div>
            {editing ? (
                <SessionTaskInlineEditor task={task} save={save} onCancel={stopEditing} />
            ) : null}
        </li>
    )
}

/**
 * The session's repeat and queue tasks, above the queued-message bar: what
 * runs next, pause / resume, run now, edit and delete per task, and the runs
 * behind a History toggle. Renders nothing on a hub without task routes, or
 * when the session has neither tasks nor runs; a failed load says so and
 * offers a retry.
 */
export function SessionTasksBar({ api, sessionId }: { api: ApiClient | null; sessionId: string }) {
    const { t } = useTranslation()
    const { tasks, error, unsupported, refetch } = useSessionTasks(api, sessionId)
    // The runs outlive their tasks: once the last task finishes and goes, the
    // history is the only place that says what it did, so the bar stays for it.
    const history = useSessionTaskHistory(api, sessionId, true)
    const mutations = useSessionTaskMutations(api, sessionId)
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
    const [historyOpen, setHistoryOpen] = useState(false)
    // The "next run" line counts down; re-render often enough for it to stay honest.
    const [, setTick] = useState(0)
    const headingId = `tasks-heading-${sessionId}`
    const historyId = `tasks-history-${sessionId}`
    const countsDown = tasks.some((task) => task.state === 'active' && task.lastError === null && !task.pending && task.nextRunAt !== null)

    useEffect(() => {
        if (!countsDown) return
        const timer = setInterval(() => setTick((n) => n + 1), COUNTDOWN_TICK_MS)
        return () => clearInterval(timer)
    }, [countsDown])

    // A loading history is no reason to show a header that then vanishes.
    if (unsupported) return null
    if (tasks.length === 0 && !historyOpen && !error && history.runs.length === 0) return null

    const hasRepeat = tasks.some((task) => task.kind === 'repeat')

    return (
        <div className="mx-auto w-full max-w-content">
            <div className="px-3 pb-0 pt-2 text-sm text-[var(--app-fg-muted)]">
                <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-[var(--app-hint)]">
                    <RepeatIcon />
                    <span id={headingId}>{t('tasks.title')}</span>
                    <span className="flex-1" />
                    <button
                        type="button"
                        aria-pressed={historyOpen}
                        aria-controls={historyId}
                        onClick={() => setHistoryOpen((open) => !open)}
                        className={`${TEXT_BUTTON_CLASS} text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]`}
                    >
                        {t('tasks.history')}
                    </button>
                </div>
                {error ? (
                    <p role="alert" className="mb-1.5 flex items-center gap-2 text-xs text-[var(--app-warning-text)]">
                        <span>{t('tasks.loadFailed')}</span>
                        <button
                            type="button"
                            onClick={() => { void refetch() }}
                            className={`${TEXT_BUTTON_CLASS} text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]`}
                        >
                            {t('tasks.retry')}
                        </button>
                    </p>
                ) : null}
                {tasks.length > 0 ? (
                    <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto" aria-labelledby={headingId}>
                        {tasks.map((task) => (
                            <SessionTaskRow
                                key={task.id}
                                task={task}
                                mutations={mutations}
                                editing={editingTaskId === task.id}
                                onEditChange={setEditingTaskId}
                            />
                        ))}
                    </ul>
                ) : null}
                {hasRepeat ? <p className="mt-1 text-xs text-[var(--app-hint)]">{t('composer.taskHintSkip')}</p> : null}
                {tasks.length > 0 ? <p className="mt-0.5 text-xs text-[var(--app-hint)]">{t('composer.taskHintWake')}</p> : null}
                {historyOpen ? (
                    <div id={historyId} className="mt-1.5 max-h-64 overflow-y-auto pb-1">
                        <SessionTaskHistory runs={history.runs} isLoading={history.isLoading} error={history.error} />
                    </div>
                ) : null}
            </div>
        </div>
    )
}
