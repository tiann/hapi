import { useMemo, useSyncExternalStore } from 'react'
import type { SessionSummary } from '@/types/api'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { InfoIcon, ScheduleIcon, StoppedBadgeIcon } from '@/components/icons'
import { HoverTooltip, SESSION_ROW_TOOLTIP_FOCUS_CLASS, useSessionRowTooltipIds } from '@/components/HoverTooltip'
import { getAttentionLabel, SessionAttentionIndicator, SessionRequestIcon } from '@/components/SessionAttentionIndicator'
import { classifySessionAttention, sessionIsUnread } from '@/lib/sessionAttention'
import { getSessionLastSeenAt, getSessionManualUnreadAt } from '@/lib/sessionLastSeen'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatScheduledTooltipDetail } from '@/lib/scheduledTime'
import { getCodexImportedAt, subscribeCodexImportedSessions } from '@/lib/codexImportedSessions'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'
import {
    attachedJobFraction,
    formatAttachedJobProgress,
    isAttachedJobStale
} from '@/lib/attachedJob'

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

const PRESENCE_BADGE_CLASS = {
    working: 'bg-[var(--app-badge-success-text)] animate-pulse',
    background: 'bg-blue-400 animate-pulse',
    waiting: 'border-2 border-[var(--app-badge-success-text)] bg-[var(--app-bg)]',
    stopped: 'bg-[var(--app-bg)] text-[var(--app-hint)]',
} as const

