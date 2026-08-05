import { useMemo } from 'react'
import type { SessionSummary } from '@/types/api'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { ScheduleIcon } from '@/components/icons'
import { HoverTooltip, SESSION_ROW_TOOLTIP_FOCUS_CLASS, useSessionRowTooltipIds } from '@/components/HoverTooltip'
import { getAttentionLabel, SessionAttentionIndicator } from '@/components/SessionAttentionIndicator'
import { classifySessionAttention } from '@/lib/sessionAttention'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatScheduledTooltipDetail } from '@/lib/scheduledTime'
import { getCodexImportedAt } from '@/lib/codexImportedSessions'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'

function LoaderIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <line x1="12" y1="2" x2="12" y2="6" />
            <line x1="12" y1="18" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
            <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="6" y2="12" />
            <line x1="18" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
            <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
        </svg>
    )
}

function BulbIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12c.6.6 1 1.2 1 2h6c0-.8.4-1.4 1-2a7 7 0 0 0-4-12Z" />
        </svg>
    )
}

const ATTENTION_DOT_CLASS = {
    permission: 'bg-amber-500 animate-pulse',
    input: 'bg-blue-500',
    background: 'bg-blue-400',
    unread: 'bg-[var(--app-link)]',
} as const

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

function formatCodexImportedRelativeTime(
    value: number,
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.importedFromCodex.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.importedFromCodex.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.importedFromCodex.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.importedFromCodex.daysAgo', { n: days })
    return formatRelativeTime(value, t)
}

function getSessionTimeLabel(
    session: SessionSummary,
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    const importedAt = session.metadata?.flavor === 'codex'
        ? getCodexImportedAt(session.metadata?.agentSessionId)
        : null
    if (importedAt !== null) {
        return formatCodexImportedRelativeTime(importedAt, t)
    }
    return formatRelativeTime(session.updatedAt, t)
}

/**
 * Presentational session row — same chrome as the sidebar SessionItem body
 * (flavor, title, thinking/attention, schedule, todos, relative time, path).
 * Used by the session list and by rich-composer mention chip tooltips.
 */
