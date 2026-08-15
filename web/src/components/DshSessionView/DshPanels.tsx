import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import type {
    DshAction,
    DshPendingQuestions,
    DshStateSnapshot
} from '@hapi/protocol'

type Dispatch = (action: DshAction) => Promise<unknown>

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-card-bg)] p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">{title}</h3>
            {children}
        </section>
    )
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export function DshGoalBar({ snapshot, dispatch }: { snapshot: DshStateSnapshot; dispatch: Dispatch }) {
    const { t } = useTranslation()
    const goal = snapshot.goal
    if (!goal?.objective) return null
    const ref = goal.id !== undefined && goal.revision !== undefined
        ? { refId: goal.id, revision: goal.revision }
        : null
    const action = (kind: 'pause' | 'resume' | 'complete' | 'clear') => {
        if (!ref) return
        void dispatch({ type: 'goal', action: kind, refId: ref.refId, revision: ref.revision })
    }
    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-card-bg)] p-3">
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{goal.objective}</div>
                    <div className="text-xs text-[var(--app-hint)]">
                        {t(`dsh.goalStatus.${goal.status ?? 'active'}`)}
                        {typeof goal.currentRound === 'number' ? ` · ${t('dsh.goalRound', { round: goal.currentRound })}` : ''}
                    </div>
                </div>
                <div className="flex shrink-0 gap-1">
                    {goal.status === 'active' ? (
                        <button type="button" onClick={() => action('pause')} className="panel-btn">{t('dsh.goalPause')}</button>
                    ) : null}
                    {goal.status === 'paused' ? (
                        <button type="button" onClick={() => action('resume')} className="panel-btn">{t('dsh.goalResume')}</button>
                    ) : null}
                    <button type="button" onClick={() => action('complete')} className="panel-btn">{t('dsh.goalComplete')}</button>
                    <button type="button" onClick={() => action('clear')} className="panel-btn">{t('dsh.goalClear')}</button>
                </div>
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export function DshQueueDock({ snapshot, dispatch }: { snapshot: DshStateSnapshot; dispatch: Dispatch }) {
    const { t } = useTranslation()
    const items = snapshot.queue?.items ?? []
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editText, setEditText] = useState('')
    if (items.length === 0) return null
    return (
        <Panel title={t('dsh.queue')}>
            <div className="flex flex-col gap-1.5">
                {items.map((item) => (
                    <div key={item.id} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 text-xs">
                        {editingId === item.id ? (
                            <div className="flex flex-col gap-1">
                                <input
                                    type="text"
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    className="w-full rounded border border-[var(--app-border)] bg-transparent px-1.5 py-1 text-xs outline-none"
                                    autoFocus
                                />
                                <div className="flex gap-1">
                                    <button
                                        type="button"
                                        className="panel-btn"
                                        disabled={editText.trim().length === 0}
                                        onClick={() => {
                                            void dispatch({ type: 'queue.action', itemId: item.id, action: { kind: 'edit', text: editText.trim() } })
                                            setEditingId(null)
                                        }}
                                    >
                                        {t('dsh.save')}
                                    </button>
                                    <button type="button" className="panel-btn" onClick={() => setEditingId(null)}>
                                        {t('dsh.cancel')}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="truncate">{item.text || t('dsh.queueEmptyItem')}</div>
                                <div className="mt-1 flex gap-1">
                                    <button
                                        type="button"
                                        className="panel-btn"
                                        onClick={() => void dispatch({ type: 'queue.action', itemId: item.id, action: { kind: 'steer' } })}
                                    >
                                        {t('dsh.steer')}
                                    </button>
                                    <button
                                        type="button"
                                        className="panel-btn"
                                        onClick={() => { setEditingId(item.id); setEditText(item.text) }}
                                    >
                                        {t('dsh.edit')}
                                    </button>
                                    <button
                                        type="button"
                                        className="panel-btn"
                                        onClick={() => void dispatch({ type: 'queue.action', itemId: item.id, action: { kind: 'remove' } })}
                                    >
                                        {t('dsh.remove')}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                ))}
            </div>
        </Panel>
    )
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export function DshJobsDock({ snapshot }: { snapshot: DshStateSnapshot }) {
    const { t } = useTranslation()
    const jobs = snapshot.jobs?.jobs ?? []
    if (jobs.length === 0) return null
    const tone = (status: string): string => {
        if (status === 'completed') return 'text-green-600 dark:text-green-400'
        if (status === 'failed' || status === 'killed') return 'text-red-600 dark:text-red-400'
        if (status === 'stopping') return 'text-amber-600 dark:text-amber-400'
        return 'text-[var(--app-fg)]'
    }
    return (
        <Panel title={t('dsh.jobs')}>
            <div className="flex flex-col gap-1.5">
                {jobs.map((job) => (
                    <div key={job.id} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                            <span className="truncate">{job.label}</span>
                            <span className={`shrink-0 ${tone(job.status)}`}>{t(`dsh.jobStatus.${job.status}`)}</span>
                        </div>
                        {job.detail ? <div className="truncate text-[var(--app-hint)]">{job.detail}</div> : null}
                    </div>
                ))}
            </div>
        </Panel>
    )
}

// ---------------------------------------------------------------------------
// Pending user questions
// ---------------------------------------------------------------------------

export function DshQuestionsDialog({ questions, dispatch }: {
    questions: DshPendingQuestions
    dispatch: Dispatch
    onClose?: () => void
}) {
    const { t } = useTranslation()
    const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom?: string }>>({})
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const toggle = (id: string, label: string, multi: boolean) => {
        setAnswers((prev) => {
            const current = prev[id] ?? { selected: [] }
            if (multi) {
                const next = current.selected.includes(label)
                    ? current.selected.filter((s) => s !== label)
                    : [...current.selected, label]
                return { ...prev, [id]: { ...current, selected: next } }
            }
            return { ...prev, [id]: { ...current, selected: [label] } }
        })
    }

    const submit = () => {
        setSubmitting(true)
        setError(null)
        void dispatch({
            type: 'question.respond',
            questionRpcId: questions.questionRpcId,
            answer: {
                answers: questions.items.map((item) => ({
                    id: item.id,
                    selected: answers[item.id]?.selected ?? [],
                    ...(answers[item.id]?.custom ? { custom: answers[item.id]!.custom } : {})
                }))
            }
        }).then(() => {
            setSubmitting(false)
        }).catch((e: unknown) => {
            setSubmitting(false)
            setError(e instanceof Error ? e.message : String(e))
        })
    }

    return (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
            <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-card-bg)] p-4">
                <h3 className="mb-3 text-sm font-semibold">{t('dsh.questionsTitle')}</h3>
                <div className="flex flex-col gap-4">
                    {questions.items.map((item) => (
                        <div key={item.id}>
                            <div className="text-sm font-medium">{item.question}</div>
                            {item.header ? <div className="text-xs text-[var(--app-hint)]">{item.header}</div> : null}
                            {item.detail ? <div className="mt-1 text-xs text-[var(--app-hint)]">{item.detail}</div> : null}
                            {item.options && item.options.length > 0 ? (
                                <div className="mt-2 flex flex-col gap-1">
                                    {item.options.map((option) => {
                                        const selected = (answers[item.id]?.selected ?? []).includes(option.label)
                                        return (
                                            <button
                                                key={option.label}
                                                type="button"
                                                onClick={() => toggle(item.id, option.label, item.multiSelect === true)}
                                                className={`rounded-md border px-2 py-1.5 text-left text-xs ${
                                                    selected
                                                        ? 'border-[var(--app-accent)] bg-[var(--app-accent)]/10 text-[var(--app-fg)]'
                                                        : 'border-[var(--app-border)] text-[var(--app-fg)]'
                                                }`}
                                            >
                                                {option.label}
                                                {option.description ? (
                                                    <span className="block text-[10px] text-[var(--app-hint)]">{option.description}</span>
                                                ) : null}
                                            </button>
                                        )
                                    })}
                                </div>
                            ) : null}
                            <input
                                type="text"
                                placeholder={t('dsh.questionCustomPlaceholder')}
                                value={answers[item.id]?.custom ?? ''}
                                onChange={(e) => setAnswers((prev) => ({
                                    ...prev,
                                    [item.id]: { ...(prev[item.id] ?? { selected: [] }), custom: e.target.value }
                                }))}
                                className="mt-2 w-full rounded-md border border-[var(--app-border)] bg-transparent px-2 py-1.5 text-xs outline-none focus:border-[var(--app-accent)]"
                            />
                        </div>
                    ))}
                </div>
                {error ? <div className="mt-3 text-xs text-red-500">{error}</div> : null}
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        disabled={submitting}
                        onClick={submit}
                        className="rounded-md bg-[var(--app-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
                    >
                        {submitting ? t('dsh.submitting') : t('dsh.submitAnswer')}
                    </button>
                </div>
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Approvals (agentState.requests → official two-outcome response)
// ---------------------------------------------------------------------------
