import { useMemo, useSyncExternalStore } from 'react'
import type { SessionSummary } from '@/types/api'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { ScheduleIcon } from '@/components/icons'
import { HoverTooltip, SESSION_ROW_TOOLTIP_FOCUS_CLASS, useSessionRowTooltipIds } from '@/components/HoverTooltip'
import { getAttentionLabel, SessionAttentionIndicator, SessionRequestIcon } from '@/components/SessionAttentionIndicator'
import { classifySessionAttention } from '@/lib/sessionAttention'
import { getSessionLastSeenAt, getSessionManualUnreadAt } from '@/lib/sessionLastSeen'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatScheduledTooltipDetail } from '@/lib/scheduledTime'
import { getCodexImportedAt, subscribeCodexImportedSessions } from '@/lib/codexImportedSessions'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'

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
    importedAt: number | null,
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    if (importedAt !== null) {
        return formatCodexImportedRelativeTime(importedAt, t)
    }
    return formatRelativeTime(session.updatedAt, t)
}

/**
 * Presentational session row — same chrome as the sidebar SessionItem body
 * (flavor icon with presence badge, title, request/schedule symbols, todos,
 * relative time, path). Visual language matches the native apps: no dimmed
 * rows or spinners; unread is a semibold title + accent time, not a dot.
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
    /** Recompute local unread attention when the session-list watermark changes. */
    lastSeenVersion?: number
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
        lastSeenVersion,
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
                manualUnreadAt: getSessionManualUnreadAt(s.id, s.readState),
            })
            : null,
        [s, selected, showDetailedStatus, lastSeenVersion]
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
    // Rows are memoized, so the label keeps itself current.
    useMinuteTick()
    const codexSessionId = s.metadata?.flavor === 'codex' ? s.metadata?.agentSessionId : null
    const importedAt = useSyncExternalStore(subscribeCodexImportedSessions, () => getCodexImportedAt(codexSessionId))
    const timeLabel = getSessionTimeLabel(s, importedAt, t)

    // Presence lives on the agent icon (pulsing while a turn or background
    // work runs) instead of dimming disconnected rows or adding spinners.
    const isRunning = s.active && s.thinking
    const isBackgroundOnly = s.active && !s.thinking && (s.backgroundTaskCount ?? 0) > 0
    // Unread is a semibold title plus accent time — no dot, so the presence
    // badge stays the row's only dot. The label stays for screen readers.
    const isUnread = attention?.kind === 'unread'
    const requestKind = urgentAttention
        ? attention.kind as 'permission' | 'input'
        : s.active && (s.pendingRequestsCount ?? 0) > 0
            ? (s.pendingRequestKinds?.length && !s.pendingRequestKinds.includes('permission') ? 'input' : 'permission')
            : null
    const agentIcon = (
        <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center">
            <AgentFlavorIcon flavor={s.metadata?.flavor} className="h-6 w-6" />
            {s.active ? (
                <span
                    data-testid="session-presence"
                    className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--app-bg)] ${
                        isBackgroundOnly ? 'bg-blue-400' : 'bg-[var(--app-badge-success-text)]'
                    } ${isRunning || isBackgroundOnly ? 'animate-pulse' : ''}`}
                />
            ) : null}
        </span>
    )

    return (
        <div className={`flex w-full min-w-0 items-center gap-2.5 ${className ?? ''}`}>
            {attention?.kind === 'background' && nestedTooltips && attentionId ? (
                <SessionAttentionIndicator
                    attention={attention}
                    summary={s}
                    label={attentionLabel ?? ''}
                    tooltipId={attentionId}
                    target={agentIcon}
                />
            ) : agentIcon}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="grid grid-cols-[minmax(9rem,1fr)_minmax(0,max-content)] items-center gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <div
                            className={`min-w-0 flex-1 truncate text-sm text-[var(--app-fg)] ${isUnread ? 'font-semibold' : 'font-normal'}`}
                            title={sessionName}
                        >
                            {sessionName}
                        </div>
                        {isUnread ? (
                            <span id={nestedTooltips ? attentionId : undefined} className="sr-only">
                                {attentionLabel}
                            </span>
                        ) : null}
                        {requestKind && urgentAttention && nestedTooltips && attentionId ? (
                            <SessionAttentionIndicator
                                attention={attention}
                                summary={s}
                                label={attentionLabel ?? ''}
                                tooltipId={attentionId}
                            />
                        ) : requestKind ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[var(--app-badge-warning-text)]">
                                <SessionRequestIcon
                                    kind={requestKind}
                                    label={attentionLabel ?? t('session.item.pending')}
                                />
                                {!urgentAttention && !inRunningSection ? (
                                    <span className="text-[11px] font-medium leading-none">{t('session.item.pending')}</span>
                                ) : null}
                            </span>
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
                        {!attention && s.active && s.pendingRequestsCount > 0 ? (
                            <span className="shrink-0 text-[var(--app-badge-warning-text)]">
                                {t('session.item.pending')} {s.pendingRequestsCount}
                            </span>
                        ) : null}
                        {timeLabel ? (
                            <span className={`min-w-0 truncate whitespace-nowrap tabular-nums ${
                                isUnread ? 'font-semibold text-[var(--app-link)]' : 'text-[var(--app-hint)]'
                            }`}>{timeLabel}</span>
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
        </div>
    )
}
