import { formatScheduledTime } from '@/lib/scheduledTime'
import { isTaskRunCancelUnconfirmed, taskRunLabel, taskRunOutcome } from '@/lib/sessionTasks'
import type { SessionTaskRun } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { TEXT_BUTTON_CLASS } from './SessionTaskFields'

/** `<time>` with an absolute, locale-formatted stamp that survives the minute tick. */
export function TaskRunTime({ at }: { at: number }) {
    return <time dateTime={new Date(at).toISOString()}>{formatScheduledTime(at)}</time>
}

/**
 * The newest runs of the session's tasks: every prompt a task sent, every slot
 * it skipped and every run that could not go out, with the reason. Finished
 * tasks are gone from the list in the bar, but their runs stay readable here.
 * A run whose cancel the hub could not confirm yet says so, and only such a run.
 */
export function SessionTaskHistory({ runs, isLoading, error, onRetry }: {
    runs: SessionTaskRun[]
    isLoading: boolean
    error: string | null
    /** Asks for the runs again; a failed load is not a state the user is left in, as with the task list. */
    onRetry: () => void
}) {
    const { t } = useTranslation()

    if (error) {
        return (
            <p role="alert" className="mb-1 flex items-center gap-2 text-xs text-[var(--app-warning-text)]">
                <span>{t('tasks.historyFailed')}</span>
                <button
                    type="button"
                    onClick={onRetry}
                    className={`${TEXT_BUTTON_CLASS} text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]`}
                >
                    {t('tasks.retry')}
                </button>
            </p>
        )
    }
    if (isLoading) {
        return <p className="text-xs text-[var(--app-hint)]">{t('loading')}</p>
    }
    if (runs.length === 0) {
        return <p className="text-xs text-[var(--app-hint)]">{t('tasks.historyEmpty')}</p>
    }

    return (
        <ol aria-label={t('tasks.history')} className="flex flex-col gap-1.5">
            {runs.map((run) => {
                const outcome = run.outcome === 'sent' && run.takenAt !== null
                    ? { text: t('tasks.run.takenAt', { time: formatScheduledTime(run.takenAt) }), tone: 'normal' as const }
                    : taskRunOutcome(run, t)
                return (
                    <li key={run.id} className="flex flex-col gap-0.5 rounded-lg bg-[var(--app-secondary-bg)] px-3 py-2 shadow-sm">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--app-hint)]">
                            <TaskRunTime at={run.recordedAt} />
                            <span>{taskRunLabel(run, t)}</span>
                        </div>
                        {run.preview ? (
                            <span className="line-clamp-2 whitespace-pre-wrap break-words text-[var(--app-fg)]">{run.preview}</span>
                        ) : null}
                        <span className={`text-xs ${outcome.tone === 'warning' ? 'text-[var(--app-warning-text)]' : 'text-[var(--app-hint)]'}`}>
                            {outcome.text}
                        </span>
                        {isTaskRunCancelUnconfirmed(run) ? (
                            // The hub asks the CLI again; once the cancel is confirmed this note goes with the refetch.
                            <span className="text-xs text-[var(--app-warning-text)]">{t('tasks.cancelUnconfirmed')}</span>
                        ) : null}
                    </li>
                )
            })}
        </ol>
    )
}
