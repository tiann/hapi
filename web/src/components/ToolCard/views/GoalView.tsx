import { safeStringify } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import { formatDuration } from '@/chat/presentation'
import { useTranslation } from '@/lib/use-translation'
import { getPendingGoalRequest, parseGoalToolResult, type GoalResult } from '../goalTools'
import type { ToolViewProps } from './_all'

const STATUS_TONES: Record<string, string> = {
    active: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
    paused: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    budgetLimited: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    usageLimited: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    blocked: 'bg-red-500/10 text-red-700 dark:text-red-300',
    complete: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
}

function formatGoalDate(seconds: number | undefined, locale: string): string | null {
    if (!seconds || seconds <= 0) return null
    const date = new Date(seconds * 1000)
    return Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : null
}

export function GoalSummary({ result, surface }: { result: GoalResult; surface?: 'inline' | 'dialog' }) {
    const { t, locale } = useTranslation()
    if (result.kind === 'empty') {
        return <div className="text-sm text-[var(--app-hint)]">{t('tool.goal.empty')}</div>
    }
    const { goal } = result
    const number = (value: number) => value.toLocaleString(locale)
    const used = goal.tokensUsed
    const budget = goal.tokenBudget
    const durationMs = goal.timeUsedSeconds !== undefined ? goal.timeUsedSeconds * 1000 : null
    const duration = durationMs !== null && Number.isFinite(durationMs)
        ? formatDuration(durationMs)
        : null
    const percentage = used !== undefined && typeof budget === 'number' && budget > 0
        ? Math.min(100, used / budget * 100) : null
    const tone = Object.prototype.hasOwnProperty.call(STATUS_TONES, goal.status) ? STATUS_TONES[goal.status] : null
    const metadata = [
        [t('tool.goal.thread'), goal.threadId],
        [t('tool.goal.created'), formatGoalDate(goal.createdAt, locale)],
        [t('tool.goal.updated'), formatGoalDate(goal.updatedAt, locale)]
    ]

    return (
        <div className="flex min-w-0 flex-col gap-2.5 text-sm" data-goal-status={goal.status}>
            <div className="flex min-w-0 items-start gap-2.5">
                <span className={`max-w-[45%] shrink-0 break-words rounded-full px-2 py-0.5 text-[11px] font-medium [overflow-wrap:anywhere] ${tone ?? 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}>
                    {tone ? t(`session.status.goal.${goal.status}`) : goal.status}
                </span>
                <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--app-fg)]">{goal.objective}</div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums [overflow-wrap:anywhere] text-[var(--app-hint)]">
                {used !== undefined ? (
                    <span>{t('tool.goal.tokens', { value: typeof budget === 'number' ? `${number(used)} / ${number(budget)}` : number(used) })}</span>
                ) : typeof budget === 'number' ? (
                    <span>{t('tool.goal.budget', { value: number(budget) })}</span>
                ) : null}
                {budget === null ? <span>{t('tool.goal.unlimited')}</span> : null}
                {duration ? <span>{duration}</span> : null}
            </div>
            {percentage !== null ? (
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"
                    role="progressbar" aria-label={t('tool.goal.budgetUsed')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
                    <div className="h-full rounded-full bg-[var(--app-link)]" style={{ width: `${percentage}%` }} />
                </div>
            ) : null}
            {surface === 'dialog' && metadata.some(([, value]) => value) ? (
                <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[var(--app-border)] pt-2 text-xs">
                    {metadata.filter(([, value]) => value).map(([label, value]) => (
                        <div key={label} className="contents">
                            <dt className="text-[var(--app-hint)]">{label}</dt>
                            <dd className="break-all text-[var(--app-fg)]">{value}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}
        </div>
    )
}

export function GoalView({ block, surface }: ToolViewProps) {
    const { t } = useTranslation()
    const result = block.tool.state === 'completed' ? parseGoalToolResult(block.tool.result) : null
    if (!result) {
        const request = getPendingGoalRequest(block.tool.input)
        const isStatus = request?.kind === 'status'
        const text = isStatus && Object.prototype.hasOwnProperty.call(STATUS_TONES, request.text)
            ? t(`session.status.goal.${request.text}`) : request?.text
        return <div className="whitespace-pre-wrap break-words text-sm text-[var(--app-fg)]">
            <span className="mb-1 block text-xs text-[var(--app-hint)]">{t(isStatus ? 'tool.goal.requestedStatus' : 'tool.goal.requested')}</span>
            {text}
        </div>
    }
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <GoalSummary result={result} surface={surface} />
            {surface === 'dialog' ? (
                <details className="min-w-0 text-xs text-[var(--app-hint)]">
                    <summary className="cursor-pointer py-1">{t('tool.goal.raw')}</summary>
                    <CodeBlock code={typeof block.tool.result === 'string' ? block.tool.result : safeStringify(block.tool.result)} language="json" />
                </details>
            ) : null}
        </div>
    )
}
