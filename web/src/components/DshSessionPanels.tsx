import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type { DshAction, DshStateSnapshot } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { useDshSessionState } from '@/lib/dshSessionState'
import { useDshAction } from '@/hooks/mutations/useDshAction'
import {
    DshGoalBar,
    DshJobsDock,
    DshQueueDock,
    DshQuestionsDialog
} from './DshSessionView/DshPanels'

type DshSessionPanelsProps = {
    api: ApiClient
    sessionId: string
    /** Raw hub messages; dsh_state payloads are folded here. */
    messages: DecryptedMessage[]
}

/**
 * DeepSeek Harness status strip embedded in the standard HAPI session view.
 * The conversation/composer/tool/permission surfaces are the standard HAPI
 * UI; this strip only carries DSH-native state (goal, queue, background
 * jobs), collapsed by default so the thread stays clean.
 */
export function DshSessionPanels({ api, sessionId, messages }: DshSessionPanelsProps) {
    const { t } = useTranslation()
    const { snapshot } = useDshSessionState(messages)
    const dshAction = useDshAction(api, sessionId)
    const [open, setOpen] = useState(false)

    // Dispatch swallows failures (callers fire-and-forget with void); the
    // questions dialog observes errors through its own submit catch, so a
    // failed action must never surface as an unhandled rejection.
    const dispatch = useMemo(() => {
        const run = (action: DshAction): Promise<unknown> => {
            return dshAction.mutateAsync(action).catch((error: unknown) => {
                console.error('[dsh] action failed', action.type, error)
                return undefined
            })
        }
        return run
    }, [dshAction])

    const questions = snapshot.questions && snapshot.questions.items.length > 0
        ? snapshot.questions
        : null
    const summary = statusSummary(snapshot, t) ?? []
    if (summary.length === 0 && !questions) {
        return null
    }

    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-card-bg)]">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)]"
            >
                <span className="font-medium">{t('dsh.sessionLabel')}</span>
                {summary.map((part) => (
                    <span key={part} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5">
                        {part}
                    </span>
                ))}
                <span className="ml-auto">{open ? '▾' : '▸'}</span>
            </button>
            {open ? (
                <div className="flex flex-col gap-2 border-t border-[var(--app-border)] p-2">
                    {snapshot.goal?.objective ? <DshGoalBar snapshot={snapshot} dispatch={dispatch} /> : null}
                    <div className="grid gap-2 sm:grid-cols-2">
                        <DshQueueDock snapshot={snapshot} dispatch={dispatch} />
                        <DshJobsDock snapshot={snapshot} />
                    </div>
                </div>
            ) : null}
            {/* DSH questions are blocking by design (official semantics): no
                   dismiss affordance until the agent's question is answered. */}
            {questions ? (
                <DshQuestionsDialog questions={questions} dispatch={dispatch} onClose={() => {}} />
            ) : null}
        </div>
    )
}

function statusSummary(snapshot: DshStateSnapshot, t: (key: string) => string): string[] | null {
    const parts: string[] = []
    if (snapshot.goal?.objective) {
        parts.push(`${t('dsh.goal')}: ${snapshot.goal.status ?? t('dsh.goalStatus.active')}`)
    }
    const queued = snapshot.queue?.items?.filter((item) => item.placement === 'queued').length ?? 0
    if (queued > 0) {
        parts.push(`${t('dsh.queue')}: ${queued}`)
    }
    const runningJobs = snapshot.jobs?.jobs?.filter((job) => job.status === 'running' || job.status === 'stopping').length ?? 0
    if (runningJobs > 0) {
        parts.push(`${t('dsh.jobs')}: ${runningJobs}`)
    }
    return parts.length > 0 ? parts : null
}
