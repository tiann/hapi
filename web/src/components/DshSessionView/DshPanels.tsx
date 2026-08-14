import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { useDshModels } from '@/hooks/queries/useDshModels'
import { useDshSkills } from '@/hooks/queries/useDshSkills'
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
    if (items.length === 0) return null
    return (
        <Panel title={t('dsh.queue')}>
            <div className="flex flex-col gap-1.5">
                {items.map((item) => (
                    <div key={item.id} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 text-xs">
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
                                onClick={() => void dispatch({ type: 'queue.action', itemId: item.id, action: { kind: 'remove' } })}
                            >
                                {t('dsh.remove')}
                            </button>
                        </div>
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

export function DshApprovalPanel({ agentState, api, sessionId }: {
    agentState: Record<string, unknown>
    api: ApiClient | null
    sessionId: string
}) {
    const { t } = useTranslation()
    const requests = (agentState.requests ?? {}) as Record<string, { tool?: string; arguments?: unknown; createdAt?: number }>
    const entries = Object.entries(requests)
    if (entries.length === 0) return null
    return (
        <div className="flex flex-col gap-2">
            {entries.map(([approvalId, request]) => (
                <div key={approvalId} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <div className="text-sm font-medium">{request.tool ?? t('dsh.approvalUnknownTool')}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        {typeof request.arguments === 'object' && request.arguments !== null
                            ? Object.entries(request.arguments as Record<string, unknown>).map(([key, value]) => (
                                <span key={key} className="rounded bg-[var(--app-secondary-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                                    {key}: {typeof value === 'string' ? value : JSON.stringify(value)}
                                </span>
                            ))
                            : null}
                    </div>
                    <div className="mt-2 flex gap-2">
                        <button
                            type="button"
                            className="rounded-md bg-green-600 px-3 py-1 text-xs text-white"
                            onClick={() => void api?.approvePermission(sessionId, approvalId)}
                        >
                            {t('dsh.allowOnce')}
                        </button>
                        <button
                            type="button"
                            className="rounded-md bg-red-600 px-3 py-1 text-xs text-white"
                            onClick={() => void api?.denyPermission(sessionId, approvalId)}
                        >
                            {t('dsh.deny')}
                        </button>
                    </div>
                </div>
            ))}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Model picker (runtime-discovered)
// ---------------------------------------------------------------------------

export function DshModelPicker({ sessionId, api, snapshot, dispatch }: {
    sessionId: string
    api: ApiClient | null
    snapshot: DshStateSnapshot
    dispatch: Dispatch
}) {
    const { t } = useTranslation()
    const { models, isLoading, error } = useDshModels({ api, sessionId, enabled: true })
    const [open, setOpen] = useState(false)
    const current = snapshot.model ?? models?.current
    const groups = models?.groups ?? []

    return (
        <Panel title={t('dsh.model')}>
            {isLoading ? <div className="text-xs text-[var(--app-hint)]">{t('dsh.loading')}</div> : null}
            {error ? <div className="text-xs text-red-500">{error}</div> : null}
            {current ? (
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="w-full rounded-md border border-[var(--app-border)] px-2 py-1.5 text-left text-xs"
                >
                    <div className="font-medium">{current.model}</div>
                    <div className="text-[10px] text-[var(--app-hint)]">
                        {current.provider}
                        {current.reasoningEffort ? ` · ${current.reasoningEffort}` : ''}
                    </div>
                </button>
            ) : null}
            {open ? (
                <div className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto">
                    {groups.map((group) => (
                        <div key={group.id}>
                            <div className="px-1 py-0.5 text-[10px] font-medium uppercase text-[var(--app-hint)]">{group.name}</div>
                            {group.models.map((model) => {
                                const selected = current?.model === model.id
                                return (
                                    <button
                                        key={model.id}
                                        type="button"
                                        onClick={() => {
                                            void dispatch({
                                                type: 'model.select',
                                                provider: group.id,
                                                model: model.id,
                                                ...(model.defaultEffort ? { reasoningEffort: model.defaultEffort } : {})
                                            }).then(() => setOpen(false))
                                        }}
                                        className={`w-full rounded-md px-2 py-1 text-left text-xs ${
                                            selected ? 'bg-[var(--app-accent)]/10 text-[var(--app-accent)]' : 'hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                    >
                                        {model.name}
                                        {model.efforts && model.efforts.length > 0 ? (
                                            <span className="block text-[10px] text-[var(--app-hint)]">
                                                {model.efforts.map((e) => e.name).join(' · ')}
                                            </span>
                                        ) : null}
                                    </button>
                                )
                            })}
                        </div>
                    ))}
                    {groups.length === 0 && !isLoading ? (
                        <div className="text-xs text-[var(--app-hint)]">{t('dsh.noModels')}</div>
                    ) : null}
                </div>
            ) : null}
        </Panel>
    )
}

// ---------------------------------------------------------------------------
// Agent presets (blank sessions only)
// ---------------------------------------------------------------------------

export function DshPresetPicker({ sessionId, api, dispatch }: {
    sessionId: string
    api: ApiClient | null
    dispatch: Dispatch
}) {
    const { t } = useTranslation()
    const [presets, setPresets] = useState<Array<{ id: string; name?: string; description?: string; broken?: string }> | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = () => {
        if (!api || presets !== null) return
        void api.dshAction<{ presets: Array<{ id: string; name?: string; description?: string; broken?: string }> }>(
            sessionId,
            { type: 'agentPresets', action: 'list' }
        ).then((response) => {
            setPresets(response.result.presets)
        }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    }

    return (
        <Panel title={t('dsh.presets')}>
            {presets === null ? (
                <button type="button" onClick={load} className="panel-btn text-xs">{t('dsh.loadPresets')}</button>
            ) : (
                <div className="flex flex-col gap-1">
                    {presets.map((preset) => (
                        <button
                            key={preset.id}
                            type="button"
                            disabled={Boolean(preset.broken)}
                            onClick={() => void dispatch({ type: 'agentPresets', action: 'select', agentPreset: preset.id })}
                            className="rounded-md border border-[var(--app-border)] px-2 py-1 text-left text-xs disabled:opacity-40"
                            title={preset.broken}
                        >
                            {preset.name ?? preset.id}
                        </button>
                    ))}
                </div>
            )}
            {error ? <div className="mt-1 text-xs text-red-500">{error}</div> : null}
        </Panel>
    )
}

// ---------------------------------------------------------------------------
// Skills (leading-/ invocation)
// ---------------------------------------------------------------------------

export function DshSkillsPalette({ sessionId, api, onInsert }: {
    sessionId: string
    api: ApiClient | null
    onInsert: (name: string) => void
}) {
    const { t } = useTranslation()
    const { skills, isLoading } = useDshSkills({ api, sessionId, enabled: true })
    if (skills.length === 0 && !isLoading) return null
    return (
        <Panel title={t('dsh.skills')}>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {skills.map((skill) => (
                    <button
                        key={skill.name}
                        type="button"
                        onClick={() => onInsert(skill.name)}
                        className="rounded-md border border-[var(--app-border)] px-2 py-1 text-left text-xs hover:bg-[var(--app-secondary-bg)]"
                        title={skill.description}
                    >
                        <span className="font-mono text-[var(--app-accent)]">/{skill.name}</span>
                        <span className="block truncate text-[10px] text-[var(--app-hint)]">{skill.description}</span>
                    </button>
                ))}
            </div>
        </Panel>
    )
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export function DshSubagentsPanel({ sessionId, api, dispatch, latestNativeSeq }: {
    sessionId: string
    api: ApiClient | null
    dispatch: Dispatch
    latestNativeSeq: number
}) {
    const { t } = useTranslation()
    const [entries, setEntries] = useState<Array<{ id: string; mode?: string; label?: string; activity?: string }> | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = () => {
        if (!api) return
        void api.dshAction<{ entries: Array<{ id: string; mode?: string; label?: string; activity?: string; kind: string }>; parentAvailable: boolean }>(
            sessionId,
            { type: 'subagent', action: 'list' }
        ).then((response) => {
            setEntries(response.result.entries.filter((e) => e.kind === 'child'))
        }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    }

    return (
        <Panel title={t('dsh.subagents')}>
            {entries === null ? (
                <button type="button" onClick={load} className="panel-btn text-xs">{t('dsh.loadSubagents')}</button>
            ) : entries.length === 0 ? (
                <div className="text-xs text-[var(--app-hint)]">{t('dsh.noSubagents')}</div>
            ) : (
                <div className="flex flex-col gap-1">
                    {entries.map((entry) => (
                        <div key={entry.id} className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs">
                            <div className="flex items-center justify-between gap-2">
                                <span className="truncate">{entry.label ?? entry.id}</span>
                                <span className={`shrink-0 ${entry.activity === 'running' ? 'text-green-600 dark:text-green-400' : 'text-[var(--app-hint)]'}`}>
                                    {entry.activity === 'running' ? t('dsh.subagentRunning') : t('dsh.subagentIdle')}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {error ? <div className="mt-1 text-xs text-red-500">{error}</div> : null}
        </Panel>
    )
}