export function SessionRowSummary(props: {
    session: SessionSummary
    showPath?: boolean
    showDetailedStatus?: boolean
    selected?: boolean
    /**
     * When false, attention is a bare colored dot (no nested HoverTooltip).
     * Use false inside an already-open chip tooltip portal.
     */
    nestedTooltips?: boolean
    /** Pass from parent when the parent owns `aria-describedby` (session list). */
    attentionTooltipId?: string
    scheduleTooltipId?: string
    className?: string
    /** Rows inside the pinned "in progress" section skip the text label (dot only). */
    inRunningSection?: boolean
    /** Short project name shown under the title (pinned "in progress" rows). */
    projectLabel?: string
    /** Machine label shown next to the project name (pinned "in progress" rows). */
    machineLabel?: string
}) {
    const {
        session: s,
        showPath = true,
        showDetailedStatus = true,
        selected = false,
        nestedTooltips = true,
        attentionTooltipId: attentionTooltipIdProp,
        scheduleTooltipId: scheduleTooltipIdProp,
        className,
        inRunningSection = false,
        projectLabel,
        machineLabel,
    } = props
    const { t } = useTranslation()
    const sessionName = getSessionTitle(s)
    const worktreeLabel = getWorktreeSessionLabel(s)
    const todoProgress = getTodoProgress(s)
    const attention = useMemo(
        () => showDetailedStatus
            ? classifySessionAttention(s, {
                selected,
                lastSeenAt: getSessionLastSeenAt(s.id),
            })
            : null,
        [s, selected, showDetailedStatus]
    )
    const attentionLabel = attention ? getAttentionLabel(attention, t) : null
    const urgentAttention = attention !== null
        && (attention.kind === 'permission' || attention.kind === 'input')
    const scheduledLabel = s.futureScheduledMessageCount > 1
        ? t('session.item.scheduledMessages', { count: s.futureScheduledMessageCount })
        : t('session.item.scheduledMessage')
    const hasScheduleTooltip = showDetailedStatus && s.futureScheduledMessageCount > 0
    const ownedIds = useSessionRowTooltipIds(
        Boolean(attention) && nestedTooltips && !attentionTooltipIdProp,
        hasScheduleTooltip && nestedTooltips && !scheduleTooltipIdProp
    )
    const attentionId = attentionTooltipIdProp ?? ownedIds.attentionId
    const scheduleId = scheduleTooltipIdProp ?? ownedIds.scheduleId
    const timeLabel = getSessionTimeLabel(s, t)

    return (
        <div className={`flex w-full min-w-0 flex-col gap-1 ${className ?? ''}`}>
            <div className={`grid grid-cols-[minmax(9rem,1fr)_minmax(0,max-content)] items-center gap-2 ${!s.active ? 'opacity-50' : ''}`}>
                <div className="flex min-w-0 items-center gap-2">
                    <AgentFlavorIcon flavor={s.metadata?.flavor} className="h-4 w-4 shrink-0 -translate-y-px" />
                    <div
                        className={`min-w-0 flex-1 truncate text-sm font-medium ${s.active ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                        title={sessionName}
                    >
                        {sessionName}
                    </div>
                    {s.active && s.thinking ? (
                        <LoaderIcon className="h-3.5 w-3.5 shrink-0 animate-spin-slow text-[var(--app-badge-success-text)]" />
                    ) : urgentAttention && nestedTooltips && attentionId ? (
                        <SessionAttentionIndicator
                            attention={attention}
                            summary={s}
                            label={attentionLabel ?? ''}
                            tooltipId={attentionId}
                        />
                    ) : urgentAttention ? (
                        <span
                            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${ATTENTION_DOT_CLASS[attention.kind]}`}
                            title={attentionLabel ?? undefined}
                            aria-label={attentionLabel ?? undefined}
                        />
                    ) : s.active && (s.backgroundTaskCount ?? 0) > 0 ? (
                        <span
                            className="inline-flex shrink-0 items-center gap-1 text-[var(--app-badge-success-text)]"
                            title={t('session.item.running')}
                        >
                            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
                            {!inRunningSection ? (
                                <span className="text-[11px] font-medium leading-none">{t('session.item.running')}</span>
                            ) : null}
                        </span>
                    ) : s.active && (s.pendingRequestsCount ?? 0) > 0 ? (
                        <span
                            className="inline-flex shrink-0 items-center gap-1 text-[var(--app-badge-warning-text)]"
                            title={t('session.item.pending')}
                        >
                            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
                            {!inRunningSection ? (
                                <span className="text-[11px] font-medium leading-none">{t('session.item.pending')}</span>
                            ) : null}
                        </span>
                    ) : attention && nestedTooltips && attentionId ? (
                        <SessionAttentionIndicator
                            attention={attention}
                            summary={s}
                            label={attentionLabel ?? ''}
                            tooltipId={attentionId}
                        />
                    ) : attention ? (
                        <span
                            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${ATTENTION_DOT_CLASS[attention.kind]}`}
                            title={attentionLabel ?? undefined}
                            aria-label={attentionLabel ?? undefined}
                        />
                    ) : null}
                    {hasScheduleTooltip && nestedTooltips && scheduleId ? (
                        <HoverTooltip
                            id={scheduleId}
                            target={<ScheduleIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />}
                            side="bottom"
                            align="start"
                            className="shrink-0"
                            revealOnParentFocusClass={SESSION_ROW_TOOLTIP_FOCUS_CLASS}
                        >
                            <span className="block">
                                <span className="block font-medium">{scheduledLabel}</span>
                                <span className="mt-1 block text-[var(--app-hint)]">
                                    {formatScheduledTooltipDetail(s, t)}
                                </span>
                            </span>
                        </HoverTooltip>
                    ) : hasScheduleTooltip ? (
                        <span className="shrink-0" aria-label={scheduledLabel} title={scheduledLabel}>
                            <ScheduleIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />
                        </span>
                    ) : null}
                </div>
                <div className="flex min-w-0 items-center justify-end gap-2 overflow-hidden text-xs">
                    {todoProgress ? (
                        <span className="flex shrink-0 items-center gap-1 text-[var(--app-hint)]">
                            <BulbIcon className="h-3 w-3" />
                            {todoProgress.completed}/{todoProgress.total}
                        </span>
                    ) : null}
                    {!attention && s.pendingRequestsCount > 0 ? (
                        <span className="shrink-0 text-[var(--app-badge-warning-text)]">
                            {t('session.item.pending')} {s.pendingRequestsCount}
                        </span>
                    ) : null}
                    {timeLabel ? (
                        <span className="min-w-0 truncate whitespace-nowrap tabular-nums text-[var(--app-hint)]">{timeLabel}</span>
                    ) : null}
                </div>
            </div>
            {projectLabel || machineLabel ? (
                <div className="truncate text-xs text-[var(--app-hint)]" title={[projectLabel, machineLabel].filter(Boolean).join(' · ')}>
                    {[projectLabel, machineLabel].filter(Boolean).join(' · ')}
                </div>
            ) : showPath || worktreeLabel ? (
                <div
                    className="truncate text-xs text-[var(--app-hint)]"
                    title={worktreeLabel
                        ? s.metadata?.worktree?.worktreePath ?? s.metadata?.path
                        : undefined}
                >
                    {worktreeLabel ?? s.metadata?.path ?? s.id}
                </div>
            ) : null}
        </div>
    )
}