/**
 * Presentational session row — same chrome as the sidebar SessionItem body
 * (flavor icon with presence badge, title, request/schedule symbols, todos,
 * relative time, path, optional attached-job meter). Visual language matches
 * the native apps: no dimmed rows or spinners; unread sessions have a
 * separate accent dot. Used by the session list and by rich-composer
 * mention chip tooltips.
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
    /** Context returned by the opt-in session message-content search. */
    contentSnippet?: string
    /** The indexed message exceeded the search index budget. */
    contentSearchTruncated?: boolean
    /** Extra classes for the right-hand time/progress cluster (e.g. to yield to hover actions). */
    trailingClassName?: string
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
        contentSnippet,
        contentSearchTruncated = false,
        trailingClassName,
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
    // Rows are memoized, so the label keeps itself current (also advances job elapsed).
    useMinuteTick()
    const nowMs = Date.now()
    const codexSessionId = s.metadata?.flavor === 'codex' ? s.metadata?.agentSessionId : null
    const importedAt = useSyncExternalStore(subscribeCodexImportedSessions, () => getCodexImportedAt(codexSessionId))
    const timeLabel = getSessionTimeLabel(s, importedAt, t)
    const attachedJob = s.attachedJob?.status === 'running' ? s.attachedJob : null
    const jobStale = attachedJob ? isAttachedJobStale(attachedJob, nowMs) : false
    const jobFraction = attachedJob ? attachedJobFraction(attachedJob) : null
    const jobProgressLabel = attachedJob
        ? formatAttachedJobProgress(attachedJob, nowMs, {
            left: t('session.item.attachedJob.left'),
            running: t('session.item.attachedJob.running'),
            noHeartbeat: t('session.item.attachedJob.noHeartbeat'),
        })
        : null

    // Presence lives on the agent icon and every state has its own mark, so no
    // state is shown by the absence of one: solid = working (pulsing), ring =
    // connected and waiting, power mark = stopped or archived. Blue is the
    // existing background-work state. An outliving attached job counts as
    // working even when the agent itself is idle or disconnected.
    const isRunning = s.active && s.thinking
    const isBackgroundOnly = s.active && !s.thinking && (s.backgroundTaskCount ?? 0) > 0
    const presence: 'working' | 'background' | 'waiting' | 'stopped' = isBackgroundOnly
        ? 'background'
        : isRunning || attachedJob
            ? 'working'
            : s.active
                ? 'waiting'
                : 'stopped'
    const isUnread = sessionIsUnread(s, {
        lastSeenAt: getSessionLastSeenAt(s.id),
        manualUnreadAt: getSessionManualUnreadAt(s.id, s.readState),
    })
    const requestKind = urgentAttention
        ? attention.kind as 'permission' | 'input'
        : s.active && (s.pendingRequestsCount ?? 0) > 0
            ? (s.pendingRequestKinds?.length && !s.pendingRequestKinds.includes('permission') ? 'input' : 'permission')
            : null
    const agentIcon = (
        <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center">
            <AgentFlavorIcon flavor={s.metadata?.flavor} className="h-6 w-6" />
            <span
                data-testid="session-presence"
                data-presence={presence}
                className={`absolute -bottom-0.5 -right-0.5 box-border flex h-2.5 w-2.5 items-center justify-center rounded-full ring-2 ring-[var(--app-bg)] ${PRESENCE_BADGE_CLASS[presence]}`}
            >
                {presence === 'stopped' ? <StoppedBadgeIcon className="h-2.5 w-2.5" /> : null}
            </span>
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
                            <>
                                <span data-testid="session-unread" className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden="true" />
                                <span id={attention?.kind === 'unread' && nestedTooltips ? attentionId : undefined} className="sr-only">
                                    {t('session.item.newActivity')}
                                </span>
                            </>
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
                    <div className={`flex min-w-0 items-center justify-end gap-2 overflow-hidden text-xs ${trailingClassName ?? ''}`}>
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
                {attachedJob && jobProgressLabel ? (
                    <div
                        className={`flex min-w-0 items-center gap-2 text-[11px] leading-none ${
                            jobStale
                                ? 'text-[var(--app-badge-warning-text)]'
                                : 'text-[var(--app-badge-success-text)]'
                        }`}
                        title={
                            jobStale
                                ? t('session.item.attachedJob.staleTitle', {
                                    detail: attachedJob.detail ?? attachedJob.label,
                                })
                                : (attachedJob.detail ?? attachedJob.label)
                        }
                    >
                        <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${jobStale ? '' : 'animate-pulse'}`}
                            aria-hidden="true"
                        />
                        <span className="min-w-0 truncate font-medium">
                            {attachedJob.label}
                            {jobStale ? (
                                <span className="font-semibold"> · {t('session.item.attachedJob.stale')}</span>
                            ) : null}
                            <span className="font-normal opacity-80"> · {jobProgressLabel}</span>
                        </span>
                        {jobFraction !== null ? (
                            <span
                                data-testid="attached-job-progress-bar"
                                data-progress="determinate"
                                className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--app-border)]"
                                role="progressbar"
                                aria-label={attachedJob.label}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(jobFraction * 100)}
                            >
                                <span
                                    className="block h-full rounded-full bg-current transition-[width] duration-300"
                                    style={{ width: `${Math.round(jobFraction * 100)}%` }}
                                />
                            </span>
                        ) : (
                            <span
                                data-testid="attached-job-progress-bar"
                                data-progress="indeterminate"
                                className="relative ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--app-border)]"
                                role="progressbar"
                                aria-label={attachedJob.label}
                            >
                                {/* No aria-valuenow: unknown amount (ARIA indeterminate). No inline width%. */}
                                <span
                                    className="animate-attached-job-indeterminate"
                                    aria-hidden="true"
                                />
                            </span>
                        )}
                    </div>
                ) : null}
                {contentSnippet ? (
                    <div
                        className="line-clamp-2 text-xs text-[var(--app-fg)]/80"
                        title={contentSearchTruncated
                            ? `${contentSnippet}\n${t('sessions.search.content.truncated')}`
                            : contentSnippet}
                    >
                        {contentSnippet}
                        {contentSearchTruncated ? (
                            <span
                                className="ml-1 inline-flex align-[-2px] text-[var(--app-badge-warning-text)]"
                                title={t('sessions.search.content.truncated')}
                                aria-label={t('sessions.search.content.truncated')}
                            >
                                <InfoIcon className="h-3 w-3" />
                            </span>
                        ) : null}
                    </div>
                ) : null}
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
