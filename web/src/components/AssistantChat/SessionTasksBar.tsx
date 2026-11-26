import { useEffect, useState } from 'react'
import type { SessionTask } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { useSessionTaskMutations, useSessionTasks } from '@/hooks/queries/useSessionTasks'
import { formatTaskInterval, taskStatus } from '@/lib/sessionTasks'
import { useTranslation } from '@/lib/use-translation'

/** The "next run" line counts down; re-render often enough for it to stay honest. */
const COUNTDOWN_TICK_MS = 30_000

const ICON_BUTTON_CLASS = 'flex h-6 w-6 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40'

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

/** The prompt the task sends next, or the last one once everything is out. */
export function nextSessionTaskPrompt(task: SessionTask): string {
    return task.items[Math.min(task.runCount, task.items.length - 1)]?.text ?? ''
}

/**
 * The session's repeat and queue tasks, above the queued-message bar: what
 * runs next, and pause / resume / delete per task. Renders nothing on a hub
 * without task routes or when the session has no tasks.
 */
export function SessionTasksBar({ api, sessionId }: { api: ApiClient | null; sessionId: string }) {
    const { t } = useTranslation()
    const { tasks, unsupported } = useSessionTasks(api, sessionId)
    const { setPaused, deleteTask } = useSessionTaskMutations(api, sessionId)
    const [, setTick] = useState(0)
    const countsDown = tasks.some((task) => task.state === 'active' && task.nextRunAt !== null)

    useEffect(() => {
        if (!countsDown) return
        const timer = setInterval(() => setTick((n) => n + 1), COUNTDOWN_TICK_MS)
        return () => clearInterval(timer)
    }, [countsDown])

    if (unsupported || tasks.length === 0) return null

    return (
        <div
            role="status"
            aria-label={`${tasks.length} ${t('tasks.title')}`}
            className="mx-auto w-full max-w-content"
        >
            <div className="px-3 pb-0 pt-2 text-sm text-[var(--app-fg-muted)]">
                <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-[var(--app-hint)]">
                    <RepeatIcon />
                    <span>{t('tasks.title')}</span>
                </div>
                <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto" aria-label={t('tasks.title')}>
                    {tasks.map((task) => {
                        const status = taskStatus(task, t)
                        const paused = task.state === 'paused'
                        const busy = (setPaused.isPending && setPaused.variables?.taskId === task.id)
                            || (deleteTask.isPending && deleteTask.variables === task.id)
                        return (
                            <li
                                key={task.id}
                                className="flex items-start gap-2 min-w-0 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--app-hint)]">
                                        <span>{t(task.kind === 'queue' ? 'tasks.kindQueue' : 'tasks.kindRepeat')}</span>
                                        {task.totalRuns !== null ? (
                                            <span>{t('tasks.progress', { done: task.runCount, total: task.totalRuns })}</span>
                                        ) : null}
                                        <span>{t('tasks.every', { interval: formatTaskInterval(task.intervalMs, t) })}</span>
                                    </div>
                                    <span className="line-clamp-2 whitespace-pre-wrap break-words text-[var(--app-fg)]">
                                        {nextSessionTaskPrompt(task)}
                                    </span>
                                    <div className={`mt-1 text-xs ${status.tone === 'warning' ? 'text-[var(--app-warning-text)]' : 'text-[var(--app-hint)]'}`}>
                                        {status.text}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        aria-label={t(paused ? 'tasks.resume' : 'tasks.pause')}
                                        title={t(paused ? 'tasks.resume' : 'tasks.pause')}
                                        disabled={busy}
                                        onClick={() => setPaused.mutate({ taskId: task.id, paused: !paused })}
                                        onMouseDown={(e) => e.preventDefault()}
                                        className={ICON_BUTTON_CLASS}
                                    >
                                        {paused ? <PlayIcon /> : <PauseIcon />}
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t('tasks.delete')}
                                        title={t('tasks.delete')}
                                        disabled={busy}
                                        onClick={() => deleteTask.mutate(task.id)}
                                        onMouseDown={(e) => e.preventDefault()}
                                        className={ICON_BUTTON_CLASS}
                                    >
                                        <DeleteIcon />
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
