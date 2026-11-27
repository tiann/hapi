import { useHubClock } from '@/lib/app-context'
import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { SessionSummary } from '@/types/api'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { InfoIcon, LoaderIcon, ScheduleIcon, StoppedBadgeIcon } from '@/components/icons'
import { HoverTooltip, SESSION_ROW_TOOLTIP_FOCUS_CLASS, useSessionRowTooltipIds } from '@/components/HoverTooltip'
import { getAttentionLabel, SessionAttentionIndicator, SessionRequestIcon } from '@/components/SessionAttentionIndicator'
import { classifySessionAttention, sessionIsUnread } from '@/lib/sessionAttention'
import { getSessionLastSeenAt, getSessionManualUnreadAt } from '@/lib/sessionLastSeen'
import { formatRelativeTime } from '@/lib/relativeTime'
import { getStoppedSessionTime } from '@/lib/sessionListOrder'
import { formatScheduledTooltipDetail, formatTaskTooltipDetail, formatTaskTooltipLabel } from '@/lib/scheduledTime'
import { getCodexImportedAt, subscribeCodexImportedSessions } from '@/lib/codexImportedSessions'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { LOW_RATE_STRIPES_CLASS, useLowRateAnimation } from '@/hooks/useLowRateAnimation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'
import { SessionPrChip } from '@/components/SessionPrChip'
import { getPrimaryGithubPrRef, type PrChipDisplayProfile } from '@hapi/protocol'
import {
    attachedJobFraction,
    formatAttachedJobProgress,
    isAttachedJobStale
} from '@/lib/attachedJob'
import { hasUrgentModelError } from '@/components/ModelErrorBanner'

/** A repeat task: the same mark the Tasks bar uses, so the row and the bar read as one thing. */
function TaskRepeatIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
    t: (key: string, params?: Record<string, string | number>) => string,
    showStoppedTime: boolean
): string | null {
    if (importedAt !== null) {
        return formatCodexImportedRelativeTime(importedAt, t)
    }
    // In a list ordering stopped sessions by stop time (Active first), a stopped
    // row shows that time: its stop time when later than its last update.
    const time = showStoppedTime && !session.active ? getStoppedSessionTime(session) : session.updatedAt
    return formatRelativeTime(time, t)
}

const PRESENCE_BADGE_CLASS = {
    working: 'bg-[var(--app-badge-success-text)]',
    waiting: 'border-2 border-[var(--app-badge-success-text)] bg-[var(--app-bg)]',
    stopped: 'bg-[var(--app-bg)] text-[var(--app-hint)]',
} as const

/**
 * Presentational session row — same chrome as the sidebar SessionItem body
 * (flavor icon with presence badge, title, request/schedule symbols, todos,
 * relative time, path, optional attached-job meter). Visual language matches
 * the native apps for presence. A title-side spinner combines running activity
 * with unread state; unread at rest uses a foreground dot. The title dims when
 * the session is not resident. Used by the
 * session list and by rich-composer mention chip tooltips.
 */
export function SessionRowSummary(props: {
    session: SessionSummary
    showPath?: boolean
    showDetailedStatus?: boolean
    selected?: boolean
    /**
     * When false, attention has no nested HoverTooltip.
     * Use false inside an already-open chip tooltip portal.
     */
    nestedTooltips?: boolean
    /** Pass from parent when the parent owns `aria-describedby` (session list). */
    attentionTooltipId?: string
    /** Recompute local unread attention when the session-list watermark changes. */
    lastSeenVersion?: number
    scheduleTooltipId?: string
    /** Pass from parent when the parent owns `aria-describedby` (session list); names the task tooltip. */
    taskTooltipId?: string
    className?: string
    /** When enabled, show primary GitHub PR chip left of the time column (ADR D8). */
    githubPrAwarenessEnabled?: boolean
    /**
     * When false, omit the inline PR chip (parent renders an interactive chip
     * beside the row button to avoid nesting `<a>` inside `<button>`).
     */
    showPrChip?: boolean
    prChipDisplay?: PrChipDisplayProfile
    /** Shared minute clock from the session list (avoids per-row timers). */
    prNowMs?: number
    /** Rows inside the pinned "in progress" section skip the pending text label. */
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
    /** Show a stopped row's stop time, for lists that order stopped rows by it (Active first). */
    showStoppedTime?: boolean
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
        taskTooltipId: taskTooltipIdProp,
        className,
        githubPrAwarenessEnabled = false,
        showPrChip = true,
        prChipDisplay,
        prNowMs,
        inRunningSection = false,
        projectLabel,
        machineLabel,
        contentSnippet,
        contentSearchTruncated = false,
        trailingClassName,
        showStoppedTime = false,
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
    // Unread rows hand the agent icon to the attention tooltip as the "unread"
    // symbol, so it is no longer the presence badge and must not pulse.
    const plainUnreadTarget = attention?.kind === 'unread' && nestedTooltips && !attentionTooltipIdProp
    const urgentAttention = attention !== null
        && (attention.kind === 'permission' || attention.kind === 'input')
    const modelErrorActive = hasUrgentModelError(s.metadata)
    const modelErrorLabel = t('session.modelError.listIndicator')
    const scheduledLabel = s.futureScheduledMessageCount > 1
        ? t('session.item.scheduledMessages', { count: s.futureScheduledMessageCount })
        : t('session.item.scheduledMessage')
    const hasScheduleTooltip = showDetailedStatus && s.futureScheduledMessageCount > 0
    // Repeat and queue tasks the hub runs on its own; the tooltip says how many and when the next one goes out.
    const hasTaskTooltip = showDetailedStatus && s.activeTaskCount > 0
    const taskLabel = hasTaskTooltip ? formatTaskTooltipLabel(s, t) : ''
    const ownedIds = useSessionRowTooltipIds(
        Boolean(attention) && nestedTooltips && !attentionTooltipIdProp,
        hasScheduleTooltip && nestedTooltips && !scheduleTooltipIdProp,
        hasTaskTooltip && nestedTooltips && !taskTooltipIdProp
    )
    const attentionId = attentionTooltipIdProp ?? ownedIds.attentionId
    const scheduleId = scheduleTooltipIdProp ?? ownedIds.scheduleId
    const taskId = taskTooltipIdProp ?? ownedIds.taskId
    // Rows are memoized, so the label keeps itself current (also advances job elapsed).
    useMinuteTick()
    const nowMs = useHubClock()?.now() ?? Date.now()
    const codexSessionId = s.metadata?.flavor === 'codex' ? s.metadata?.agentSessionId : null
    const legacyImportedAt = useSyncExternalStore(subscribeCodexImportedSessions, () => getCodexImportedAt(codexSessionId))
    const importedAt = s.metadata?.codexImportedAt !== undefined ? s.metadata.codexImportedAt : legacyImportedAt
    const timeLabel = getSessionTimeLabel(s, importedAt, t, showStoppedTime)
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
    const primaryPrRef = githubPrAwarenessEnabled
        ? getPrimaryGithubPrRef(s.metadata?.externalRefs)
        : null

    // An attached process reports through its own meter, independently of the agent.
    const hasForegroundWork = s.active && (s.thinking || s.derivedToolWork === true)
    const isBackgroundOnly = s.active && !hasForegroundWork && (s.backgroundTaskCount ?? 0) > 0
    const hasRunningWork = hasForegroundWork || isBackgroundOnly
    const presence = hasRunningWork ? 'working' : s.active ? 'waiting' : 'stopped'
    const isUnread = sessionIsUnread(s, {
        lastSeenAt: getSessionLastSeenAt(s.id),
        manualUnreadAt: getSessionManualUnreadAt(s.id, s.readState),
    })
    const requestKind = urgentAttention
        ? attention.kind as 'permission' | 'input'
        : s.active && (s.pendingRequestsCount ?? 0) > 0
            ? (s.pendingRequestKinds?.length && !s.pendingRequestKinds.includes('permission') ? 'input' : 'permission')
            : null
    // While any work runs, the spinner colour carries unread; the bold title and
    // accented time are the at-rest look.
    const emphasizeUnread = isUnread && !hasRunningWork
    const activityLabel = hasForegroundWork ? t('session.item.running') : t('session.item.background')
    const pendingRequestId = s.pendingRequests?.[0]?.id

    // Idle indicators are animated by the one shared low-rate ticker, not CSS.
    // Refs are only read inside effects, so an unanimated render (presence
    // 'waiting', no model error) simply leaves a detached ref unused.
    const presenceRef = useRef<HTMLSpanElement | null>(null)
    const modelErrorRef = useRef<HTMLSpanElement | null>(null)
    const activityRef = useRef<SVGSVGElement | null>(null)
    const jobDotRef = useRef<HTMLSpanElement | null>(null)
    const jobStripesRef = useRef<HTMLSpanElement | null>(null)
    // Gated on the same conditions that mount the elements (hooks stay
    // unconditional), so a row with no idle indicator runs no ticker listener.
    // The presence badge lives in `agentIcon`, which may be handed to
    // `SessionAttentionIndicator` as a tooltip target, so the badge only pulses
    // in the plain (non-background-attention, non-unread) render path.
    useLowRateAnimation(presenceRef, 'pulse', presence === 'working' && !plainUnreadTarget)
    // The halo expands and fades (a ping), not a rotation: rotating a uniformly
    // colored circle shows no motion, so the attention cue would disappear.
    useLowRateAnimation(modelErrorRef, 'ping', modelErrorActive)
    useLowRateAnimation(activityRef, 'spin', hasRunningWork)
    useLowRateAnimation(jobDotRef, 'pulse', attachedJob !== null && !jobStale)
    useLowRateAnimation(jobStripesRef, 'stripes', attachedJob !== null && !jobStale && jobFraction === null)

    const agentIcon = (
        <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center">
            <AgentFlavorIcon flavor={s.metadata?.flavor} className="h-6 w-6" />
            <span
                ref={presenceRef}
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
                {/* Fade the disconnected title, keeping activity/unread indicators
                    and outliving job progress at full contrast. */}
                <div className="session-row-header grid grid-cols-[minmax(9rem,1fr)_minmax(0,max-content)] items-center gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <div
                            className={`min-w-0 flex-1 truncate text-sm text-[var(--app-fg)] ${emphasizeUnread ? 'font-semibold' : 'font-normal'} ${!s.active ? 'opacity-50' : ''}`}
                            title={sessionName}
                        >
                            {sessionName}
                        </div>
                        {/* Model error outranks activity/unread: the turn looked
                            finished but failed, so this must not be collapsed
                            into the combined indicator below. */}
                        {modelErrorActive ? (
                            <span
                                className="relative inline-flex h-2 w-2 shrink-0"
                                title={modelErrorLabel}
                                aria-label={modelErrorLabel}
                            >
                                <span data-testid="session-model-error-halo" ref={modelErrorRef} className="absolute inline-flex h-full w-full rounded-full bg-amber-500" />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                            </span>
                        ) : null}
                        {hasRunningWork ? (
                            <span data-testid="session-activity" data-activity={hasForegroundWork ? 'foreground' : 'background'} role="img" aria-label={activityLabel} title={activityLabel} className="inline-flex shrink-0">
                                <LoaderIcon ref={activityRef} className={`h-3.5 w-3.5 ${isUnread ? 'text-blue-500' : 'text-[var(--app-hint)]'}`} />
                            </span>
                        ) : isUnread && !requestKind ? (
                            <span data-testid="session-unread" className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-fg)]" aria-hidden="true" />
                        ) : null}
                        {isUnread ? (
                            <span id={attention?.kind === 'unread' && nestedTooltips ? attentionId : undefined} className="sr-only">
                                {t('session.item.newActivity')}
                            </span>
                        ) : null}
                        {requestKind && urgentAttention && nestedTooltips && attentionId ? (
                            <SessionAttentionIndicator
                                attention={attention}
                                summary={s}
                                label={attentionLabel ?? ''}
                                tooltipId={attentionId}
                                pendingRequestId={pendingRequestId}
                            />
                        ) : requestKind ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[var(--app-badge-warning-text)]">
                                <SessionRequestIcon
                                    kind={requestKind}
                                    label={attentionLabel ?? t('session.item.pending')}
                                    requestId={pendingRequestId}
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
                        {hasTaskTooltip && nestedTooltips && taskId ? (
                            <HoverTooltip
                                id={taskId}
                                target={<TaskRepeatIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />}
                                side="bottom"
                                align="start"
                                className="shrink-0"
                                revealOnParentFocusClass={SESSION_ROW_TOOLTIP_FOCUS_CLASS}
                            >
                                <span className="block">
                                    <span className="block font-medium">{taskLabel}</span>
                                    <span className="mt-1 block text-[var(--app-hint)]">
                                        {formatTaskTooltipDetail(s, t)}
                                    </span>
                                </span>
                            </HoverTooltip>
                        ) : hasTaskTooltip ? (
                            <span className="shrink-0" aria-label={taskLabel} title={taskLabel}>
                                <TaskRepeatIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />
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
                        {primaryPrRef && showPrChip ? (
                            <SessionPrChip
                                refs={s.metadata?.externalRefs}
                                displayProfile={prChipDisplay}
                                nowMs={prNowMs}
                                interactive={false}
                            />
                        ) : null}
                        {timeLabel ? (
                            <span className={`min-w-0 translate-y-[0.5px] truncate whitespace-nowrap tabular-nums ${
                                emphasizeUnread ? 'font-semibold text-[var(--app-link)]' : 'text-[var(--app-hint)]'
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
                            ref={jobDotRef}
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
                            aria-hidden="true"
                        />
                        {/* The label gives way first: progress, elapsed time and the stale
                            marker are the parts that change, so a long label must not hide them.
                            The label starts at zero and grows into what the status leaves free
                            (up to its full width); the status truncates only once the label is at its minimum. */}
                        <span className="flex min-w-0 items-center gap-1">
                            <span className="min-w-8 max-w-max flex-1 truncate font-medium">
                                {attachedJob.label}
                            </span>
                            <span data-testid="attached-job-status" className="min-w-0 truncate">
                                {jobStale ? (
                                    <span className="font-semibold">· {t('session.item.attachedJob.stale')}</span>
                                ) : null}
                                <span className="font-normal opacity-80">{jobStale ? ' · ' : '· '}{jobProgressLabel}</span>
                            </span>
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
                                    ref={jobStripesRef}
                                    className={LOW_RATE_STRIPES_CLASS}
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
