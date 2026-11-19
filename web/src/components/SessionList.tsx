import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { SessionListScrollAnchor } from './SessionListScrollAnchor'
import type { SessionContentSearchResponse, SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import {
    buildSessionSearchScoreIndex,
    compareSessionsBySearchRelevance,
    rankSessionGroupsBySearchRelevance,
    sessionMatchesQuery,
    sortSessionsBySearchRelevance,
} from '@/lib/sessionListSearch'
import { useLongPress } from '@/hooks/useLongPress'
import { useLowRateAnimation } from '@/hooks/useLowRateAnimation'
import { usePlatform } from '@/hooks/usePlatform'
import { sessionArchiveMutationKey, sessionPinMutationKey, useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useIsMutating } from '@tanstack/react-query'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { LinkPrDialog } from '@/components/LinkPrDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ArchiveSessionDialog } from '@/components/ArchiveSessionDialog'
import { DeleteSessionDialog } from '@/components/DeleteSessionDialog'
import { ProjectGroupRow } from '@/components/ProjectGroupRow'
import { ArchiveIcon, CheckIcon, CopyIcon, InfoIcon, LoaderIcon, MarkAllReadIcon, PinOffIcon } from '@/components/icons'
import { useFue } from '@/lib/use-fue'
import { FueCallout, FueDot } from '@/components/Fue'

function PinnedSectionIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={props.className} aria-hidden="true">
            <path d="M12 17v5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d="M5 17h14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d="M7 4V2h10v2l-2 5v4l2 2H7l2-2V9Z" />
        </svg>
    )
}

function MoreHorizontalIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
    )
}

/**
 * Small status dot whose pulse (when enabled) comes from the shared low-rate
 * ticker rather than a running CSS animation. `className` carries size/color.
 */
function LowRatePulseDot({ pulse, className }: { pulse: boolean; className: string }) {
    const ref = useRef<HTMLSpanElement | null>(null)
    useLowRateAnimation(ref, 'pulse', pulse)
    return <span ref={ref} className={className} aria-hidden="true" />
}

/** Narrow-header overflow for shed secondary actions (tiann/hapi#2039). */
function SessionListHeaderOverflow(props: { children: ReactNode }) {
    const { t } = useTranslation()
    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    data-testid="session-list-header-overflow"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    title={t('sessions.toolbar.more')}
                    aria-label={t('sessions.toolbar.more')}
                >
                    <MoreHorizontalIcon className="h-5 w-5" />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="end"
                    sideOffset={6}
                    className="z-50 flex max-w-[min(100vw-1rem,20rem)] flex-wrap items-center justify-end gap-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-xl"
                >
                    {props.children}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { DEFAULT_SESSION_PREVIEW_LIMIT, useSessionPreviewLimit } from '@/hooks/useSessionPreviewLimit'
import { useSessionListStatusMode } from '@/hooks/useSessionListStatusMode'
import { DEFAULT_SESSION_LIST_VIEW, useSessionListView, type SessionListView } from '@/hooks/useSessionListView'
import { SessionListViewMenu } from '@/components/SessionListViewMenu'
import { useKeepUnreadSessionsVisible } from '@/hooks/useKeepUnreadSessionsVisible'
import {
    usePinInProgressSessions,
    type PinInProgressMode
} from '@/hooks/usePinInProgressSessions'
import {
    hasAgentForegroundWork,
    hasRunningAttachedJob,
} from '@/lib/sessionInProgress'
import {
    BLOCKED_ALERT_PULSE_MS,
    useBlockedAlertMode,
    type BlockedAlertMode
} from '@/hooks/useBlockedAlertMode'
import { playBlockedAlertSound } from '@/lib/blockedAlertSound'
import { useShowActiveSessionsOnly } from '@/hooks/useShowActiveSessionsOnly'
import {
    compareDescWithKeyTiebreak,
    compareSessionsByOrderKeyDesc
} from '@hapi/protocol'
import { createSessionComparator, getSessionSortKey } from '@/lib/sessionListOrder'
import {
    classifySessionAttention,
    getSessionBlockedLabelKey,
    getSessionBlockedState,
    sessionBlockedIsError,
    sessionIsBlocked,
    sessionIsUnread
} from '@/lib/sessionAttention'
import {
    getSessionLastSeenAt,
    getSessionLastSeenSnapshot,
    getSessionManualUnreadAt,
    getUnreadSessionCount,
    markAllSessionsSeen,
    markSessionUnread,
    useSessionLastSeenVersion
} from '@/lib/sessionLastSeen'
import { useSessionRowTooltipIds } from '@/components/HoverTooltip'
import { formatReopenError } from '@/lib/reopenError'
import { resolveCursorReopenGate } from '@/lib/sessionResume'
import { getSessionTitle, hasSessionTitleSignal } from '@/lib/sessionTitle'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'
import { getSessionProjectLabel, getSessionProjectPath } from '@/lib/sessionProjectLabel'
import { retargetSharePendingTransfer } from '@/lib/sharePendingState'
import type { Machine } from '@/types/api'
import { getMachinePlatform, presentMachineHealth } from '@/lib/machineHealth'
import { MachineFilterBar, MachineSummaryRow } from '@/components/MachineFilterBar'
import { useSessionListMachineFilter } from '@/hooks/useSessionListMachineFilter'
import { useForkFlow } from '@/hooks/useForkFlow'
import { ForkPreviewDialog } from '@/components/AssistantChat/ForkPreviewDialog'
import { useTransientScrollbar } from '@/hooks/useTransientScrollbar'
import { useCursorChatStoreStatus } from '@/hooks/queries/useCursorChatStoreStatus'
import { useFeatures, type FeaturesResponse } from '@/hooks/queries/useFeatures'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { SessionRowSummary } from '@/components/SessionRowSummary'
import {
    DEFAULT_PR_CHIP_DISPLAY,
    getPrimaryGithubPrRef,
    resolveGithubPrChipDisplay
} from '@hapi/protocol'
import { formatGithubPrChipDetailParts, SessionPrChip } from '@/components/SessionPrChip'
import { useScratchlistSessionIds } from '@/hooks/queries/useScratchlistSessionIds'
import { CalendarIcon, formatDateValue, parseLocalDate, SessionDateRangePicker } from '@/components/SessionDateFilter'
import { UnblockReasonDialog } from '@/components/UnblockReasonDialog'
import { Spinner } from '@/components/Spinner'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { useAddToast } from '@/lib/toast-context'
import {
    shedToolbarSlots,
    toolbarActionBudget,
    TOOLBAR_GAP_PX,
    TOOLBAR_ICON_PX,
    TOOLBAR_MORE_PX,
    type ToolbarShedSlot
} from '@/components/sessionToolbarShed'

/** Hit targets that must stay visible: icon, clear, calendar. Not the query text. */
function measureSearchChrome(search: HTMLElement): number {
    const parts = [...search.querySelectorAll<HTMLElement>('[data-toolbar-chrome]')]
    if (parts.length === 0) return search.offsetWidth
    const gap = Number.parseFloat(getComputedStyle(search).columnGap) || 0
    const trigger = search.querySelector('button')
    const triggerStyle = trigger ? getComputedStyle(trigger) : null
    const triggerPad = triggerStyle
        ? (Number.parseFloat(triggerStyle.paddingLeft) || 0) + (Number.parseFloat(triggerStyle.paddingRight) || 0)
        : 0
    return parts.reduce((sum, el) => sum + el.offsetWidth, 0) + triggerPad + gap * Math.max(0, parts.length - 1)
}

export type SessionToolbarExtra = {
    id: string
    /** Higher sheds into More first. See sessionToolbarShed.ts. */
    keep: number
    node: ReactNode
    widthPx?: number
}

export { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'

type SessionGroup = {
    key: string
    directory: string
    displayName: string
    machineId: string | null
    sessions: SessionSummary[]
    latestOrderAt: number
    hasActiveSession: boolean
    hasPinnedSession: boolean
}

export type SessionSearchMode = 'default' | 'exclude'
const MIN_CONTENT_SEARCH_QUERY_LENGTH = 2

const RUNNING_BUCKETS = [
    { key: 'jobs', labelKey: 'session.item.attachedJob', colorClass: 'text-[var(--app-badge-success-text)]', pulse: true },
    { key: 'working', labelKey: 'session.item.running', colorClass: 'text-[var(--app-badge-success-text)]', pulse: true },
    { key: 'pending', labelKey: 'session.item.pending', colorClass: 'text-[var(--app-badge-warning-text)]', pulse: true },
] as const

type RunningBucketKey = (typeof RUNNING_BUCKETS)[number]['key']

/** True when the agent is working or waiting on the operator — not merely connected. */
function hasAgentInProgressActivity(session: SessionSummary): boolean {
    if (!session.active) {
        return false
    }
    return hasAgentForegroundWork(session)
        || (session.pendingRequestsCount ?? 0) > 0
}

export function emptyRunningBuckets(): Record<RunningBucketKey, SessionSummary[]> {
    return { jobs: [], working: [], pending: [] }
}

/**
 * Split sessions into the in-progress / active sub-buckets the pinned sections
 * render. Pure so the bucketing rules stay testable. Quiet connected never
 * floats (#1404); keepalive-idle zombies (#1820) also stay out unless they have
 * agent activity or a running attached job.
 */
export function bucketRunningSessions(
    sessions: SessionSummary[],
    pinInProgressMode: PinInProgressMode,
    compare: (a: SessionSummary, b: SessionSummary) => number = compareSessionsByOrderKeyDesc
): Record<RunningBucketKey, SessionSummary[]> {
    const buckets = emptyRunningBuckets()
    if (pinInProgressMode === 'off') {
        return buckets
    }
    for (const session of sessions) {
        if (session.globalPinned || session.pinned) {
            continue
        }
        if (!isPinnedInProgressSession(session, pinInProgressMode)) {
            continue
        }
        const agentWorking = hasAgentForegroundWork(session)
        const agentPending = session.active
            && (session.pendingRequestsCount ?? 0) > 0
            && !agentWorking
        if (agentWorking) {
            buckets.working.push(session)
        } else if (agentPending) {
            // Operator action outranks the Jobs meter when both apply.
            buckets.pending.push(session)
        } else if (hasRunningAttachedJob(session)) {
            // Outliving job while agent is idle — not foreground "Running".
            buckets.jobs.push(session)
        }
        // Quiet connected never reaches here: isPinnedInProgressSession excludes it.
    }
    for (const key of Object.keys(buckets) as RunningBucketKey[]) {
        buckets[key].sort(compare)
    }
    return buckets
}

/**
 * Sessions that float into the pinned In progress section.
 * Mode is a degree: off → jobs (outliving attachedJob) → all (jobs + working + pending).
 * Quiet connected (socket up, not working, not pending) never floats — that is not
 * in-progress work. Storage key `all` is historical; UI copy says Working & pending.
 */
export function isPinnedInProgressSession(
    session: SessionSummary,
    mode: PinInProgressMode
): boolean {
    if (mode === 'off') {
        return false
    }
    if (mode === 'jobs') {
        return hasRunningAttachedJob(session)
    }
    return hasRunningAttachedJob(session) || hasAgentInProgressActivity(session)
}

/**
 * Fires the arrival alert when a session *becomes* blocked (#1717).
 *
 * Keyed on session ids rather than the count, because a count alone cannot
 * tell "one resolved, another arrived" from "nothing happened" — that swap
 * nets to zero and would silently skip the alert on the new blocker.
 *
 * The alert deadline is state, not a timer owned by this effect: the blocked
 * id list churns constantly at fleet scale, and an effect that re-runs would
 * otherwise cancel its own pending clear and leave the counter pulsing
 * forever.
 *
 * `ready` gates the baseline. The router mounts this list with `sessions={[]}`
 * while `/sessions` is in flight, so seeding on the literal first render would
 * make every cold page load read its entire pre-existing backlog as brand new
 * and — in sound mode — buzz at you on every refresh.
 */
function useBlockedArrivalAlert(
    blockedIds: string[],
    mode: BlockedAlertMode,
    ready: boolean
): boolean {
    const [alertUntil, setAlertUntil] = useState(0)
    const [now, setNow] = useState(0)
    const seenRef = useRef<Set<string> | null>(null)

    const key = blockedIds.join(',')
    useEffect(() => {
        if (!ready) return
        const current = new Set(blockedIds)
        const seen = seenRef.current
        seenRef.current = current

        if (seen === null) return
        const arrived = blockedIds.some(id => !seen.has(id))
        if (!arrived || mode === 'count') return

        setAlertUntil(Date.now() + BLOCKED_ALERT_PULSE_MS)
        if (mode === 'sound') playBlockedAlertSound()
    }, [key, mode, ready]) // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (alertUntil === 0) return
        const remaining = alertUntil - Date.now()
        if (remaining <= 0) {
            setAlertUntil(0)
            return
        }
        const timer = setTimeout(() => {
            setAlertUntil(0)
            setNow(value => value + 1)
        }, remaining)
        return () => clearTimeout(timer)
    }, [alertUntil])

    void now
    return alertUntil > 0
}

export type BlockedJumpDirection = 'none' | 'up' | 'down' | 'both'

const BLOCKED_DIRECTION_GLYPH: Record<BlockedJumpDirection, string | null> = {
    none: null,
    up: '\u2191',
    down: '\u2193',
    both: '\u2195'
}

function BlockedFilterIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
            <path d="M3 5h18l-7 8v6l-4 2v-8Z" />
        </svg>
    )
}

function BlockedFlagIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
            <path d="M4 21V4h13l-2 4 2 4H4" />
        </svg>
    )
}

/**
 * Always-visible blocked counter (#1717).
 *
 * This is the off-viewport answer. Edge chevrons cannot do this job: the
 * session list collapses directory groups and caps each group's preview, so a
 * blocked row is frequently not merely scrolled out of view but absent from
 * the DOM entirely — a "scroll down" hint would strand the operator on a
 * collapsed header. A header counter is always on screen, states a number, and
 * its click makes the row reachable before travelling to it.
 *
 * Deliberately a plain action button, not a toggle: the blocked-only lens is
 * its own sibling control below, so keyboard and assistive activation reach
 * both behaviours natively rather than depending on a long-press gesture.
 */
function BlockedJumpPill(props: {
    count: number
    direction: BlockedJumpDirection
    /** Briefly true after a NEW blocker arrives — see `useBlockedArrivalAlert`. */
    alerting: boolean
    onJump: () => void
}) {
    const { t } = useTranslation()
    const glyph = BLOCKED_DIRECTION_GLYPH[props.direction]
    const label = t('sessions.blocked.jump', { count: props.count })

    return (
        <button
            type="button"
            onClick={props.onJump}
            data-testid="blocked-jump-pill"
            title={label}
            aria-label={label}
            className={cn(
                'flex h-9 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                'border-[var(--app-badge-warning-border)] text-[var(--app-badge-warning-text)] hover:bg-[var(--app-badge-warning-bg)]',
                // Pulse only on arrival, never continuously: a permanent pulse
                // at fleet scale is wallpaper within a day, and this needs to
                // still mean something on day 200.
                props.alerting ? 'bg-[var(--app-badge-warning-bg)] animate-blocked-alert' : ''
            )}
        >
            <BlockedFlagIcon className="h-3.5 w-3.5" />
            <span>{props.count}</span>
            {glyph ? <span aria-hidden="true">{glyph}</span> : null}
        </button>
    )
}

/** Blocked-only lens, mirroring the existing unread-only header toggle. */
function BlockedLensToggle(props: {
    active: boolean
    count: number
    onToggle: () => void
}) {
    const { t } = useTranslation()
    const label = props.active
        ? t('sessions.blockedFilter.showingOnly', { count: props.count })
        : t('sessions.blockedFilter.hint')

    return (
        <button
            type="button"
            onClick={props.onToggle}
            data-testid="blocked-lens-toggle"
            aria-pressed={props.active}
            title={label}
            aria-label={label}
            className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                props.active
                    ? 'bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]'
                    : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
            )}
        >
            <BlockedFilterIcon className="h-4 w-4" />
        </button>
    )
}

export type SessionTimeRange = {
    start: number | null
    end: number | null
}

export function getSessionTimeRange(start: string, end: string): SessionTimeRange | null {
    const startDate = parseLocalDate(start)
    const endDate = parseLocalDate(end)
    if (!startDate || !endDate) return null
    if (endDate) endDate.setDate(endDate.getDate() + 1)
    return { start: startDate.getTime(), end: endDate.getTime() }
}

export function sessionMatchesTimeRange(
    session: SessionSummary,
    range: SessionTimeRange | null,
    selectedSessionId?: string | null
): boolean {
    if (!range || session.id === selectedSessionId) return true
    if (range.start !== null && session.updatedAt < range.start) return false
    if (range.end !== null && session.updatedAt >= range.end) return false
    return true
}
function SessionsEmptyState(props: {
    onNewSession: () => void
    onBrowse?: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="44"
                height="44"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[var(--app-hint)] opacity-60"
            >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18" />
                <path d="M8 14h8" />
                <path d="M8 17h5" />
            </svg>
            <div className="text-base font-medium text-[var(--app-fg)]">
                {t('sessions.empty.title')}
            </div>
            <div className="max-w-sm text-sm text-[var(--app-hint)]">
                {t('sessions.empty.hint')}
            </div>
            <div className="flex items-center gap-2 mt-2">
                <button
                    type="button"
                    onClick={props.onNewSession}
                    className="px-4 py-1.5 text-sm rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium hover:opacity-90 transition-opacity"
                >
                    {t('sessions.empty.startSession')}
                </button>
                {props.onBrowse && (
                    <button
                        type="button"
                        onClick={props.onBrowse}
                        className="px-4 py-1.5 text-sm rounded-lg border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                    >
                        {t('sessions.empty.browse')}
                    </button>
                )}
            </div>
        </div>
    )
}

type MachineGroup = {
    machineId: string | null
    label: string
    projectGroups: SessionGroup[]
    totalSessions: number
    hasActiveSession: boolean
    hasPinnedSession: boolean
    latestOrderAt: number
}

export const UNKNOWN_MACHINE_ID = '__unknown__'
export const GROUP_SESSION_PREVIEW_LIMIT = DEFAULT_SESSION_PREVIEW_LIMIT

const MACHINE_LOCAL_AGENT_FLAVORS = new Set(['codex', 'claude', 'pi', 'opencode'])

export function getSessionDedupKey(session: SessionSummary): string | null {
    const agentId = session.metadata?.agentSessionId?.trim()
    if (!agentId) return null
    // Scope by flavor: agentSessionId is flattened from native ids and can retain a
    // stale cross-flavor value (codexSessionId ?? claudeSessionId ?? ...).
    const flavor = session.metadata?.flavor ?? 'unknown'
    // These native ids live in one machine's local store, and the hub keeps
    // sessions recorded on different machines apart: hiding one behind the
    // other would make an imported session look deleted.
    const machineId = MACHINE_LOCAL_AGENT_FLAVORS.has(flavor) ? session.metadata?.machineId : undefined
    return machineId ? `${flavor}:${machineId}:${agentId}` : `${flavor}:${agentId}`
}

export function deduplicateSessionsByAgentId(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    const byAgentId = new Map<string, SessionSummary[]>()
    const result: SessionSummary[] = []

    for (const session of sessions) {
        const dedupKey = getSessionDedupKey(session)
        if (!dedupKey) {
            result.push(session)
            continue
        }
        const group = byAgentId.get(dedupKey)
        if (group) {
            group.push(session)
        } else {
            byAgentId.set(dedupKey, [session])
        }
    }

    for (const group of byAgentId.values()) {
        group.sort((a, b) => {
            // Active session always wins — it's the live connection
            if (a.active !== b.active) return a.active ? -1 : 1
            // Among inactive duplicates, keep the selected one visible
            if (a.id === selectedSessionId) return -1
            if (b.id === selectedSessionId) return 1
            // Preserve an explicit pin when otherwise choosing by recency
            if (Boolean(a.globalPinned) !== Boolean(b.globalPinned)) return a.globalPinned ? -1 : 1
            if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
            return b.updatedAt - a.updatedAt
        })
        const winner = group[0]!
        result.push(winner)
        // Hub skips merge when two rows stay active — keep job-bearing losers so the
        // outliving meter is not hidden behind a jobless duplicate winner.
        // A second live Claude row is a real process the hub will not merge;
        // hiding it would leave no way to reach (or stop) it.
        for (const duplicate of group.slice(1)) {
            if (hasRunningAttachedJob(duplicate) || (duplicate.active && duplicate.metadata?.flavor === 'claude')) {
                result.push(duplicate)
            }
        }
    }

    return result
}

export function isSidebarEmptySessionStub(session: SessionSummary): boolean {
    if (session.active || session.hasConversationContent) return false
    const meta = session.metadata
    if (!meta) return true
    if (meta.agentSessionId?.trim()) return false
    if (hasSessionTitleSignal(session)) return false
    return true
}

export function shouldShowSessionInSidebar(session: SessionSummary, selectedSessionId?: string | null): boolean {
    if (session.id === selectedSessionId) return true
    // Running attached jobs must survive before the empty-stub filter — a job can
    // register before agentSessionId/name/summary land, and idle agents still
    // need the outliving meter visible in the list.
    if (
        session.active
        || session.pinned
        || session.globalPinned
        || hasRunningAttachedJob(session)
    ) {
        return true
    }
    return !isSidebarEmptySessionStub(session)
}

export function prepareSidebarSessions(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return deduplicateSessionsByAgentId(sessions, selectedSessionId)
        .filter(session => shouldShowSessionInSidebar(session, selectedSessionId))
}

// "Active sessions only" view: hide inactive sessions, but never hide the one the
// operator currently has open — otherwise toggling the filter would yank the
// selected session out from under them. Idle sessions with a running attached
// job stay visible too — that is the headline use case for session jobs.
export function filterActiveSessionsOnly(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return sessions.filter(session =>
        session.active
        || session.id === selectedSessionId
        || hasRunningAttachedJob(session)
    )
}

/**
 * List-view status filter with the #1404 jobs exception on "active": idle rows
 * that still have a running attachedJob stay visible (and stay out of archived).
 */
export function filterSessionsForListStatus(
    sessions: SessionSummary[],
    status: SessionListView['status'],
    selectedSessionId?: string | null
): SessionSummary[] {
    if (status === 'all') return sessions
    if (status === 'active') return filterActiveSessionsOnly(sessions, selectedSessionId)
    return sessions.filter(session =>
        session.id === selectedSessionId
        || (!session.active && !hasRunningAttachedJob(session))
    )
}

// "Unread only" view: same rule as above, the open session always stays visible.
export function filterUnreadSessionsOnly<T extends Pick<SessionSummary, 'id'>>(
    sessions: T[],
    isUnread: (session: T) => boolean,
    selectedSessionId?: string | null
): T[] {
    return sessions.filter(session => session.id === selectedSessionId || isUnread(session))
}

// "Working only" view (#2002): same predicate as the running-sessions
// "working" bucket — mid-turn or driving a background task, not merely
// connected. The selected session stays visible, same rule as the other
// ephemeral lenses.
export function filterWorkingSessionsOnly(
    sessions: SessionSummary[],
    selectedSessionId?: string | null
): SessionSummary[] {
    return sessions.filter(session =>
        session.id === selectedSessionId
        || hasAgentForegroundWork(session)
    )
}

// Keep the open session visible while filtering so changing the lens never
// removes the conversation currently shown in the main pane.
export function filterScratchlistSessionsOnly(
    sessions: SessionSummary[],
    selectedSessionId: string | null | undefined,
    scratchlistSessionIds: ReadonlySet<string>
): SessionSummary[] {
    return sessions.filter(session =>
        session.id === selectedSessionId
        || scratchlistSessionIds.has(session.id)
    )
}

// Paginated session previews move one batch at a time in either direction.
// Counts always stay within the configured preview floor and the group total.
export function getNextSessionVisibleCount(current: number, step: number, total: number): number {
    return Math.min(current + Math.max(1, step), total)
}

export function getPreviousSessionVisibleCount(current: number, step: number): number {
    const normalizedStep = Math.max(1, step)
    return Math.max(normalizedStep, current - normalizedStep)
}

// Without a view this is the long-standing order: by the user's last message,
// so agent output and liveness never reorder the list.
const LEGACY_LIST_ORDER: Pick<SessionListView, 'sort' | 'activeFirst'> = { sort: 'last-message', activeFirst: false }

export function groupSessionsByDirectory(
    sessions: SessionSummary[],
    order: Pick<SessionListView, 'sort' | 'activeFirst'> = LEGACY_LIST_ORDER
): SessionGroup[] {
    const compare = createSessionComparator(order)
    const groups = new Map<string, { directory: string; machineId: string | null; sessions: SessionSummary[] }>()

    sessions.forEach(session => {
        const path = getSessionProjectPath(session.metadata) ?? 'Other'
        const machineId = session.metadata?.machineId ?? null
        const key = `${machineId ?? UNKNOWN_MACHINE_ID}::${path}`
        if (!groups.has(key)) {
            groups.set(key, {
                directory: path,
                machineId,
                sessions: []
            })
        }
        groups.get(key)!.sessions.push(session)
    })

    return Array.from(groups.entries())
        .map(([key, group]) => {
            const sortedSessions = [...group.sessions].sort((a, b) => {
                if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
                return compare(a, b)
            })
            const latestOrderAt = group.sessions.reduce(
                (max, s) => Math.max(max, getSessionSortKey(s, order.sort)),
                -Infinity
            )
            const hasActiveSession = group.sessions.some(s => s.active)
            const hasPinnedSession = group.sessions.some(s => s.pinned)
            const displayName = getSessionProjectLabel(group.directory)

            return {
                key,
                directory: group.directory,
                displayName,
                machineId: group.machineId,
                sessions: sortedSessions,
                latestOrderAt,
                hasActiveSession,
                hasPinnedSession
            }
        })
        .sort((a, b) => {
            if (a.hasPinnedSession !== b.hasPinnedSession) {
                return a.hasPinnedSession ? -1 : 1
            }
            if (order.activeFirst && a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return compareDescWithKeyTiebreak(
                { key: a.key, order: a.latestOrderAt },
                { key: b.key, order: b.latestOrderAt }
            )
        })
}


export function expandSelectedSessionCollapseOverrides(
    overrides: Map<string, boolean>,
    group: { key: string }
): Map<string, boolean> {
    // Keep auto-expanded paths open after selection moves so content above the
    // clicked row does not collapse and displace the sidebar viewport.
    if (overrides.get(group.key) === false) {
        return overrides
    }

    const next = new Map(overrides)
    next.set(group.key, false)
    return next
}

function groupByMachine(
    groups: SessionGroup[],
    resolveMachineLabel: (id: string | null) => string
): MachineGroup[] {
    const map = new Map<string, MachineGroup>()
    for (const g of groups) {
        const key = g.machineId ?? UNKNOWN_MACHINE_ID
        let mg = map.get(key)
        if (!mg) {
            mg = {
                machineId: g.machineId,
                label: resolveMachineLabel(g.machineId),
                projectGroups: [],
                totalSessions: 0,
                hasActiveSession: false,
                hasPinnedSession: false,
                latestOrderAt: -Infinity,
            }
            map.set(key, mg)
        }
        mg.projectGroups.push(g)
        mg.totalSessions += g.sessions.length
        if (g.hasActiveSession) mg.hasActiveSession = true
        if (g.hasPinnedSession) mg.hasPinnedSession = true
        if (g.latestOrderAt > mg.latestOrderAt) mg.latestOrderAt = g.latestOrderAt
    }
    return [...map.values()].sort((a, b) => {
        if (a.hasPinnedSession !== b.hasPinnedSession) return a.hasPinnedSession ? -1 : 1
        return compareDescWithKeyTiebreak(
            { key: a.machineId ?? UNKNOWN_MACHINE_ID, order: a.latestOrderAt },
            { key: b.machineId ?? UNKNOWN_MACHINE_ID, order: b.latestOrderAt }
        )
    })
}

function CopyPathButton({ path, className }: { path: string; className?: string }) {
    const [copied, setCopied] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        navigator.clipboard.writeText(path)
        setCopied(true)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1500)
    }

    useEffect(() => () => clearTimeout(timerRef.current), [])

    return (
        <button
            type="button"
            className={`shrink-0 p-0.5 rounded transition-colors ${copied ? 'text-[var(--app-badge-success-text)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'} ${className ?? ''}`}
            title={copied ? 'Copied!' : `Copy: ${path}`}
            onClick={handleClick}
        >
            {copied
                ? <CheckIcon className="h-3.5 w-3.5" />
                : <CopyIcon className="h-3.5 w-3.5" />
            }
        </button>
    )
}


function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
        </svg>
    )
}

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

function XIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    )
}

/** Metadata scope: an ID card, for title/summary/path/Agent/machine/ID. */
function ScopeMetadataIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="10" r="1.8" />
            <path d="M5.5 16.6c.5-1.3 1.6-2 3-2s2.5.7 3 2" />
            <path d="M14.5 9.5h4M14.5 13.5h4" />
        </svg>
    )
}

/** Content scope: a speech bubble with text, for the message full-text index. */
function ScopeContentIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" />
            <path d="M8 8.5h9M8 12.5h6" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
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
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function SessionPreviewArrowIcon(props: { direction: 'up' | 'down'; className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            {props.direction === 'up' ? (
                <path d="M12 19V5m-6 6 6-6 6 6" />
            ) : (
                <path d="M12 5v14m6-6-6 6-6-6" />
            )}
        </svg>
    )
}

export { getSessionTitle } from '@/lib/sessionTitle'
export { sessionMatchesQuery } from '@/lib/sessionListSearch'

export function normalizeSearch(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase()
}

export function sessionMatchesSearchMode(
    session: SessionSummary,
    query: string,
    machineLabel: string,
    mode: SessionSearchMode = 'default'
): boolean {
    if (!query) return true
    const matches = sessionMatchesQuery(session, query, machineLabel)
    return mode === 'exclude' ? !matches : matches
}

export function getVisibleSessionPreview(
    sessions: SessionSummary[],
    options: {
        expanded?: boolean
        selectedSessionId?: string | null
        limit?: number
        isUnread?: (session: SessionSummary) => boolean
    } = {}
): SessionSummary[] {
    const limit = options.limit ?? GROUP_SESSION_PREVIEW_LIMIT
    if (options.expanded || sessions.length <= limit) return sessions

    const requiredIds = new Set<string>()
    for (const session of sessions) {
        if (session.active && session.pendingRequestsCount > 0) requiredIds.add(session.id)
        else if (options.isUnread?.(session)) requiredIds.add(session.id)
    }
    if (options.selectedSessionId && sessions.some(session => session.id === options.selectedSessionId)) {
        requiredIds.add(options.selectedSessionId)
    }

    const visible: SessionSummary[] = sessions.filter((session, index) => {
        return index < limit || requiredIds.has(session.id)
    })

    for (let index = visible.length - 1; visible.length > limit && index >= 0; index -= 1) {
        const session = visible[index]
        if (!session || requiredIds.has(session.id)) continue
        visible.splice(index, 1)
    }

    return visible
}

export function shouldShowPinnedDivider(sessions: SessionSummary[], index: number): boolean {
    if (index <= 0 || index >= sessions.length) return false
    return Boolean(sessions[index - 1]?.pinned) && !sessions[index]?.pinned
}

/** Upper bound on how often the open-session tick re-measures during list churn. */
const TICK_RECOMPUTE_THROTTLE_MS = 100

/**
 * Map the open session's row midpoint in the scroll content onto a 0..1 position
 * on the session-list scroll rail. Returns null when a mark would lie: nothing
 * overflows (no scrollbar), or the row has no laid-out height yet.
 */
export function computeOpenSessionTickRatio(input: {
    scrollHeight: number
    clientHeight: number
    contentOffsetTop: number
    targetHeight: number
}): number | null {
    const { scrollHeight, clientHeight, contentOffsetTop, targetHeight } = input
    if (!(scrollHeight > 0) || !(clientHeight > 0)) return null
    if (scrollHeight <= clientHeight) return null
    if (!(targetHeight > 0)) return null
    const ratio = (contentOffsetTop + targetHeight / 2) / scrollHeight
    if (!Number.isFinite(ratio)) return null
    return Math.min(1, Math.max(0, ratio))
}

export function shouldShowOpenSessionTick(input: {
    selectedSessionId: string | null | undefined
    rowFound: boolean
    insideCollapsedPanel: boolean
    tickRatio: number | null
}): boolean {
    if (!input.selectedSessionId) return false
    if (!input.rowFound) return false
    if (input.insideCollapsedPanel) return false
    return input.tickRatio != null
}

/** True when the row sits inside a closed `.collapsible-panel` (group collapsed). */
export function isSessionRowInsideCollapsedPanel(row: Element): boolean {
    const panel = row.closest('.collapsible-panel')
    return panel ? !panel.hasAttribute('data-open') : false
}

export function measureOpenSessionTickContentOffset(
    container: HTMLElement,
    row: HTMLElement
): { contentOffsetTop: number; targetHeight: number } {
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return {
        contentOffsetTop: rowRect.top - containerRect.top + container.scrollTop,
        targetHeight: rowRect.height,
    }
}

export function SessionListSearch(props: {
    value: string
    onChange: (value: string) => void
    customStart?: string
    customEnd?: string
    sessionActivityDates?: ReadonlySet<string>
    onDateRangeChange?: (start: string, end: string) => void
    expanded: boolean
    onExpandedChange: (expanded: boolean) => void
    showDateFilter?: boolean
    searchMode?: 'metadata' | 'content'
    onSearchModeChange?: (mode: 'metadata' | 'content') => void
    searchMatchMode?: SessionSearchMode
    onSearchMatchModeChange?: (mode: SessionSearchMode) => void
    /** Minimum width of icon + clear. Query text may shrink; these may not. */
    chromeMinPx?: number
    /**
     * Caps the collapsed query group so machine menu + More stay in the row.
     * The 9rem chip is a ceiling, not a reservation (#2040).
     */
    maxWidthPx?: number
}) {
    const { t } = useTranslation()

    const [searchMatchModeOpen, setSearchMatchModeOpen] = useState(false)

    const inputRef = useRef<HTMLInputElement>(null)
    const collapsedButtonRef = useRef<HTMLButtonElement>(null)
    const scopeButtonRef = useRef<HTMLButtonElement>(null)
    const scopeFue = useFue('session-list-search-scope')

    const [datePickerOpen, setDatePickerOpen] = useState(false)
    const dateButtonRef = useRef<HTMLButtonElement>(null)
    const hasDateFilter = props.customStart !== undefined
        && props.customEnd !== undefined
        && props.sessionActivityDates !== undefined
        && props.onDateRangeChange !== undefined
    const hasDateRange = hasDateFilter && Boolean(props.customStart && props.customEnd)
    const showDateFilter = props.showDateFilter !== false && hasDateFilter

    useEffect(() => {
        if (props.expanded) {
            inputRef.current?.focus()
        } else {
            setDatePickerOpen(false)
            setSearchMatchModeOpen(false)
        }
    }, [props.expanded])

    const returnDateFocus = () => {
        if (props.expanded) {
            inputRef.current?.focus()
            return
        }
        dateButtonRef.current?.focus()
    }

    const renderDateButton = (variant: 'standalone' | 'embedded') => (
        <div className={cn('shrink-0', variant === 'embedded' && 'flex items-stretch')}>
            <button
                ref={dateButtonRef}
                type="button"
                data-testid={variant === 'embedded'
                    ? 'session-list-search-date-embedded'
                    : 'session-list-search-date-standalone'}
                data-toolbar-chrome=""
                onClick={() => setDatePickerOpen(open => !open)}
                className={cn(
                    'relative flex shrink-0 items-center justify-center transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-inset',
                    variant === 'standalone'
                        ? cn(
                            'min-h-[48px] min-w-[48px] rounded-full p-2',
                            'hover:bg-[var(--app-subtle-bg)]',
                            hasDateRange ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        )
                        : cn(
                            'session-list-search-date-embedded min-h-[48px] min-w-[48px] border-l border-[var(--app-border)]',
                            'hover:bg-[var(--app-subtle-bg)]',
                            hasDateRange ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        )
                )}
                title={hasDateRange
                    ? props.customStart + ' - ' + props.customEnd
                    : t('sessions.timeFilter.label')}
                aria-label={hasDateRange
                    ? t('sessions.timeFilter.label') + ': ' + props.customStart + ' - ' + props.customEnd
                    : t('sessions.timeFilter.label')}
                aria-expanded={datePickerOpen}
            >
                <CalendarIcon className="h-5 w-5 shrink-0" />
                {hasDateRange ? (
                    <span
                        className={cn(
                            'absolute h-1.5 w-1.5 rounded-full bg-[var(--app-link)]',
                            variant === 'standalone' ? 'right-1 top-1' : 'right-1.5 top-1.5'
                        )}
                        aria-hidden="true"
                    />
                ) : null}
            </button>
        </div>
    )

    const datePicker = datePickerOpen ? (
        <>
            <button
                type="button"
                aria-label={t('sessions.timeFilter.close')}
                className="fixed inset-0 z-20 cursor-default"
                onClick={() => {
                    setDatePickerOpen(false)
                    returnDateFocus()
                }}
            />
            <SessionDateRangePicker
                start={props.customStart!}
                end={props.customEnd!}
                sessionActivityDates={props.sessionActivityDates!}
                onChange={props.onDateRangeChange!}
                onClear={() => {
                    props.onDateRangeChange!('', '')
                    returnDateFocus()
                }}
                onClose={() => {
                    setDatePickerOpen(false)
                    returnDateFocus()
                }}
                align={props.expanded ? 'right' : 'left'}
            />
        </>
    ) : null

    const searchMode = props.searchMode ?? 'metadata'
    const searchMatchMode = props.searchMatchMode ?? 'default'
    const canSearchContent = Boolean(props.onSearchModeChange)
    const canChangeSearchMatchMode = Boolean(props.onSearchMatchModeChange)
    const searchLabel = searchMode === 'content'
        ? t('sessions.search.content.placeholder')
        : t('sessions.search.open')

    // Metadata/content scope is a two-state toggle; include/exclude is an
    // orthogonal metadata-search control and is hidden while searching content.
    const otherSearchMode = searchMode === 'content' ? 'metadata' : 'content'
    const scopeHint = t('sessions.search.scope.' + searchMode + '.description')
        + '. '
        + t('sessions.search.scope.switch', {
            scope: t('sessions.search.scope.' + otherSearchMode + '.name'),
        })
    const ScopeIcon = searchMode === 'content' ? ScopeContentIcon : ScopeMetadataIcon

    const renderSearchScope = () => canSearchContent ? (
        <>
            <button
                ref={scopeButtonRef}
                type="button"
                data-testid="session-list-search-scope"
                data-search-scope={searchMode}
                onClick={() => {
                    scopeFue.engage()
                    props.onSearchModeChange?.(otherSearchMode)
                }}
                // Hit target matches the clear endcap so the scope is as tappable
                // as the action beside it (tiann/hapi#2081).
                className={cn(
                    'session-list-search-scope relative flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center',
                    'border-r border-[var(--app-border)] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-inset',
                    searchMode === 'content'
                        ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]'
                        : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                )}
                title={scopeHint}
                aria-label={scopeHint}
            >
                <ScopeIcon className="h-5 w-5 shrink-0" />
                {scopeFue.status !== 'acknowledged' ? (
                    <FueDot
                        pulsing={scopeFue.status === 'unseen'}
                        ariaLabel={t('fue.newFeatureDot')}
                    />
                ) : null}
            </button>
            {scopeFue.status === 'engaging' ? (
                <FueCallout
                    title={t('sessions.search.scope.fueTitle')}
                    body={t('sessions.search.scope.fueBody')}
                    onDismiss={scopeFue.dismiss}
                    dismissLabel={t('fue.gotIt')}
                    closeAriaLabel={t('fue.closeAriaLabel')}
                    anchorRef={scopeButtonRef}
                />
            ) : null}
        </>
    ) : null

    const renderSearchMatchMode = () => canChangeSearchMatchMode && searchMode === 'metadata' ? (
        <div className="relative shrink-0">
            <button
                type="button"
                aria-label={t('sessions.search.scope.toggle')}
                aria-expanded={searchMatchModeOpen}
                onClick={() => setSearchMatchModeOpen(open => !open)}
                className="flex h-full w-auto items-center gap-0.5 border-r border-[var(--app-border)] px-1.5 text-xs leading-none text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
            >
                <span className="shrink-0 whitespace-nowrap leading-none">
                    {t(`sessions.search.scope.${searchMatchMode}`)}
                </span>
                <ChevronDownIcon className={cn(
                    'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                    searchMatchModeOpen && 'rotate-180'
                )} />
            </button>
            {searchMatchModeOpen ? (
                <div className="absolute left-0 top-full z-30 mt-1 flex w-max min-w-full flex-col gap-0.5 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-0.5 shadow-lg">
                    {(['default', 'exclude'] as const).map(mode => (
                        <button
                            key={mode}
                            type="button"
                            aria-pressed={searchMatchMode === mode}
                            onClick={() => {
                                props.onSearchMatchModeChange?.(mode)
                                setSearchMatchModeOpen(false)
                                inputRef.current?.focus()
                            }}
                            className={cn(
                                'flex min-h-8 w-full items-center justify-center whitespace-nowrap rounded-md px-2 py-0.5 text-center text-sm leading-none transition-colors',
                                searchMatchMode === mode
                                    ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                    : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                            )}
                        >
                            {t(`sessions.search.scope.${mode}`)}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    ) : null

    if (!props.expanded) {
        const hasTextQuery = props.value.length > 0
        const collapsedLabel = hasTextQuery ? searchLabel + ': ' + props.value : searchLabel
        // Idle: shrink-0 so the icon does not crush under neighbors (#2039).
        // Active query: maxWidth reserves machine menu + More before the 9rem
        // chip can take ~240px and shove More off a 320px / 130% row (#2040).
        const chromeFloor = hasTextQuery && props.chromeMinPx && props.chromeMinPx > 0
            ? props.chromeMinPx
            : 0
        const reservedCap = hasTextQuery && props.maxWidthPx && props.maxWidthPx > 0
            ? Math.max(props.maxWidthPx, chromeFloor)
            : 0
        return (
            <div
                data-testid="session-list-search"
                data-expanded="false"
                style={chromeFloor > 0 || reservedCap > 0
                    ? {
                        ...(chromeFloor > 0 ? { minWidth: chromeFloor } : {}),
                        ...(reservedCap > 0 ? { maxWidth: reservedCap } : {}),
                    }
                    : undefined}
                className={cn(
                    'relative flex max-w-full flex-nowrap items-center gap-1',
                    // Query text shrinks. minWidth is the icon/clear floor
                    // so a flex-1 actions box cannot crush those hit targets.
                    hasTextQuery ? 'min-w-0 max-w-full shrink' : 'shrink-0'
                )}
            >
                <div className={cn(
                    'relative flex min-w-0 items-center rounded-full transition-colors',
                    hasTextQuery
                        // Keep the query and its clear action inside the same compact chip.
                        // Cap stays modest so [chip][⋯] fits a 320px phone (#2039 Major).
                        ? 'max-w-[9rem] bg-[var(--app-chat-user-chip-bg)] text-[var(--app-chat-user-chip-fg)]'
                        : 'shrink-0'
                )}>
                    <button
                        ref={collapsedButtonRef}
                        type="button"
                        onClick={() => props.onExpandedChange(true)}
                        className={cn(
                            'relative flex min-h-[40px] items-center gap-1 transition-colors',
                            hasTextQuery
                                ? 'min-w-0 flex-1 rounded-l-full bg-[var(--app-chat-user-chip-bg)] px-2 py-1 text-[var(--app-chat-user-chip-fg)] hover:opacity-90'
                                : 'min-w-[40px] shrink-0 rounded-full p-2 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                        )}
                        title={collapsedLabel}
                        aria-label={collapsedLabel}
                    >
                        <span
                            data-toolbar-chrome=""
                            data-search-scope={hasTextQuery ? searchMode : undefined}
                            className="inline-flex shrink-0"
                        >
                            {/*
                              * The applying chip keeps the scope glyph so a content-scoped
                              * query stays readable once the field collapses. Idle (no
                              * query) stays a magnifier: there is no scope in effect yet,
                              * and this is also the button that opens search.
                              */}
                            {hasTextQuery && searchMode === 'content'
                                ? <ScopeContentIcon className="h-5 w-5 shrink-0" />
                                : <SearchIcon className="h-5 w-5 shrink-0" />}
                        </span>
                        {hasTextQuery ? (
                            <span className="min-w-0 truncate text-xs font-medium">{props.value}</span>
                        ) : null}
                    </button>
                    {hasTextQuery ? (
                        <button
                            type="button"
                            onClick={() => {
                                props.onChange('')
                                collapsedButtonRef.current?.focus()
                            }}
                            data-toolbar-chrome=""
                            className="flex h-10 w-10 min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-r-full bg-[var(--app-chat-user-chip-action-bg)] text-[var(--app-chat-user-chip-action-fg)] transition-colors hover:text-[var(--app-chat-user-chip-action-hover-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-inset"
                            title={t('sessions.search.clear')}
                            aria-label={t('sessions.search.clear')}
                        >
                            <XIcon className="h-4 w-4" />
                        </button>
                    ) : null}
                </div>

                {showDateFilter ? renderDateButton('standalone') : null}
                {showDateFilter ? datePicker : null}

            </div>
        )
    }

    return (
        <div
            data-testid="session-list-search"
            data-expanded="true"
            className="relative min-w-0 flex-1"
            onBlur={(event) => {
                const related = event.relatedTarget as Element | null
                // The scope FueCallout portals to document.body, so it's
                // never a DOM descendant of this container — without this
                // check, focusing its "Got it" button reads as focus leaving
                // and collapses the search bar out from under it.
                if (related?.closest('[data-fue-callout]')) return
                if (!event.currentTarget.contains(related as Node | null)) {
                    props.onExpandedChange(false)
                }
            }}
        >
            <div className="relative flex min-h-12 min-w-0 items-stretch rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] transition-colors focus-within:border-[var(--app-link)]">
                <div className="pointer-events-none flex shrink-0 items-center pl-2 text-[var(--app-hint)]">
                    <SearchIcon className="h-5 w-5" />
                </div>
                {renderSearchScope()}
                {renderSearchMatchMode()}
                <input
                    ref={inputRef}
                    type="search"
                    value={props.value}
                    onChange={(event) => props.onChange(event.target.value)}
                    placeholder={searchMode === 'content'
                        ? t('sessions.search.content.placeholder')
                        : t('sessions.search.placeholder')}
                    aria-label={searchLabel}
                    title={searchLabel}
                    className="min-w-0 flex-1 appearance-none bg-transparent px-2 py-1.5 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] [text-overflow:ellipsis] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
                />

                {showDateFilter ? renderDateButton('embedded') : null}

                {props.value ? (
                    <button
                        type="button"
                        onClick={() => {
                            props.onChange('')
                            inputRef.current?.focus()
                        }}
                        className="session-list-search-clear-endcap flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center border-l border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-inset"
                        title={t('sessions.search.clear')}
                        aria-label={t('sessions.search.clear')}
                    >
                        <XIcon className="h-5 w-5" />
                    </button>
                ) : null}
            </div>

            {showDateFilter ? datePicker : null}

        </div>
    )
}

// A row with an open menu or dialog holds its collapsed panel mounted.
const CollapsiblePanelHoldContext = createContext<((held: boolean) => void) | null>(null)
/**
 * Lets a row declare that its dismissal dialog is open.
 *
 * `CollapsiblePanelHoldContext` does NOT cover this: it gates whether a panel's
 * children render while the panel collapses, but a row removed from
 * `blockedSectionSessions` by a filter is not among those children at all, so
 * there is nothing for the hold to keep alive. The jump exemption has to be
 * withheld explicitly instead.
 */
const BlockedDialogHoldContext = createContext<((sessionId: string | null) => void) | null>(null)
const CollapsiblePanelOpenContext = createContext(true)

type QuickUnpinFocusTarget = { sessionId: string; pending: boolean }
const QuickUnpinFocusContext = createContext<{ current: QuickUnpinFocusTarget | null } | null>(null)
const QUICK_ACTION_BUTTON_CLASS_NAME = 'flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-wait'

// Collapsed rows unmount after the close transition; mounted-but-hidden rows
// would otherwise re-render on every session or machine update.
function CollapsiblePanel(props: { open: boolean; children: ReactNode }) {
    const [settled, setSettled] = useState(!props.open)
    const [holds, setHolds] = useState(0)
    const hold = useCallback((held: boolean) => setHolds((count) => count + (held ? 1 : -1)), [])
    if (props.open && settled) {
        setSettled(false)
    }
    return (
        <div
            className="collapsible-panel"
            data-open={props.open || undefined}
            onTransitionEnd={(event) => {
                if (!props.open && event.target === event.currentTarget) {
                    setSettled(true)
                }
            }}
        >
            <div className="collapsible-inner">
                <CollapsiblePanelOpenContext.Provider value={props.open}>
                    <CollapsiblePanelHoldContext.Provider value={hold}>
                        {!settled || holds > 0 ? props.children : null}
                    </CollapsiblePanelHoldContext.Provider>
                </CollapsiblePanelOpenContext.Provider>
            </div>
        </div>
    )
}

type SessionItemProps = {
    session: SessionSummary
    onSelect: (sessionId: string, targetMessageId?: string, targetMessageQuery?: string, pendingRequestId?: string) => void
    showPath?: boolean
    api: ApiClient | null
    features: FeaturesResponse | null
    prNowMs: number
    titleSuggestionAvailable?: boolean
    selected?: boolean
    showDetailedStatus?: boolean
    inRunningSection?: boolean
    projectLabel?: string
    machineLabel?: string
    contentSnippet?: string
    contentSearchTruncated?: boolean
    targetMessageId?: string
    targetMessageQuery?: string
    lastSeenVersion: number
    /** Brief ring after jump-to-next-blocked, so the row the list travelled to
     *  is obvious once the scroll settles. */
    flashHighlight?: boolean
}

function shallowEqualExcept<T extends object>(previous: T, next: T, ignored: keyof T): boolean {
    if (previous === next) return true
    const keys = Object.keys(previous) as Array<keyof T>
    return keys.length === Object.keys(next).length
        && keys.every(key => Object.hasOwn(next, key)
            && (key === ignored || Object.is(previous[key], next[key])))
}

const SessionItem = memo(function SessionItem(props: SessionItemProps) {
    const { t } = useTranslation()
    const addToast = useAddToast()
    const {
        session: s,
        onSelect,
        showPath = true,
        api,
        features,
        prNowMs,
        titleSuggestionAvailable = false,
        selected = false,
        showDetailedStatus = false,
        inRunningSection = false,
        projectLabel,
        machineLabel,
        contentSnippet,
        contentSearchTruncated,
        targetMessageId,
        targetMessageQuery,
        lastSeenVersion,
        flashHighlight = false
    } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [linkPrOpen, setLinkPrOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const githubPrAwarenessEnabled = Boolean(features?.githubPrAwareness.enabled)
    const prChipDisplay = features?.prChipDisplay
    const forkFlow = useForkFlow({
        session: s,
        api: api!,
        onForked: (childSessionId) => onSelect(childSessionId)
    })
    const forkFlowOpen = forkFlow.flowOpen
    const pendingRequestPressedRef = useRef(false)
    const rowRef = useRef<HTMLDivElement>(null)
    const rowButtonRef = useRef<HTMLButtonElement>(null)
    const quickUnpinFocusRef = useContext(QuickUnpinFocusContext)
    const panelOpen = useContext(CollapsiblePanelOpenContext)
    const [unblockOpen, setUnblockOpen] = useState(false)
    // Pinned when the dialog opens so the watermark covers the blocker the
    // operator reviewed, not whatever arrived while they were typing.
    const [unblockObserved, setUnblockObserved] = useState<
        { at: number; key: string; label: string | null; note: string | null } | null
    >(null)
    const {
        status: cursorChatStoreStatus,
        isApplicable: cursorChatStoreApplicable,
        error: cursorChatStoreError,
        isLoading: cursorChatStoreLoading,
    } = useCursorChatStoreStatus({
        api,
        session: s,
        enabled: menuOpen
    })
    const cursorReopenGate = resolveCursorReopenGate({
        applicable: cursorChatStoreApplicable,
        onDisk: cursorChatStoreStatus?.onDisk,
        error: cursorChatStoreError,
        isLoading: cursorChatStoreLoading,
    })
    const cursorReopenDisabledReason = cursorReopenGate.disabledReason === 'missing'
        ? t('session.action.reopenCursorMissing')
        : cursorReopenGate.disabledReason === 'checking'
            ? t('session.action.reopenCursorChecking')
            : undefined
    const cursorReopenUnverifiedHint = cursorReopenGate.probeUnverified
        ? t('session.action.reopenCursorUnverified')
        : undefined

    const { archiveSession, reopenSession, renameSession, upsertExternalRef, removePrimaryExternalRef, suggestSessionTitle, updateSessionSummary, deleteSession, setPinMode, acknowledgeBlocked, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )
    const [reopenError, setReopenError] = useState<string | null>(null)
    const holdPanel = useContext(CollapsiblePanelHoldContext)
    const holdBlockedDialog = useContext(BlockedDialogHoldContext)
    useEffect(() => {
        if (!unblockOpen || !holdBlockedDialog) return
        holdBlockedDialog(s.id)
        return () => holdBlockedDialog(null)
    }, [unblockOpen, holdBlockedDialog, s.id])
    // `unblockOpen` belongs here with the other dialogs: without it, a row
    // revealed by the jump exemption unmounted two seconds later and took the
    // open Mark-unblocked dialog with it, mid-entry.
    const overlayOpen = menuOpen || renameOpen || linkPrOpen || exportOpen || archiveOpen || deleteOpen || forkFlowOpen || unblockOpen || reopenError !== null
    useEffect(() => {
        if (!overlayOpen || !holdPanel) return
        holdPanel(true)
        return () => holdPanel(false)
    }, [overlayOpen, holdPanel])

    const handleSetPinMode = async (mode: 'none' | 'project' | 'global') => {
        try {
            await setPinMode(mode)
        } catch (error) {
            addToast({
                title: t('session.action.pinFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                sessionId: s.id,
                url: `/sessions/${s.id}`
            })
        }
    }

    const handleReopen = async (onError: (message: string) => void = setReopenError) => {
        setReopenError(null)
        try {
            const result = await reopenSession()
            // resumeSession may merge the row into a freshly-spawned sessionId.
            // Follow it so the operator lands on the live session.
            if (result.sessionId && result.sessionId !== s.id) {
                retargetSharePendingTransfer(s.id, result.sessionId)
                await transferComposerDraftThenNavigate(
                    s.id,
                    result.sessionId,
                    () => onSelect(result.sessionId),
                )
            }
        } catch (error) {
            onError(formatReopenError(error))
        }
    }

    const quickUnpinPending = useIsMutating({
        mutationKey: sessionPinMutationKey(s.id),
        exact: true,
        predicate: (mutation) => mutation.state.variables === 'none',
    }) > 0
    const isPinned = Boolean(s.pinned || s.globalPinned)
    // The row can lose its pinned flags before the unpin request settles;
    // keep the spinner until it does.
    const showQuickUnpin = isPinned || quickUnpinPending
    const handleQuickUnpin = async (event: MouseEvent<HTMLButtonElement>) => {
        const hadFocus = rowRef.current?.contains(document.activeElement) ?? false
        if (event.detail === 0 && hadFocus && quickUnpinFocusRef) {
            quickUnpinFocusRef.current = { sessionId: s.id, pending: true }
            // Keep focus on the row button before disabling or removing the
            // unpin button drops focus to document.body.
            rowButtonRef.current?.focus({ preventScroll: true })
        }
        try {
            await setPinMode('none')
        } catch (error) {
            if (quickUnpinFocusRef?.current?.sessionId === s.id) {
                quickUnpinFocusRef.current = null
            }
            addToast({
                title: t('session.action.pinFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                sessionId: s.id,
                url: `/sessions/${s.id}`
            })
        } finally {
            if (quickUnpinFocusRef?.current?.sessionId === s.id) {
                quickUnpinFocusRef.current.pending = false
            }
        }
    }

    useLayoutEffect(() => {
        const target = quickUnpinFocusRef?.current
        if (!target || target.sessionId !== s.id) return
        const activeEl = document.activeElement
        const activeRowId = activeEl instanceof Element
            ? activeEl.closest('[data-session-row-id]')?.getAttribute('data-session-row-id')
            : null
        if (activeEl && activeEl !== document.body && activeRowId !== s.id) {
            quickUnpinFocusRef.current = null
            return
        }
        if (!panelOpen || rowRef.current?.closest('.collapsible-panel:not([data-open])')) {
            return
        }
        if (activeEl !== rowButtonRef.current) {
            rowButtonRef.current?.focus({ preventScroll: true })
        }
    }, [s.id, isPinned, quickUnpinPending, quickUnpinFocusRef, panelOpen])

    // Hover archive: an idle session archives in one click with a Reopen toast;
    // one that is replying, waiting on approval or running background work
    // still goes through the confirmation, since archiving stops its agent.
    // Read from the shared mutation cache, not row state: the row remounts when
    // an archived session moves between sections (e.g. out of Active), and the
    // spinner must survive that until the request settles.
    const quickArchivePending = useIsMutating({ mutationKey: sessionArchiveMutationKey(s.id), exact: true }) > 0
    const archiveNeedsConfirmation = s.thinking || s.pendingRequestsCount > 0 || (s.backgroundTaskCount ?? 0) > 0
    // The row can turn inactive before the archive request settles (the hub
    // still confirms cleanup); keep the spinner until it does.
    const showQuickArchive = s.active || quickArchivePending
    const quickActionCount = (showQuickUnpin ? 1 : 0) + (showQuickArchive ? 1 : 0)
    const hasQuickAction = quickActionCount > 0
    const handleQuickArchive = async () => {
        if (archiveNeedsConfirmation) {
            setArchiveOpen(true)
            return
        }
        try {
            await archiveSession()
            addToast({
                title: t('session.archived.title'),
                body: getSessionTitle(s),
                sessionId: s.id,
                url: `/sessions/${s.id}`,
                action: {
                    label: t('session.action.reopen'),
                    onClick: () => void handleReopen((message) => addToast({
                        title: t('dialog.reopen.errorTitle'),
                        body: message,
                        sessionId: s.id,
                        url: `/sessions/${s.id}`
                    }))
                }
            })
        } catch (error) {
            addToast({
                title: t('dialog.archive.error'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                sessionId: s.id,
                url: `/sessions/${s.id}`
            })
        }
    }

    const supportsCurrentFork = s.active && s.metadata?.flavor === 'codex'
        && s.metadata?.conversationHistory?.forkCurrent === true
    const supportsArchivedFork = !s.active && s.metadata?.flavor === 'codex'
        && s.metadata?.lifecycleState === 'archived'
        && Boolean(s.metadata.agentSessionId && s.metadata.machineId)
    const supportsCompletedFork = s.metadata?.conversationHistory?.forkLatestCompleted === true
    const forkDisabledReason = supportsCurrentFork && s.thinking && !supportsCompletedFork ? t(s.metadata?.conversationHistory?.forkLatestCompleted === false ? 'session.action.forkNoCompleted' : 'session.action.forkRunning') : undefined

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (!menuOpen) {
                const pendingRequestId = pendingRequestPressedRef.current
                    ? s.pendingRequests?.[0]?.id
                    : undefined
                pendingRequestPressedRef.current = false
                if (pendingRequestId) {
                    onSelect(s.id, undefined, undefined, pendingRequestId)
                } else {
                    onSelect(s.id, targetMessageId, targetMessageQuery)
                }
            }
        },
        threshold: 500
    })

    const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.target !== event.currentTarget || !selected) return
        const pendingRequestId = s.pendingRequests?.[0]?.id
        if (!pendingRequestId || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onSelect(s.id, undefined, undefined, pendingRequestId)
    }
    const sessionName = getSessionTitle(s)
    const primaryPrRef = getPrimaryGithubPrRef(s.metadata?.externalRefs)
    const linkedPr = useMemo(() => {
        if (!githubPrAwarenessEnabled || !primaryPrRef) return null
        const profile = prChipDisplay ?? DEFAULT_PR_CHIP_DISPLAY
        const display = resolveGithubPrChipDisplay(primaryPrRef, profile, prNowMs)
        const parts = formatGithubPrChipDetailParts(primaryPrRef, display, t)
        return {
            glyph: parts.glyph,
            detail: parts.detail,
            href: primaryPrRef.url
        }
    }, [githubPrAwarenessEnabled, primaryPrRef, prChipDisplay, prNowMs, t])
    const attention = useMemo(
        () => showDetailedStatus
            ? classifySessionAttention(s, {
                selected,
                lastSeenAt: getSessionLastSeenAt(s.id),
                manualUnreadAt: getSessionManualUnreadAt(s.id, s.readState)
            })
            : null,
        [s, selected, showDetailedStatus, lastSeenVersion]
    )
    // The rail lives on the button rather than inside SessionRowSummary so it
    // escapes the `opacity-50` disconnected-row treatment — a blocked agent
    // whose CLI dropped is precisely the one worth spotting.
    const blocked = getSessionBlockedState(s, { now: Date.now() })
    const hasScheduleTooltip = showDetailedStatus && s.futureScheduledMessageCount > 0
    const { attentionId, scheduleId, describedBy } = useSessionRowTooltipIds(
        Boolean(attention),
        hasScheduleTooltip
    )
    return (
        <>
            <div
                ref={rowRef}
                className="session-list-row relative flex w-full items-start"
                data-session-row-id={s.id}
                data-quick-action-count={quickActionCount > 0 ? quickActionCount : undefined}
                data-quick-action-pending={quickArchivePending || quickUnpinPending ? '' : undefined}
            >
                <button
                    ref={rowButtonRef}
                    type="button"
                    {...longPressHandlers}
                    onKeyDown={handleRowKeyDown}
                    onPointerDownCapture={(event) => {
                        pendingRequestPressedRef.current = event.target instanceof Element
                            && event.target.closest('[data-session-pending-request-id]') !== null
                    }}
                    data-session-scroll-anchor
                    data-session-id={s.id}
                    data-session-blocked={blocked ? (blocked.stale ? 'stale' : 'active') : undefined}
                    className={cn(
                        // Upstream layout classes kept verbatim; pl-2.5 becomes pl-2
                        // because the blocked rail below adds the missing 2px.
                        'session-list-item group/session-row flex min-w-0 flex-1 flex-col gap-1 py-2 pl-2 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none rounded-lg',
                        // Reserve the rail width on every row so blocked rows do
                        // not shift their neighbours when the flag appears.
                        'border-l-2',
                        blocked && blocked.stale
                            ? 'border-[var(--app-hint)]'
                            : blocked && sessionBlockedIsError(blocked)
                                ? 'border-[var(--app-badge-error-text)]'
                                : blocked
                                    ? 'border-[var(--app-badge-warning-text)]'
                                    : 'border-transparent',
                        flashHighlight ? 'ring-2 ring-[var(--app-badge-warning-text)]' : '',
                        selected ? 'bg-[var(--app-secondary-bg)]' : ''
                    )}
                    style={{ WebkitTouchCallout: 'none' }}
                    aria-current={selected ? 'page' : undefined}
                    aria-describedby={describedBy}
                >
                    <SessionRowSummary
                        session={s}
                        showPath={showPath}
                        showDetailedStatus={showDetailedStatus}
                        selected={selected}
                        nestedTooltips
                        attentionTooltipId={attentionId}
                        lastSeenVersion={lastSeenVersion}
                        scheduleTooltipId={scheduleId}
                        githubPrAwarenessEnabled={githubPrAwarenessEnabled}
                        showPrChip={!(githubPrAwarenessEnabled && primaryPrRef)}
                        prChipDisplay={prChipDisplay}
                        prNowMs={prNowMs}
                        inRunningSection={inRunningSection}
                        projectLabel={projectLabel}
                        machineLabel={machineLabel}
                        contentSnippet={contentSnippet}
                        contentSearchTruncated={contentSearchTruncated}
                        trailingClassName={hasQuickAction ? 'session-row-trailing' : undefined}
                    />
                </button>
                {githubPrAwarenessEnabled && primaryPrRef ? (
                    <div
                        data-testid="session-pr-chip-wrap"
                        className="flex shrink-0 items-center self-start py-2 pr-2"
                        style={hasQuickAction
                            ? { paddingRight: 'calc(var(--session-row-action-span, 2rem) + 0.5rem)' }
                            : undefined}
                    >
                        <SessionPrChip
                            refs={s.metadata?.externalRefs}
                            displayProfile={prChipDisplay}
                            nowMs={prNowMs}
                            interactive
                        />
                    </div>
                ) : null}
                {hasQuickAction ? (
                    <div className="session-row-quick-action absolute right-1 top-1.5 items-center gap-0.5">
                        {showQuickUnpin ? (
                            <button
                                type="button"
                                className={QUICK_ACTION_BUTTON_CLASS_NAME}
                                aria-label={t('session.action.unpin')}
                                title={t('session.action.unpin')}
                                disabled={quickUnpinPending}
                                onClick={(event) => void handleQuickUnpin(event)}
                            >
                                {quickUnpinPending
                                    ? <LoaderIcon className="h-4 w-4 animate-spin" />
                                    : <PinOffIcon className="h-4 w-4" />}
                            </button>
                        ) : null}
                        {showQuickArchive ? (
                            <button
                                type="button"
                                className={QUICK_ACTION_BUTTON_CLASS_NAME}
                                aria-label={t('session.action.archive')}
                                title={t('session.action.archive')}
                                disabled={quickArchivePending}
                                onClick={() => void handleQuickArchive()}
                            >
                                {quickArchivePending
                                    ? <LoaderIcon className="h-4 w-4 animate-spin" />
                                    : <ArchiveIcon className="h-4 w-4" />}
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionId={s.id}
                sessionTitle={sessionName}
                sessionActive={s.active}
                sessionPinned={Boolean(s.pinned)}
                sessionGlobalPinned={Boolean(s.globalPinned)}
                onSetPinMode={(mode) => void handleSetPinMode(mode)}
                onRename={() => setRenameOpen(true)}
                onLinkPr={githubPrAwarenessEnabled ? () => setLinkPrOpen(true) : undefined}
                linkedPr={linkedPr}
                onExport={() => setExportOpen(true)}
                onMarkUnread={() => markSessionUnread(s.id, s.readState)}
                onForkSession={api && ((supportsCurrentFork && (!s.thinking || supportsCompletedFork)) || supportsArchivedFork)
                    ? () => forkFlow.openFork()
                    : undefined}
                forkDisabledReason={forkDisabledReason}
                onMarkUnblocked={blocked
                    ? () => {
                        // Freeze identity AND copy together. Freezing only the
                        // timestamp let the dialog keep rendering a newer
                        // footer while confirming against the older one, so
                        // the operator read one blocker and dismissed another.
                        setUnblockObserved({
                            at: blocked.at,
                            key: blocked.key,
                            label: t(getSessionBlockedLabelKey(blocked)),
                            note: blocked.note ?? null
                        })
                        setUnblockOpen(true)
                    }
                    : undefined}
                onArchive={() => setArchiveOpen(true)}
                onReopen={cursorReopenDisabledReason ? undefined : () => void handleReopen()}
                reopenDisabledReason={cursorReopenDisabledReason}
                reopenHint={cursorReopenUnverifiedHint}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
            />

            {forkFlow.preview ? (
                <ForkPreviewDialog
                    isOpen
                    view={forkFlow.preview.view}
                    prefixMayHaveMore={forkFlow.preview.view.prefixTruncated}
                    stale={forkFlow.stale}
                    loading={forkFlow.loading}
                    onCancel={forkFlow.closePreview}
                    onConfirm={forkFlow.confirmPreview}
                />
            ) : null}

            {forkFlow.legacyFallback ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => { if (!forkFlow.confirming) forkFlow.closePreview() }}
                    title={t('dialog.sessionFork.title')}
                    description={t(s.thinking && supportsCompletedFork ? 'dialog.sessionFork.completedDescription' : 'dialog.sessionFork.description')}
                    confirmLabel={t('dialog.sessionFork.confirm')}
                    confirmingLabel={t('dialog.sessionFork.confirming')}
                    isPending={forkFlow.confirming}
                    destructive
                    centerTitle
                    onConfirm={forkFlow.confirmLegacy}
                />
            ) : null}

            {forkFlow.errorMessage && !forkFlow.preview ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={forkFlow.closePreview}
                    title={t('dialog.sessionFork.title')}
                    description={forkFlow.errorMessage}
                    confirmLabel={forkFlow.errorWasConnectFailure ? t('button.retry') : t('dialog.reopen.dismiss')}
                    confirmingLabel={forkFlow.errorWasConnectFailure ? t('button.retry') : t('dialog.reopen.dismiss')}
                    isPending={forkFlow.loading}
                    hideCancel
                    keepOpenAfterConfirm={forkFlow.errorWasConnectFailure}
                    centerTitle
                    onConfirm={async () => {
                        if (forkFlow.errorWasConnectFailure) forkFlow.retryPreview()
                        else forkFlow.closePreview()
                    }}
                />
            ) : null}

            {unblockOpen ? (
                <UnblockReasonDialog
                    isOpen
                    sessionTitle={sessionName}
                    blockedLabel={unblockObserved?.label ?? null}
                    blockedNote={unblockObserved?.note ?? null}
                    isPending={isPending}
                    returnFocusTo={() => rowButtonRef.current}
                    onClose={() => { setUnblockOpen(false); setUnblockObserved(null) }}
                    onConfirm={(reason) => acknowledgeBlocked({
                        reason,
                        ...(unblockObserved
                            ? { observed: { at: unblockObserved.at, key: unblockObserved.key } }
                            : {})
                    })}
                />
            ) : null}

            {reopenError ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setReopenError(null)}
                    title={t('dialog.reopen.errorTitle')}
                    description={reopenError}
                    confirmLabel={t('dialog.reopen.dismiss')}
                    confirmingLabel={t('dialog.reopen.dismiss')}
                    onConfirm={async () => setReopenError(null)}
                    isPending={false}
                    centerTitle
                />
            ) : null}

            {renameOpen ? (
                <RenameSessionDialog
                    isOpen={true}
                    onClose={() => setRenameOpen(false)}
                    currentName={sessionName}
                    currentTitleLocked={s.metadata?.titleLocked === true}
                    sessionId={s.id}
                    onRename={renameSession}
                    onSuggestTitle={api && titleSuggestionAvailable ? suggestSessionTitle : undefined}
                    onUpdateSummary={api && titleSuggestionAvailable ? updateSessionSummary : undefined}
                    isPending={isPending}
                />
            ) : null}

            <LinkPrDialog
                isOpen={linkPrOpen}
                onClose={() => setLinkPrOpen(false)}
                currentPrimaryLabel={primaryPrRef ? `${primaryPrRef.repo}#${primaryPrRef.number}` : null}
                onUpsert={upsertExternalRef}
                onRemovePrimary={primaryPrRef ? removePrimaryExternalRef : undefined}
                isPending={isPending}
            />

            {exportOpen ? (
                <SessionExportDialog
                    isOpen={true}
                    onClose={() => setExportOpen(false)}
                    sessionId={s.id}
                    api={api}
                />
            ) : null}

            {archiveOpen ? (
                <ArchiveSessionDialog
                    isOpen={true}
                    onClose={() => setArchiveOpen(false)}
                    sessionId={s.id}
                    sessionName={sessionName}
                    active={s.active}
                    onConfirm={archiveSession}
                    isPending={isPending}
                />
            ) : null}

            {deleteOpen ? (
                <DeleteSessionDialog
                    isOpen={true}
                    sessionId={s.id}
                    onClose={() => setDeleteOpen(false)}
                    description={t('dialog.delete.description', { name: sessionName })}
                    onConfirm={deleteSession}
                    isPending={isPending}
                />
            ) : null}
        </>
    )
}, (previous, next) =>
    shallowEqualExcept(previous, next, 'session')
    // The watermark orders REST and SSE updates in the cache. The row renders the job value.
    && shallowEqualExcept(previous.session, next.session, 'attachedJobUpdatedAt')
)

type PullToRefreshState = 'idle' | 'pulling' | 'ready'

const PULL_REFRESH_FEEDBACK_PX = 16
const PULL_REFRESH_TRIGGER_PX = 64

export function getPullToRefreshState(distancePx: number): PullToRefreshState {
    if (distancePx >= PULL_REFRESH_TRIGGER_PX) {
        return 'ready'
    }
    if (distancePx >= PULL_REFRESH_FEEDBACK_PX) {
        return 'pulling'
    }
    return 'idle'
}

export function getPullRefreshIndicatorRotation(state: PullToRefreshState): number {
    return state === 'ready' ? 180 : 0
}

function PullRefreshIcon(props: { rotation: number }) {
    return (
        <svg
            aria-hidden="true"
            className="h-4 w-4 shrink-0 transition-transform duration-200"
            viewBox="0 0 24 24"
            fill="none"
            style={{ transform: `rotate(${props.rotation}deg)` }}
        >
            <path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string, targetMessageId?: string, targetMessageQuery?: string, pendingRequestId?: string) => void
    onNewSession: () => void
    onNewSessionInDirectory?: (args: { machineId: string | null; directory: string }) => void
    onBrowse?: () => void
    onRefresh: () => Promise<unknown> | void
    isLoading: boolean
    renderHeader?: boolean
    /** @deprecated Prefer `toolbarExtras` so each control has its own keep rank. */
    headerActions?: React.ReactNode
    toolbarExtras?: SessionToolbarExtra[]
    api: ApiClient | null
    titleSuggestionAvailable?: boolean
    machineLabelsById?: Record<string, string>
    machinesById?: Record<string, Machine>
    selectedSessionId?: string | null
}) {
    const { t } = useTranslation()
    const {
        renderHeader = true,
        api,
        titleSuggestionAvailable = false,
        selectedSessionId,
        machineLabelsById = {},
        machinesById = {},
        onNewSessionInDirectory
    } = props
    const { features } = useFeatures(api)
    const githubPrAwarenessEnabled = Boolean(features?.githubPrAwareness.enabled)
    const prClockTick = useMinuteTick(githubPrAwarenessEnabled)
    // Stable between minute ticks so memoized SessionItem rows do not
    // remount on unrelated SSE updates when awareness is off (or mid-minute).
    const prNowMs = useMemo(
        () => (githubPrAwarenessEnabled ? Date.now() : 0),
        [prClockTick, githubPrAwarenessEnabled]
    )
    const { sessionPreviewLimit } = useSessionPreviewLimit()
    const { sessionListStatusMode } = useSessionListStatusMode()
    const { view: listView, setView: setListView } = useSessionListView()
    const listComparator = useMemo(() => createSessionComparator(listView), [listView])
    const { showActiveSessionsOnly, setShowActiveSessionsOnly } = useShowActiveSessionsOnly()
    const lastSeenVersion = useSessionLastSeenVersion()

    // Date, scratchlist, active, and working are transient; unread uses the
    // upstream view store. showActiveOnly is deliberately independent of
    // listView.status (persisted, backs the Settings "Active sessions only"
    // toggle) — #2002 wants a temporary scan, not another write path onto
    // that saved preference.
    const [showScratchlistOnly, setShowScratchlistOnly] = useState(false)
    const [showActiveOnly, setShowActiveOnly] = useState(false)
    const [showWorkingOnly, setShowWorkingOnly] = useState(false)
    const {
        sessionIds: scratchlistSessionIds,
        isLoading: isScratchlistStatusLoading,
        error: scratchlistStatusError,
        refetch: refetchScratchlistSessionIds
    } = useScratchlistSessionIds(api, showScratchlistOnly)
    // Unread rows stay visible without a filter: collapsed project groups still
    // show them, and the preview limit never hides them.
    const isSessionUnread = useCallback(
        (session: SessionSummary) => sessionIsUnread(session, {
            lastSeenAt: getSessionLastSeenAt(session.id),
            manualUnreadAt: getSessionManualUnreadAt(session.id, session.readState)
        }),
        [lastSeenVersion] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const { keepUnreadSessionsVisible } = useKeepUnreadSessionsVisible()
    // When off, unread rows are treated like any other: collapsed projects fold
    // completely and the preview limit may hide them.
    const previewIsUnread = keepUnreadSessionsVisible ? isSessionUnread : undefined
    // Blocked lens + travel state (#1717). Transient for the same reason.
    const [showBlockedOnly, setShowBlockedOnly] = useState(false)
    const [blockedSectionCollapsed, setBlockedSectionCollapsed] = useState(false)
    const [pendingBlockedScrollId, setPendingBlockedScrollId] = useState<string | null>(null)
    /** One row exempted from the saved status / machine / date filters so the
     *  jump can reach it without rewriting the operator's preferences. */
    const [revealBlockedSessionId, setRevealBlockedSessionId] = useState<string | null>(null)
    /** Set while a row's dismissal dialog is open, so the exemption above is
     *  not withdrawn mid-entry and take the dialog and its draft with it. */
    const [blockedDialogSessionId, setBlockedDialogSessionId] = useState<string | null>(null)
    const holdBlockedDialog = useCallback(
        (sessionId: string | null) => setBlockedDialogSessionId(sessionId),
        []
    )
    const [flashBlockedSessionId, setFlashBlockedSessionId] = useState<string | null>(null)
    const [blockedOffscreen, setBlockedOffscreen] = useState<{ above: number; below: number }>(
        { above: 0, below: 0 }
    )
    const blockedJumpCursorRef = useRef(0)
    const { pinInProgressMode } = usePinInProgressSessions()
    // List sort/filter lives in SessionListView (#2263); jobs mode is #1404.
    const effectivePinInProgressMode: PinInProgressMode = pinInProgressMode
    const { blockedAlertMode } = useBlockedAlertMode()
    const { machineFilter, setMachineFilter } = useSessionListMachineFilter()
    const showDetailedStatus = sessionListStatusMode === 'detailed'
    const [searchQuery, setSearchQuery] = useState('')
    const [searchMode, setSearchMode] = useState<'metadata' | 'content'>('metadata')
    const [searchMatchMode, setSearchMatchMode] = useState<SessionSearchMode>('default')
    const [contentSearchResponse, setContentSearchResponse] = useState<SessionContentSearchResponse | null>(null)
    const [contentSearchLoading, setContentSearchLoading] = useState(false)
    const [contentSearchError, setContentSearchError] = useState(false)
    const [searchExpanded, setSearchExpanded] = useState(false)
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [markAllReadOpen, setMarkAllReadOpen] = useState(false)
    const quickUnpinFocusRef = useRef<QuickUnpinFocusTarget | null>(null)
    // Actions-box width is the real icon budget (#2039). Measuring the full
    // row and subtracting a guessed search reserve left empty space after More.
    const headerRowRef = useRef<HTMLDivElement>(null)
    const headerActionsRef = useRef<HTMLDivElement>(null)
    const toolbarMeasureRef = useRef<HTMLDivElement>(null)
    const actionsObserverRef = useRef<ResizeObserver | null>(null)
    const [headerRowWidth, setHeaderRowWidth] = useState(0)
    const [toolbarSlotWidths, setToolbarSlotWidths] = useState<Record<string, number>>({})
    const [toolbarChrome, setToolbarChrome] = useState({ morePx: TOOLBAR_MORE_PX, gapPx: TOOLBAR_GAP_PX, blockedPx: 0 })
    const blockedControlsRef = useRef<HTMLDivElement>(null)
    const [searchChromePx, setSearchChromePx] = useState(0)
    const [searchMaxPx, setSearchMaxPx] = useState(0)
    // jsdom reports clientWidth 0; the row observer publishes the stubbed width.
    const [toolbarRowBoxPx, setToolbarRowBoxPx] = useState(0)
    // Search expand unmounts the actions box. A callback ref re-observes the
    // new node when search collapses; an effect keyed only on showHeaderRow does not.
    const setHeaderActionsNode = useCallback((node: HTMLDivElement | null) => {
        headerActionsRef.current = node
        actionsObserverRef.current?.disconnect()
        actionsObserverRef.current = null
        // Search expand unmounts this node — keep the last positive width so
        // we do not fall back to a permissive unmeasured budget mid-cycle.
        if (!node || typeof ResizeObserver === 'undefined') return
        const publishActions = (reported = 0) => {
            // flex-1 allocation, not the icon cluster's intrinsic width and not
            // the previous expanded-search layout (#2040).
            const allocated = node.clientWidth
            const width = allocated > 0 ? allocated : reported
            if (width > 0) setHeaderRowWidth(width)
        }
        const ro = new ResizeObserver((entries) => {
            let actionsWidth = 0
            let sawActions = false
            for (const entry of entries) {
                const target = entry.target
                const reported = entry.contentRect.width ?? 0
                const client = target instanceof HTMLElement ? target.clientWidth : 0
                const width = client > 0 ? client : reported
                if (target === headerRowRef.current && target !== node && width > 0) {
                    setToolbarRowBoxPx((previous) => previous === width ? previous : width)
                }
                if (target === node) {
                    sawActions = true
                    actionsWidth = width
                }
            }
            if (sawActions) publishActions(actionsWidth)
        })
        ro.observe(node)
        const row = headerRowRef.current
        if (row && row !== node) ro.observe(row)
        actionsObserverRef.current = ro
        publishActions(node.clientWidth || node.getBoundingClientRect().width)
    }, [])
    const normalizedQuery = normalizeSearch(searchQuery)
    const timeRange = getSessionTimeRange(customStart, customEnd)
    const isSearchFiltering = normalizedQuery.length > 0 || timeRange !== null
    const isFiltering = isSearchFiltering || listView.unreadOnly || showScratchlistOnly || showActiveOnly || showWorkingOnly

    const contentSearchActive = searchMode === 'content' && normalizedQuery.length > 0
    const contentSearchReady = contentSearchActive
        && Array.from(normalizedQuery).length >= MIN_CONTENT_SEARCH_QUERY_LENGTH
    const contentSearchHasIncompleteResults = contentSearchActive
        && contentSearchReady
        && !contentSearchLoading
        && !contentSearchError
        && contentSearchResponse?.hasPotentiallyIncompleteResults === true

    const resolveMachineLabel = (machineId: string | null): string => {
        if (machineId && machineLabelsById[machineId]) {
            return machineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }

    // Split so the blocked count can be taken BEFORE status/unread narrowing:
    // a blocked agent whose CLI disconnected is exactly the one worth
    // surfacing, and it is not "active" — `sidebarSessions` stays the
    // pre-narrowed base those fleet-wide counts read from.
    const sidebarSessions = useMemo(
        () => prepareSidebarSessions(props.sessions, selectedSessionId),
        [props.sessions, selectedSessionId]
    )
    const readableSessions = useMemo(
        () => props.sessions.filter(session => shouldShowSessionInSidebar(session, selectedSessionId)),
        [props.sessions, selectedSessionId]
    )
    // Keep status filtering separate from the unread lens. Machine choices are
    // derived from this set, so selecting a machine with no unread matches must
    // stay an empty intersection instead of falling back to another machine.
    // The jump target is exempted exactly where the selected session already
    // is, so revealing one row needs no change to saved preferences.
    const filterExemptId = revealBlockedSessionId ?? selectedSessionId
    // Release a held exemption once nothing is using it — in practice, after an
    // unblock dialog opened on the revealed row is closed.
    //
    // `flashBlockedSessionId === null` cannot carry that decision on its own:
    // it reads the same before the flash starts as after it ends. This effect
    // ran on the render right after the pill set the exemption and revoked it
    // immediately, so the jump target was filtered back out before the scroll
    // effect below could ever find it — the jump did nothing at all.
    // `pendingBlockedScrollId` is what distinguishes the two: it is non-null
    // for exactly the in-flight window between the two.
    useEffect(() => {
        if (blockedDialogSessionId !== null) return
        if (revealBlockedSessionId === null) return
        if (pendingBlockedScrollId !== null) return
        if (flashBlockedSessionId !== null) return
        setRevealBlockedSessionId(null)
    }, [blockedDialogSessionId, revealBlockedSessionId, flashBlockedSessionId, pendingBlockedScrollId])
    const allSessions = useMemo(
        () => filterSessionsForListStatus(sidebarSessions, listView.status, filterExemptId),
        [sidebarSessions, filterExemptId, listView.status]
    )
    const unreadSessionCount = useMemo(
        () => getUnreadSessionCount(readableSessions),
        [lastSeenVersion, readableSessions]
    )
    const sessionActivityDates = useMemo(
        () => new Set(allSessions.map(session => formatDateValue(new Date(session.updatedAt)))),
        [allSessions]
    )
    const hasTextQuery = normalizedQuery.length > 0 && !contentSearchActive
    const timeScopedSessions = useMemo(
        () => timeRange === null
            ? allSessions
            : allSessions.filter(session => sessionMatchesTimeRange(session, timeRange, filterExemptId)),
        [allSessions, filterExemptId, timeRange?.start, timeRange?.end] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const searchScoreIndex = useMemo(
        () => searchMatchMode === 'default' && hasTextQuery
            ? buildSessionSearchScoreIndex(timeScopedSessions, normalizedQuery, resolveMachineLabel)
            : null,
        [hasTextQuery, searchMatchMode, timeScopedSessions, normalizedQuery, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const visibleSessions = useMemo(
        () => {
            if (contentSearchActive) {
                const results = contentSearchResponse?.results.map((result) => result.session) ?? []
                const prepared = prepareSidebarSessions(results, filterExemptId)
                const byStatus = filterSessionsForListStatus(prepared, listView.status, filterExemptId)
                const unreadFiltered = listView.unreadOnly
                    ? filterUnreadSessionsOnly(byStatus, isSessionUnread, filterExemptId)
                    : byStatus
                return unreadFiltered.filter(session => sessionMatchesTimeRange(session, timeRange, filterExemptId))
            }
            if (!isFiltering) return allSessions
            const matched = searchMatchMode === 'exclude'
                ? timeScopedSessions.filter(session => sessionMatchesSearchMode(
                    session,
                    normalizedQuery,
                    resolveMachineLabel(session.metadata?.machineId ?? null),
                    'exclude'
                ))
                : searchScoreIndex
                    ? timeScopedSessions.filter(session => searchScoreIndex.matchedIds.has(session.id))
                    : timeScopedSessions.filter(session => sessionMatchesQuery(
                        session,
                        normalizedQuery,
                        resolveMachineLabel(session.metadata?.machineId ?? null)
                    ))
            if (hasTextQuery && searchScoreIndex) {
                return sortSessionsBySearchRelevance(matched, searchScoreIndex)
            }
            return matched
        },
        [allSessions, contentSearchActive, contentSearchResponse, hasTextQuery, isFiltering, normalizedQuery, searchMatchMode, searchScoreIndex, filterExemptId, listView.status, listView.unreadOnly, isSessionUnread, machineLabelsById, timeScopedSessions, timeRange?.start, timeRange?.end] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const contentSnippetBySessionId = useMemo(() => {
        const snippets = new Map<string, string>()
        for (const result of contentSearchResponse?.results ?? []) {
            snippets.set(result.session.id, result.match.snippet)
        }
        return snippets
    }, [contentSearchResponse])
    const contentTargetMessageIdBySessionId = useMemo(() => {
        const messageIds = new Map<string, string>()
        for (const result of contentSearchResponse?.results ?? []) {
            messageIds.set(result.session.id, result.match.messageId)
        }
        return messageIds
    }, [contentSearchResponse])
    const contentSearchTruncatedBySessionId = useMemo(() => {
        const truncated = new Set<string>()
        for (const result of contentSearchResponse?.results ?? []) {
            if (result.match.truncated) truncated.add(result.session.id)
        }
        return truncated
    }, [contentSearchResponse])
    const allGroups = useMemo(
        () => groupSessionsByDirectory(allSessions),
        [allSessions]
    )
    const machineFilters = useMemo(
        () => groupByMachine(allGroups, resolveMachineLabel),
        [allGroups, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const machineFilterItems = useMemo(
        () => machineFilters.map((mg) => {
            const machine = mg.machineId ? machinesById[mg.machineId] : undefined
            return {
                id: mg.machineId ?? UNKNOWN_MACHINE_ID,
                label: mg.label,
                sessionCount: mg.totalSessions,
                healthPresentation: presentMachineHealth(
                    machine?.health,
                    getMachinePlatform(machine)
                )
            }
        }),
        [machineFilters, machinesById]
    )
    const showMachineFilterBar = machineFilters.length >= 2
    // With a single machine there is nothing to filter, but health and the
    // session count still belong in the sidebar: render a compact summary
    // row instead of the filter bar. The row is derived from session groups,
    // but those disappear when the sole machine has no visible sessions
    // (fresh install, or "active only" filtering); fall back to the machines
    // list so its health stays visible (#1259).
    const soleRegisteredMachine = machineFilters.length === 0 && Object.keys(machinesById).length === 1
        ? Object.values(machinesById)[0]
        : null
    const singleMachineItem = machineFilters.length === 1
        ? machineFilterItems[0]
        : soleRegisteredMachine
            ? {
                id: soleRegisteredMachine.id,
                label: resolveMachineLabel(soleRegisteredMachine.id),
                sessionCount: 0,
                healthPresentation: presentMachineHealth(
                    soleRegisteredMachine.health,
                    getMachinePlatform(soleRegisteredMachine)
                )
            }
            : null
    // A persisted filter whose machine no longer has sessions falls back to
    // "All"; with at most one machine the bar is hidden and never filters.
    const activeMachineFilter = showMachineFilterBar && machineFilter !== null
        && machineFilters.some(mg => (mg.machineId ?? UNKNOWN_MACHINE_ID) === machineFilter)
        ? machineFilter
        : null

    const contentSearchCandidateSessions = useMemo(() => {
        let filtered = allSessions.filter(session => sessionMatchesTimeRange(session, timeRange, filterExemptId))
        if (listView.unreadOnly) {
            filtered = filterUnreadSessionsOnly(
                filtered,
                isSessionUnread,
                filterExemptId
            )
        }
        if (showActiveOnly) {
            filtered = filterActiveSessionsOnly(filtered, filterExemptId)
        }
        if (showWorkingOnly) {
            filtered = filterWorkingSessionsOnly(filtered, filterExemptId)
        }
        if (showScratchlistOnly) {
            if (isScratchlistStatusLoading || scratchlistStatusError) return []
            filtered = filterScratchlistSessionsOnly(filtered, filterExemptId, scratchlistSessionIds)
        }
        // The blocked lens has to narrow the candidate ids too, not just the
        // rendered rows. `searchMessageContent` keeps only the 100 most
        // recently updated matching sessions, so submitting unblocked
        // candidates lets them consume the budget and drop an older blocked
        // match the lens is specifically asking for.
        if (showBlockedOnly) {
            const now = Date.now()
            filtered = filtered.filter(session =>
                session.id === filterExemptId || sessionIsBlocked(session, { now })
            )
        }
        return activeMachineFilter === null
            ? filtered
            : filtered.filter(session =>
                (session.metadata?.machineId ?? UNKNOWN_MACHINE_ID) === activeMachineFilter
            )
    }, [
        allSessions,
        activeMachineFilter,
        isScratchlistStatusLoading,
        lastSeenVersion,
        scratchlistSessionIds,
        scratchlistStatusError,
        filterExemptId,
        showScratchlistOnly,
        showActiveOnly,
        showWorkingOnly,
        showBlockedOnly,
        listView.unreadOnly,
        timeRange?.start,
        timeRange?.end
    ])

    const contentSearchSessionIds = useMemo(
        () => contentSearchCandidateSessions.map(session => session.id),
        [contentSearchCandidateSessions]
    )

    useEffect(() => {
        if (!contentSearchReady || !api) {
            setContentSearchResponse(null)
            setContentSearchLoading(false)
            setContentSearchError(false)
            return
        }

        // Do not leave the previous query's targets clickable while the new
        // request is waiting for its debounce window.
        setContentSearchResponse(null)
        setContentSearchError(false)
        if (contentSearchSessionIds.length === 0) {
            setContentSearchResponse({ results: [], hasPotentiallyIncompleteResults: false })
            setContentSearchLoading(false)
            return
        }

        const controller = new AbortController()
        setContentSearchLoading(true)
        const timer = window.setTimeout(() => {
            const limit = Math.min(100, Math.max(50, contentSearchSessionIds.length))
            void api.searchSessionContent(
                normalizedQuery,
                limit,
                controller.signal,
                contentSearchSessionIds
            )
                .then((response) => {
                    if (controller.signal.aborted) return
                    setContentSearchResponse(response)
                })
                .catch(() => {
                    if (controller.signal.aborted) return
                    setContentSearchResponse({ results: [], hasPotentiallyIncompleteResults: false })
                    setContentSearchError(true)
                })
                .finally(() => {
                    if (!controller.signal.aborted) setContentSearchLoading(false)
                })
        }, 180)

        return () => {
            window.clearTimeout(timer)
            controller.abort()
        }
    }, [api, contentSearchReady, contentSearchSessionIds, normalizedQuery])


    // Apply the session lens after search/time and before machine scope — so
    // machineFilters (from allSessions) stay stable. Filtering into allSessions
    // would drop machines with zero matching sessions and clear a persisted
    // machine selection.
    const sessionFilteredSessions = useMemo(() => {
        let filtered = listView.unreadOnly
            ? filterUnreadSessionsOnly(visibleSessions, isSessionUnread, filterExemptId)
            : visibleSessions
        // Active and Working are AND-composed with the other lenses (#2002).
        // Both are ephemeral, independent of the persisted listView.status
        // ("Active sessions only" in Settings) — a temporary scan should not
        // read or write that saved preference.
        if (showActiveOnly) {
            filtered = filterActiveSessionsOnly(filtered, filterExemptId)
        }
        if (showWorkingOnly) {
            filtered = filterWorkingSessionsOnly(filtered, filterExemptId)
        }
        if (showScratchlistOnly) {
            if (isScratchlistStatusLoading || scratchlistStatusError) {
                return []
            }
            filtered = filterScratchlistSessionsOnly(
                filtered,
                filterExemptId,
                scratchlistSessionIds
            )
        }
        // Blocked lens. Sits alongside the native unread-only view filter
        // rather than inside it: "you have not looked at this" and "it stopped
        // and needs you" are different questions, and a blocked session you
        // already read is still blocked.
        if (showBlockedOnly) {
            const now = Date.now()
            filtered = filtered.filter(session =>
                session.id === filterExemptId || sessionIsBlocked(session, { now })
            )
        }
        return filtered
    }, [
        showBlockedOnly,
        isScratchlistStatusLoading,
        lastSeenVersion,
        scratchlistSessionIds,
        scratchlistStatusError,
        filterExemptId,
        showScratchlistOnly,
        showActiveOnly,
        showWorkingOnly,
        listView.unreadOnly,
        visibleSessions
    ])
    const machineFilteredSessions = useMemo(
        () => activeMachineFilter === null
            ? sessionFilteredSessions
            : sessionFilteredSessions.filter(session =>
                // `revealBlockedSessionId`, NOT `filterExemptId`. The latter
                // falls back to the selected session, which widened the base
                // machine filter: with a machine-A session open, switching the
                // list to machine B left A's row on screen with no jump
                // involved. Only an in-flight jump may cross machines, and
                // only for as long as it holds its exemption.
                session.id === revealBlockedSessionId
                || (session.metadata?.machineId ?? UNKNOWN_MACHINE_ID) === activeMachineFilter
            ),
        [sessionFilteredSessions, activeMachineFilter, revealBlockedSessionId]
    )
    const globalPinnedSessions = useMemo(() => {
        const pinned = machineFilteredSessions.filter((session) => Boolean(session.globalPinned))
        if (searchScoreIndex && hasTextQuery) {
            return sortSessionsBySearchRelevance(pinned, searchScoreIndex)
        }
        return [...pinned].sort(listComparator)
    }, [machineFilteredSessions, searchScoreIndex, hasTextQuery, listComparator])
    // Fleet-wide count, deliberately computed BEFORE search / time / unread /
    // machine narrowing: the pill exists to tell the operator how much blocked
    // work exists, and a count that silently shrank behind a filter would be
    // worse than no count at all. `jumpToNextBlocked` drops those filters when
    // it has to reach one of these rows.
    const blockedSessions = useMemo(() => {
        const now = Date.now()
        return sidebarSessions
            .filter(session => sessionIsBlocked(session, { now }))
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }, [sidebarSessions])
    const blockedCount = blockedSessions.length
    const blockedAlerting = useBlockedArrivalAlert(
        useMemo(() => blockedSessions.map(session => session.id), [blockedSessions]),
        blockedAlertMode,
        props.sessions.length > 0
    )

    // Rows for the pinned Blocked section. Globally pinned rows keep their own
    // section (the operator put them there on purpose) and still carry the
    // rail + chip where they sit.
    const blockedSectionSessions = useMemo(() => {
        const now = Date.now()
        return machineFilteredSessions
            .filter(session => !session.globalPinned && sessionIsBlocked(session, { now }))
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }, [machineFilteredSessions])
    const blockedSectionIds = useMemo(
        () => new Set(blockedSectionSessions.map(session => session.id)),
        [blockedSectionSessions]
    )

    const runningSessions = useMemo(() => {
        const byRelevanceOrRecent = (a: SessionSummary, b: SessionSummary) => {
            if (searchScoreIndex && hasTextQuery) {
                return compareSessionsBySearchRelevance(a, b, searchScoreIndex)
            }
            return listComparator(a, b)
        }
        // Floated into the Blocked section instead. Without this a blocked
        // but still-connected agent renders twice — and worse, the quiet
        // grey "Active" bucket is exactly where it used to hide.
        const candidates = machineFilteredSessions.filter(session => !blockedSectionIds.has(session.id))
        return bucketRunningSessions(candidates, effectivePinInProgressMode, byRelevanceOrRecent)
    }, [machineFilteredSessions, blockedSectionIds, effectivePinInProgressMode, searchScoreIndex, hasTextQuery, listComparator])
    const runningSessionTotal = runningSessions.jobs.length
        + runningSessions.working.length
        + runningSessions.pending.length
    const groups = useMemo(
        () => {
            const grouped = groupSessionsByDirectory(
                machineFilteredSessions.filter((session) => {
                    if (session.globalPinned) return false
                    if (blockedSectionIds.has(session.id)) return false
                    if (
                        effectivePinInProgressMode !== 'off'
                        && !session.pinned
                        && isPinnedInProgressSession(session, effectivePinInProgressMode)
                    ) return false
                    return true
                }),
                // Search keeps its own contract: relevance first, then the stable
                // last-message order for ties, whatever the list view says.
                hasTextQuery ? undefined : listView
            )
            if (searchScoreIndex && hasTextQuery) {
                return rankSessionGroupsBySearchRelevance(grouped, searchScoreIndex)
            }
            return grouped
        },
        [machineFilteredSessions, effectivePinInProgressMode, blockedSectionIds, searchScoreIndex, hasTextQuery, listView]
    )
    // Directory groups whose rows all floated to the pinned sections still
    // render an action-only header so copy-path / new-session-in-directory
    // stay available (no rows to group, but the project itself is live).

    // Based on the same machineFilteredSessions set as `groups` so the machine
    // filter stays consistent.

    const allDirectoryGroups = useMemo(
        () => groupSessionsByDirectory(
            machineFilteredSessions.filter((session) => !session.globalPinned),
            listView
        ),
        [machineFilteredSessions, listView]
    )
    // Unfiltered project membership for group-wide actions (archive all).
    const projectSessionsByKey = useMemo(
        () => new Map(groupSessionsByDirectory(props.sessions).map((group) => [group.key, group.sessions])),
        [props.sessions]
    )
    const actionOnlyGroups = useMemo(() => {
        // Under the blocked lens the operator asked for blocked rows and
        // nothing else; every directory would otherwise contribute a bare
        // action-only header, which is exactly the noise the lens removes.
        if (showBlockedOnly) {
            return []
        }
        // Otherwise also needed when the Blocked section (not the in-progress
        // pin) is what emptied a directory, or the project's copy-path /
        // new-session actions would vanish with its last row.
        if (effectivePinInProgressMode === 'off' && blockedSectionIds.size === 0) {
            return []
        }
        const visibleKeys = new Set(groups.map((group) => group.key))
        return allDirectoryGroups.filter((group) => !visibleKeys.has(group.key))
    }, [groups, allDirectoryGroups, effectivePinInProgressMode, blockedSectionIds, showBlockedOnly])
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [filterCollapseOverrides, setFilterCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [runningSectionCollapsed, setRunningSectionCollapsed] = useState(false)
    const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false)
    const autoExpandedSelectedSessionKeyRef = useRef<string | null>(null)
    const isGroupCollapsed = (group: SessionGroup): boolean => {
        const override = isFiltering
            ? filterCollapseOverrides.get(group.key)
            : collapseOverrides.get(group.key)
        if (override !== undefined) return override
        // Keep matching groups open by default while filtering. Explicit
        // header clicks use a temporary override for the active filter.
        if (isFiltering) return false
        // Archived-only would otherwise collapse every group (none has an
        // active session), hiding exactly what was asked for.
        if (listView.status === 'archived') return false
        // Unread-only would otherwise fold unread rows into quiet collapsed groups.
        if (listView.unreadOnly) return false
        const hasSelectedSession = selectedSessionId
            ? group.sessions.some(session => session.id === selectedSessionId)
            : false
        return !group.hasActiveSession && !group.hasPinnedSession && !hasSelectedSession
    }

    const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
        const setOverrides = isFiltering ? setFilterCollapseOverrides : setCollapseOverrides
        setOverrides(prev => {
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }

    useEffect(() => {
        if (isFiltering) return
        setFilterCollapseOverrides(prev => prev.size === 0 ? prev : new Map())
    }, [isFiltering])

    // Per-group reveal cap for paginated session previews. Absent = the configured
    // preview limit; expand/collapse controls move the cap by one preview-sized batch.
    const [sessionVisibleCounts, setSessionVisibleCounts] = useState<Map<string, number>>(
        () => new Map()
    )

    const getGroupVisibleCount = (group: SessionGroup): number => {
        return sessionVisibleCounts.get(group.key) ?? sessionPreviewLimit
    }

    const showMoreSessions = (group: SessionGroup) => {
        setSessionVisibleCounts(prev => {
            const next = new Map(prev)
            const currentLimit = Math.min(
                prev.get(group.key) ?? sessionPreviewLimit,
                group.sessions.length
            )
            const currentVisibleCount = getVisibleSessionPreview(group.sessions, {
                selectedSessionId,
                limit: currentLimit,
                isUnread: previewIsUnread
            }).length
            next.set(group.key, getNextSessionVisibleCount(
                Math.max(currentLimit, currentVisibleCount),
                sessionPreviewLimit,
                group.sessions.length
            ))
            return next
        })
    }

    const showFewerSessions = (group: SessionGroup) => {
        setSessionVisibleCounts(prev => {
            const next = new Map(prev)
            const current = Math.min(
                prev.get(group.key) ?? sessionPreviewLimit,
                group.sessions.length
            )
            const previous = getPreviousSessionVisibleCount(current, sessionPreviewLimit)
            if (previous <= sessionPreviewLimit) {
                next.delete(group.key)
            } else {
                next.set(group.key, previous)
            }
            return next
        })
    }

    const getVisibleGroupSessions = (group: SessionGroup): SessionSummary[] => {
        return getVisibleSessionPreview(
            group.sessions,
            {
                selectedSessionId,
                limit: getGroupVisibleCount(group),
                isUnread: previewIsUnread
            }
        )
    }

    const renderPinnedSection = ({
        sectionKey,
        titleKey,
        collapsed,
        onToggle,
        pulse,
        count,
        bucketKeys,
    }: {
        sectionKey: string
        titleKey: string
        collapsed: boolean
        onToggle: () => void
        pulse: boolean
        count: number
        bucketKeys: RunningBucketKey[]
    }) => {
        if (count === 0) {
            return null
        }
        return (
            <div key={sectionKey}>
                <div
                    className="group/running flex min-w-0 w-full select-none cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-2 pr-2 transition-colors hover:bg-[var(--app-secondary-bg)]"
                    role="button"
                    tabIndex={0}
                    aria-expanded={!collapsed || isFiltering}
                    onClick={onToggle}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onToggle()
                        }
                    }}
                    title={t(titleKey)}
                >
                    <ChevronIcon className="h-3.5 w-3.5 text-[var(--app-hint)] shrink-0" collapsed={collapsed && !isFiltering} />
                    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                        <LowRatePulseDot
                            pulse={pulse}
                            className="h-1.5 w-1.5 rounded-full bg-[var(--app-badge-success-text)]"
                        />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {t(titleKey)}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                        ({count})
                    </span>
                </div>
                <CollapsiblePanel open={!collapsed || isFiltering}>
                    <div className="flex flex-col gap-0.5 ml-3 pl-1 py-1">
                        {bucketKeys.map((bucketKey) => {
                            const bucket = RUNNING_BUCKETS.find((b) => b.key === bucketKey)
                            const sessions = runningSessions[bucketKey]
                            if (!bucket || sessions.length === 0) {
                                return null
                            }
                            return (
                                <div key={bucketKey}>
                                    <div className={`flex items-center gap-1 px-1 pt-1 pb-0.5 text-[11px] font-medium ${bucket.colorClass}`}>
                                        <LowRatePulseDot
                                            pulse={bucket.pulse}
                                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
                                        />
                                        {t(bucket.labelKey)} ({sessions.length})
                                    </div>
                                    {sessions.map((s) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            showPath={false}
                                            api={api}
                                            features={features}
                                            prNowMs={prNowMs}
                                            titleSuggestionAvailable={titleSuggestionAvailable}
                                            selected={s.id === selectedSessionId}
                                            showDetailedStatus={showDetailedStatus}
                                            inRunningSection
                                            projectLabel={getSessionProjectLabel(getSessionProjectPath(s.metadata) ?? 'Other')}
                                            machineLabel={showMachineFilterBar && activeMachineFilter === null
                                                ? resolveMachineLabel(s.metadata?.machineId ?? null)
                                                : undefined}
                                            contentSnippet={contentSnippetBySessionId.get(s.id)}
                                            contentSearchTruncated={contentSearchTruncatedBySessionId.has(s.id)}
                                            targetMessageId={contentTargetMessageIdBySessionId.get(s.id)}
                                            targetMessageQuery={contentSearchActive ? normalizedQuery : undefined}
                                            lastSeenVersion={lastSeenVersion}
                                        />
                                    ))}
                                </div>
                            )
                        })}
                    </div>
                </CollapsiblePanel>
            </div>
        )
    }

    const getNewSessionInGroup = (group: SessionGroup) => (
        onNewSessionInDirectory && group.directory !== 'Other'
            ? () => onNewSessionInDirectory({ machineId: group.machineId, directory: group.directory })
            : undefined
    )

    const renderNewSessionInGroupButton = (group: SessionGroup) => {
        const onNew = getNewSessionInGroup(group)
        return onNew ? (
            <button
                type="button"
                onClick={(event) => {
                    event.stopPropagation()
                    onNew()
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] opacity-70 transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                title={t('sessions.group.new')}
                aria-label={t('sessions.group.new')}
            >
                <PlusIcon className="h-3.5 w-3.5" />
            </button>
        ) : null
    }

    const renderActionOnlyGroupHeader = (group: SessionGroup) => {
        // With multiple machines in the unfiltered view, disambiguate
        // same-named directories by suffixing the machine label.
        const groupTitle = showMachineFilterBar && activeMachineFilter === null
            ? `${group.displayName} · ${resolveMachineLabel(group.machineId)}`
            : group.displayName
        return (
            <div key={group.key} data-session-scroll-anchor>
                <ProjectGroupRow
                    className="group/project sticky top-0 z-10 flex items-center gap-2 bg-[var(--app-bg)] py-1.5 pl-2 pr-2 text-left rounded-lg transition-colors hover:bg-[var(--app-secondary-bg)] min-w-0 w-full select-none"
                    directory={group.directory}
                    displayName={groupTitle}
                    sessions={projectSessionsByKey.get(group.key) ?? group.sessions}
                    api={api}
                    onNewSession={getNewSessionInGroup(group)}
                >
                    <span className="font-medium text-sm truncate flex-1">
                        {groupTitle}
                    </span>
                    <CopyPathButton path={group.directory} className="opacity-0 group-hover/project:opacity-100 transition-opacity duration-150" />
                    {renderNewSessionInGroupButton(group)}
                </ProjectGroupRow>
            </div>
        )
    }

    const renderGroupSessionItem = (s: SessionSummary) => (
        <SessionItem
            session={s}
            onSelect={props.onSelect}
            showPath={false}
            api={api}
            features={features}
            prNowMs={prNowMs}
            titleSuggestionAvailable={titleSuggestionAvailable}
            selected={s.id === selectedSessionId}
            showDetailedStatus={showDetailedStatus}
            contentSnippet={contentSnippetBySessionId.get(s.id)}
            contentSearchTruncated={contentSearchTruncatedBySessionId.has(s.id)}
            targetMessageId={contentTargetMessageIdBySessionId.get(s.id)}
            targetMessageQuery={contentSearchActive ? normalizedQuery : undefined}
            lastSeenVersion={lastSeenVersion}
        />
    )

    const renderDirectoryGroup = (group: SessionGroup) => {
        const isCollapsed = isGroupCollapsed(group)
        const visibleGroupSessions = getVisibleGroupSessions(group)
        // A collapsed group still shows its unread rows, so new output in a
        // quiet project is never folded out of sight. Each row folds on its
        // own instead of moving to a separate list, so toggling the group
        // never remounts (and re-animates) the rows that stay visible.
        const isRowOpen = (s: SessionSummary) => !isCollapsed || (keepUnreadSessionsVisible && isSessionUnread(s))
        const anyRowOpen = visibleGroupSessions.some(isRowOpen)
        const hiddenSessionCount = group.sessions.length - visibleGroupSessions.length
        const currentLimit = Math.min(
            getGroupVisibleCount(group),
            group.sessions.length
        )
        const previousLimit = getPreviousSessionVisibleCount(currentLimit, sessionPreviewLimit)
        const previousGroupSessions = getVisibleSessionPreview(group.sessions, {
            selectedSessionId,
            limit: previousLimit,
            isUnread: previewIsUnread
        })
        const collapseCount = visibleGroupSessions.length - previousGroupSessions.length
        const canShowFewerSessions = previousLimit < currentLimit && collapseCount > 0
        const expandCount = Math.min(sessionPreviewLimit, hiddenSessionCount)
        // With multiple machines in the unfiltered view, disambiguate
        // same-named directories by suffixing the machine label.
        const groupTitle = showMachineFilterBar && activeMachineFilter === null
            ? `${group.displayName} · ${resolveMachineLabel(group.machineId)}`
            : group.displayName
        return (
            <div key={group.key} data-session-scroll-anchor>
                <ProjectGroupRow
                    className="group/project sticky top-0 z-10 flex items-center gap-2 bg-[var(--app-bg)] py-1.5 pl-2 pr-2 text-left rounded-lg transition-colors hover:bg-[var(--app-secondary-bg)] cursor-pointer min-w-0 w-full select-none"
                    directory={group.directory}
                    displayName={groupTitle}
                    sessions={projectSessionsByKey.get(group.key) ?? group.sessions}
                    api={api}
                    onClick={() => toggleGroup(group.key, isCollapsed)}
                    expanded={!isCollapsed}
                    onNewSession={getNewSessionInGroup(group)}
                >
                    <ChevronIcon className="h-3.5 w-3.5 text-[var(--app-hint)] shrink-0" collapsed={isCollapsed} />
                    <span className="font-medium text-sm truncate flex-1">
                        {groupTitle}
                    </span>
                    <CopyPathButton path={group.directory} className="opacity-0 group-hover/project:opacity-100 transition-opacity duration-150" />
                    {renderNewSessionInGroupButton(group)}
                    <span className="text-[11px] tabular-nums text-[var(--app-hint)] shrink-0">
                        ({group.sessions.length})
                    </span>
                </ProjectGroupRow>

                {/* Sessions. Spacing lives inside the panels so folded rows take no room. */}
                <div className="flex flex-col ml-3 pl-1" data-open={!isCollapsed || undefined}>
                    <CollapsiblePanel open={anyRowOpen}>
                        <div className="h-1" />
                    </CollapsiblePanel>
                    {visibleGroupSessions.map((s, index) => (
                        <CollapsiblePanel key={s.id} open={isRowOpen(s)}>
                            {shouldShowPinnedDivider(visibleGroupSessions, index) ? (
                                <CollapsiblePanel open={!isCollapsed}>
                                    <div
                                        data-testid="session-pin-divider"
                                        className="ml-2.5 mr-2 mb-1.5 mt-1 border-t border-[var(--app-border)]"
                                        aria-hidden="true"
                                    />
                                </CollapsiblePanel>
                            ) : null}
                            <div className="pb-0.5">
                                {renderGroupSessionItem(s)}
                            </div>
                        </CollapsiblePanel>
                    ))}
                    {group.sessions.length > sessionPreviewLimit && (hiddenSessionCount > 0 || canShowFewerSessions) ? (
                        <CollapsiblePanel open={!isCollapsed}>
                            <div className="ml-2.5 mr-2 mt-1 mb-1.5 flex gap-1.5">
                                {canShowFewerSessions ? (
                                    <button
                                        type="button"
                                        onClick={() => showFewerSessions(group)}
                                        className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-dashed border-[var(--app-border)] px-2 py-1 text-center text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                    >
                                        <SessionPreviewArrowIcon direction="up" className="h-3 w-3 shrink-0" />
                                        {t('sessions.group.collapse', { n: collapseCount })}
                                    </button>
                                ) : null}
                                {hiddenSessionCount > 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => showMoreSessions(group)}
                                        className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-dashed border-[var(--app-border)] px-2 py-1 text-center text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                    >
                                        <SessionPreviewArrowIcon direction="down" className="h-3 w-3 shrink-0" />
                                        {t('sessions.group.expand', { n: expandCount })}
                                    </button>
                                ) : null}
                            </div>
                        </CollapsiblePanel>
                    ) : null}
                    <CollapsiblePanel open={anyRowOpen}>
                        <div className="h-0.5" />
                    </CollapsiblePanel>
                </div>
            </div>
        )
    }

    // Auto-expand group containing the selected session only when
    // the selected-session/group pair changes. Without this guard, every live
    // session-list refresh (for example tool-call updates from a running selected
    // session) reopens a path the user just collapsed.
    useEffect(() => {
        if (!selectedSessionId) {
            autoExpandedSelectedSessionKeyRef.current = null
            return
        }

        // Pinned "in progress" sessions are not rendered inside directory
        // groups, so only auto-expand when the selected session actually lives
        // in a visible group. Using `allGroups` here would expand the group
        // below whenever a running session is opened.
        const group = groups.find(g =>
            g.sessions.some(s => s.id === selectedSessionId)
        )
        if (!group) {
            // The selected session is not rendered inside any directory group
            // (e.g. it moved to the pinned "in progress" section). Drop the
            // guard so it auto-expands again when it transitions back into a
            // group later.
            if (!isFiltering) {
                autoExpandedSelectedSessionKeyRef.current = null
            }
            return
        }

        const autoExpandKey = `${selectedSessionId}::${group.key}`
        if (autoExpandedSelectedSessionKeyRef.current === autoExpandKey) return
        autoExpandedSelectedSessionKeyRef.current = autoExpandKey

        const setOverrides = isFiltering ? setFilterCollapseOverrides : setCollapseOverrides
        setOverrides(prev => expandSelectedSessionCollapseOverrides(prev, group))
    }, [selectedSessionId, groups, isFiltering])

    // Keep a keyboard-unpinned row reachable when it moves into a collapsed or
    // truncated destination section, or fall back to a visible row if removed.
    useLayoutEffect(() => {
        const target = quickUnpinFocusRef.current
        if (!target) return

        const activeEl = document.activeElement
        const activeRowId = activeEl instanceof Element
            ? activeEl.closest('[data-session-row-id]')?.getAttribute('data-session-row-id')
            : null
        if (activeEl && activeEl !== document.body && activeRowId !== target.sessionId) {
            quickUnpinFocusRef.current = null
            return
        }

        if (globalPinnedSessions.some((session) => session.id === target.sessionId)) {
            if (!target.pending) quickUnpinFocusRef.current = null
            return
        }

        const inRunning = [...runningSessions.jobs, ...runningSessions.working, ...runningSessions.pending]
            .some((session) => session.id === target.sessionId)
        if (inRunning) {
            if (runningSectionCollapsed && !isFiltering) {
                setRunningSectionCollapsed(false)
                return
            }
            if (!target.pending) quickUnpinFocusRef.current = null
            return
        }

        const targetGroup = groups.find((group) =>
            group.sessions.some((session) => session.id === target.sessionId)
        )
        if (targetGroup) {
            const collapsed = isGroupCollapsed(targetGroup)
            const peekingUnread = collapsed
                && keepUnreadSessionsVisible
                && targetGroup.sessions.some((session) => session.id === target.sessionId && isSessionUnread(session))
            let expanding = false
            if (collapsed && !peekingUnread) {
                expanding = true
                const setOverrides = isFiltering ? setFilterCollapseOverrides : setCollapseOverrides
                setOverrides((prev) => expandSelectedSessionCollapseOverrides(prev, targetGroup))
            }

            const targetIndex = targetGroup.sessions.findIndex((session) => session.id === target.sessionId)
            if (targetIndex >= 0 && !getVisibleGroupSessions(targetGroup).some((session) => session.id === target.sessionId)) {
                expanding = true
                let neededLimit = targetIndex + 1
                for (let i = targetIndex + 1; i < targetGroup.sessions.length; i += 1) {
                    const s = targetGroup.sessions[i]!
                    if (s.id === selectedSessionId || (s.active && s.pendingRequestsCount > 0) || previewIsUnread?.(s)) {
                        neededLimit += 1
                    }
                }
                setSessionVisibleCounts((prev) => {
                    if (neededLimit <= (prev.get(targetGroup.key) ?? sessionPreviewLimit)) return prev
                    const next = new Map(prev)
                    next.set(targetGroup.key, Math.min(neededLimit, targetGroup.sessions.length))
                    return next
                })
            }
            if (!expanding && !target.pending) {
                quickUnpinFocusRef.current = null
            }
            return
        }

        if (!activeEl || activeEl === document.body) {
            const container = scrollContainerRef.current
            const findVisible = (selector: string) =>
                Array.from(container?.querySelectorAll<HTMLElement>(selector) ?? [])
                    .find((el) => !el.closest('.collapsible-panel:not([data-open])'))
            const fallback = findVisible('button[data-session-scroll-anchor]')
                ?? findVisible('[role="button"], button')
            fallback?.focus({ preventScroll: true })
        }
        quickUnpinFocusRef.current = null
    }, [
        globalPinnedSessions, runningSessions, groups, runningSectionCollapsed,
        collapseOverrides, filterCollapseOverrides, sessionVisibleCounts,
        isFiltering, selectedSessionId, keepUnreadSessionsVisible,
        isSessionUnread, sessionPreviewLimit, previewIsUnread,
    ])

    // Clean up stale collapse overrides
    useEffect(() => {
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownKeys = new Set<string>()
            for (const g of allGroups) {
                knownKeys.add(g.key)
                knownKeys.add(`sessions::${g.key}`)
            }
            let changed = false
            for (const key of next.keys()) {
                if (!knownKeys.has(key)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [allGroups])

    // Clean up reveal caps for groups that no longer exist.
    useEffect(() => {
        setSessionVisibleCounts(prev => {
            if (prev.size === 0) return prev
            const knownKeys = new Set(allGroups.map(g => g.key))
            const next = new Map(prev)
            let changed = false
            for (const key of next.keys()) {
                if (!knownKeys.has(key)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [allGroups])

    // The search control unmounts when the list empties; reset the expansion so
    // it cannot suppress header actions (or re-expand on its own when sessions
    // return) while no search control is rendered.
    const showSearch = props.sessions.length > 0
    useEffect(() => {
        if (!showSearch) setSearchExpanded(false)
    }, [showSearch])

    const showHeaderRow = showSearch || renderHeader || Boolean(props.headerActions) || Boolean(props.toolbarExtras?.length)
    const sessionListRef = useRef<HTMLDivElement>(null)

    useEffect(() => () => {
        actionsObserverRef.current?.disconnect()
    }, [])
    useLayoutEffect(() => {
        const search = headerRowRef.current?.querySelector<HTMLElement>('[data-testid="session-list-search"]')
        const nextChrome = search && search.dataset.expanded !== 'true'
            ? measureSearchChrome(search)
            : 0
        setSearchChromePx((previous) => previous === nextChrome ? previous : nextChrome)
        const root = toolbarMeasureRef.current
        if (!root) return
        const next: Record<string, number> = {}
        for (const node of root.querySelectorAll<HTMLElement>('[data-measure-id]')) {
            const id = node.dataset.measureId
            if (!id || id === '__more') continue
            const width = node.offsetWidth
            if (width > 0) next[id] = width
        }
        setToolbarSlotWidths((previous) => {
            const previousKeys = Object.keys(previous)
            const nextKeys = Object.keys(next)
            if (previousKeys.length === nextKeys.length && nextKeys.every((key) => previous[key] === next[key])) {
                return previous
            }
            return next
        })
        const moreNode = root.querySelector<HTMLElement>('[data-measure-id="__more"]')
        const parsedGap = Number.parseFloat(getComputedStyle(root).columnGap)
        const morePx = moreNode && moreNode.offsetWidth > 0 ? moreNode.offsetWidth : TOOLBAR_MORE_PX
        const gapPx = Number.isFinite(parsedGap) && parsedGap > 0 ? parsedGap : TOOLBAR_GAP_PX
        const blockedPx = blockedControlsRef.current?.offsetWidth ?? 0
        setToolbarChrome((previous) => (
            previous.morePx === morePx
            && previous.gapPx === gapPx
            && previous.blockedPx === blockedPx
                ? previous
                : { morePx, gapPx, blockedPx }
        ))
        // Reserve padding + gap + More so search cannot eat the trailing controls (#2040).
        const row = headerRowRef.current
        const rowBox = row && row.clientWidth > 0 ? row.clientWidth : toolbarRowBoxPx
        const rowStyle = row ? getComputedStyle(row) : null
        const rowPad = rowStyle
            ? (Number.parseFloat(rowStyle.paddingLeft) || 0) + (Number.parseFloat(rowStyle.paddingRight) || 0)
            : 0
        const trailing = gapPx
            + morePx
        const nextSearchMax = rowBox > 0 ? Math.max(0, rowBox - rowPad - trailing) : 0
        setSearchMaxPx((previous) => previous === nextSearchMax ? previous : nextSearchMax)
    })

    // Pull-to-refresh on the scrollable list. Touch-only gesture mirroring the
    // pull-to-load-older pattern in HappyThread; desktop has no overscroll
    // bounce to make a wheel pull feel right, so it stays on live updates.
    const scrollContainerRef = useRef<HTMLDivElement>(null)
    useTransientScrollbar(scrollContainerRef, 'left')
    const [pullState, setPullState] = useState<PullToRefreshState>('idle')
    const pullStateRef = useRef<PullToRefreshState>('idle')
    const [isRefreshing, setIsRefreshing] = useState(false)
    const isRefreshingRef = useRef(false)
    const onRefreshRef = useRef(props.onRefresh)
    const scratchlistFilterEnabledRef = useRef(showScratchlistOnly)
    const refetchScratchlistSessionIdsRef = useRef(refetchScratchlistSessionIds)
    useEffect(() => {
        onRefreshRef.current = props.onRefresh
        scratchlistFilterEnabledRef.current = showScratchlistOnly
        refetchScratchlistSessionIdsRef.current = refetchScratchlistSessionIds
    }, [props.onRefresh, refetchScratchlistSessionIds, showScratchlistOnly])

    // Visual-only tick on the session-list scroll rail showing where the open
    // session sits in the whole list. The mark is not a button — you drag the
    // native scrollbar to it. Hidden when the row is filtered out or collapsed
    // away so it never points somewhere wrong.
    const [openSessionTickRatio, setOpenSessionTickRatio] = useState<number | null>(null)
    useEffect(() => {
        const container = scrollContainerRef.current
        if (!container || !selectedSessionId) {
            setOpenSessionTickRatio(null)
            return
        }

        let frame = 0
        let throttle: ReturnType<typeof setTimeout> | undefined
        let measuredAt = 0

        const measureTick = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                measuredAt = Date.now()
                // `aria-current="page"` marks the open row; measure the whole
                // list item it belongs to, not just whichever node carries it.
                const marked = container.querySelector<HTMLElement>('[aria-current="page"]')
                const row = marked?.closest<HTMLElement>('.session-list-item') ?? marked
                const insideCollapsedPanel = row ? isSessionRowInsideCollapsedPanel(row) : false
                const tickRatio = row && !insideCollapsedPanel
                    ? computeOpenSessionTickRatio({
                        scrollHeight: container.scrollHeight,
                        clientHeight: container.clientHeight,
                        ...measureOpenSessionTickContentOffset(container, row),
                    })
                    : null
                const visible = shouldShowOpenSessionTick({
                    selectedSessionId,
                    rowFound: Boolean(row),
                    insideCollapsedPanel,
                    tickRatio,
                })
                setOpenSessionTickRatio(visible ? tickRatio : null)
            })
        }

        // Sidebar churn is chatty — rows reorder as sessions update, badges and
        // spinners mount — and each measurement reads layout. The mark only has
        // to look right, not be frame-exact, so coalesce bursts to ~10/s. The
        // first measurement and the transition handler still run promptly.
        const updateTick = () => {
            if (throttle !== undefined) return
            throttle = setTimeout(() => {
                throttle = undefined
                measureTick()
            }, Math.max(0, TICK_RECOMPUTE_THROTTLE_MS - (Date.now() - measuredAt)))
        }

        measureTick()

        // Sections animate `grid-template-rows` for 250ms (see `.collapsible-panel`),
        // so the scroll container's own box never changes while a group above the
        // open row collapses — only the scrolled content grows or shrinks. Observe
        // the content element as well, and recompute once the transition lands, so
        // the tick settles on the final layout instead of an intermediate frame.
        // Observing the container also covers viewport resizes: the sidebar is
        // flex-sized, so a window resize changes its box (or rewraps the content).
        const content = container.firstElementChild
        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(updateTick)
            : null
        resizeObserver?.observe(container)
        if (content instanceof HTMLElement) {
            resizeObserver?.observe(content)
        }
        const mutationObserver = typeof MutationObserver !== 'undefined'
            ? new MutationObserver(updateTick)
            : null
        mutationObserver?.observe(container, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-open'],
        })
        const handleTransitionEnd = (event: TransitionEvent) => {
            if (event.propertyName === 'grid-template-rows') measureTick()
        }
        container.addEventListener('transitionend', handleTransitionEnd)
        return () => {
            cancelAnimationFrame(frame)
            clearTimeout(throttle)
            resizeObserver?.disconnect()
            mutationObserver?.disconnect()
            container.removeEventListener('transitionend', handleTransitionEnd)
        }
    }, [selectedSessionId])

    useEffect(() => {
        const container = scrollContainerRef.current
        if (!container) return

        let pullStartY: number | null = null

        const updatePullState = (state: PullToRefreshState) => {
            if (pullStateRef.current === state) {
                return
            }
            pullStateRef.current = state
            setPullState(state)
        }

        const triggerRefresh = () => {
            if (isRefreshingRef.current) {
                return
            }
            isRefreshingRef.current = true
            setIsRefreshing(true)
            const refreshes = [Promise.resolve(onRefreshRef.current())]
            if (scratchlistFilterEnabledRef.current) {
                refreshes.push(refetchScratchlistSessionIdsRef.current())
            }
            void Promise.all(refreshes).finally(() => {
                isRefreshingRef.current = false
                setIsRefreshing(false)
            })
        }

        const handleTouchStart = (event: TouchEvent) => {
            updatePullState('idle')
            pullStartY = container.scrollTop <= 0 && !isRefreshingRef.current
                ? event.touches[0]?.clientY ?? null
                : null
        }

        const handleTouchMove = (event: TouchEvent) => {
            if (pullStartY === null) {
                return
            }
            if (container.scrollTop > 0) {
                pullStartY = null
                updatePullState('idle')
                return
            }
            const currentY = event.touches[0]?.clientY
            if (currentY !== undefined) {
                updatePullState(getPullToRefreshState(currentY - pullStartY))
            }
        }

        const handleTouchEnd = () => {
            const shouldRefresh = pullStartY !== null
                && pullStateRef.current === 'ready'
                && container.scrollTop <= 0
            pullStartY = null
            updatePullState('idle')
            if (shouldRefresh) {
                triggerRefresh()
            }
        }

        const handleTouchCancel = () => {
            pullStartY = null
            updatePullState('idle')
        }

        container.addEventListener('touchstart', handleTouchStart, { passive: true })
        container.addEventListener('touchmove', handleTouchMove, { passive: true })
        container.addEventListener('touchend', handleTouchEnd, { passive: true })
        container.addEventListener('touchcancel', handleTouchCancel, { passive: true })
        return () => {
            container.removeEventListener('touchstart', handleTouchStart)
            container.removeEventListener('touchmove', handleTouchMove)
            container.removeEventListener('touchend', handleTouchEnd)
            container.removeEventListener('touchcancel', handleTouchCancel)
        }
    }, [])

    // #1717 off-viewport travel. Because the Blocked section keeps every
    // blocked row mounted at the top of the list, "make the row reachable"
    // only ever means expanding that section and dropping narrowing filters —
    // no directory-group expansion or preview-cap raising required.
    const jumpToNextBlocked = () => {
        if (blockedSessions.length === 0) return
        const renderedIds = new Set(machineFilteredSessions.map((session) => session.id))
        // Pick the target BEFORE deciding to clear anything. Testing "is any
        // blocker hidden" threw away the operator's saved status/unread
        // preferences even when the row we are about to travel to is already
        // on screen — a filter they set is not ours to discard speculatively.
        const cursor = blockedJumpCursorRef.current % blockedSessions.length
        blockedJumpCursorRef.current = cursor + 1
        const target = blockedSessions[cursor]!
        if (!renderedIds.has(target.id)) {
            // Reveal the target through transient state only. Writing
            // `listView` / `machineFilter` persists to local storage, so a
            // navigation action silently destroyed preferences the operator
            // had set — the pill's job is to take them to the row, not to
            // reset their list. Only the ephemeral lenses and the live search
            // box are dropped, and `revealBlockedSessionId` exempts this one
            // row from the rest.
            setSearchQuery('')
            setShowActiveOnly(false)
            setShowWorkingOnly(false)
            setShowScratchlistOnly(false)
            setRevealBlockedSessionId(target.id)
        }
        // A globally pinned blocked row lives in the Pinned section, not the
        // Blocked one — expand both or the jump lands on a zero-height row
        // inside a collapsed panel and appears to do nothing.
        setBlockedSectionCollapsed(false)
        setPinnedSectionCollapsed(false)
        setPendingBlockedScrollId(target.id)
    }

    useEffect(() => {
        if (!pendingBlockedScrollId) return
        const container = scrollContainerRef.current
        const row = container?.querySelector<HTMLElement>(
            `[data-session-id="${CSS.escape(pendingBlockedScrollId)}"]`
        )
        if (!row) {
            // Usually "not mounted yet": clearing a filter or expanding the
            // section re-renders and this effect runs again with the row in
            // place. If the session stopped being blocked meanwhile, drop the
            // request so it cannot wedge later jumps.
            if (!blockedSessions.some((session) => session.id === pendingBlockedScrollId)) {
                setPendingBlockedScrollId(null)
            }
            return
        }
        row.scrollIntoView({ block: 'center', behavior: 'smooth' })
        setFlashBlockedSessionId(pendingBlockedScrollId)
        setPendingBlockedScrollId(null)
        // The exemption is NOT dropped here. Releasing it the moment the
        // smooth scroll starts unmounts the row mid-travel, so the operator
        // arrives at nothing. It is released when the flash ends, which is
        // long enough to see and act on the row.
    }, [pendingBlockedScrollId, blockedSessions, blockedSectionSessions, blockedSectionCollapsed, machineFilteredSessions])

    useEffect(() => {
        if (!flashBlockedSessionId) return
        const timer = setTimeout(() => {
            setFlashBlockedSessionId(null)
            // Only drop the exemption if no dialog is open against that row.
            // Expiring it underneath an open Mark-unblocked dialog unmounted
            // the row mid-entry and took the dialog with it. The effect above
            // releases it once that dialog closes.
            if (blockedDialogSessionId === null) {
                setRevealBlockedSessionId(null)
            }
        }, 2000)
        return () => clearTimeout(timer)
    }, [flashBlockedSessionId, blockedDialogSessionId])

    // Direction hint for the pill: which way the operator would have to scroll
    // to reach blocked rows that are not currently on screen.
    useEffect(() => {
        const container = scrollContainerRef.current
        if (!container || blockedCount === 0) {
            // Functional + bail-out. A fresh `{above:0,below:0}` here would be a
            // new identity every run, and this effect's deps churn on each
            // render (the `machineLabelsById = {}` prop default cascades
            // through the filter memos) — so an unconditional set becomes an
            // infinite render loop.
            setBlockedOffscreen((previous) => (
                previous.above === 0 && previous.below === 0
                    ? previous
                    : { above: 0, below: 0 }
            ))
            return
        }
        let frame = 0
        const measure = () => {
            frame = 0
            const bounds = container.getBoundingClientRect()
            const rows = container.querySelectorAll<HTMLElement>('[data-session-blocked]')
            let above = 0
            let below = 0
            rows.forEach((row) => {
                const rect = row.getBoundingClientRect()
                // A collapsed section keeps its rows in the DOM (the panel
                // animates `grid-template-rows: 0fr` rather than unmounting).
                // Read the panel's open state rather than the row's height:
                // the collapse is a 250ms transition, so a height check taken
                // on the frame the operator clicks still measures full-size
                // rows and would report them as visible.
                const panel = row.closest('.collapsible-panel')
                const inClosedPanel = panel !== null && !panel.hasAttribute('data-open')
                const onScreen = !inClosedPanel
                    && rect.height > 0
                    && rect.bottom > bounds.top
                    && rect.top < bounds.bottom
                if (onScreen) return
                if (rect.bottom <= bounds.top) above += 1
                else below += 1
            })
            // Rows an active filter excluded are not in the DOM at all. They
            // are not literally below the fold, but they are off-screen and
            // the pill's click reveals them — so they count toward "there is
            // more that way" rather than being dropped from the hint.
            const unmounted = Math.max(0, blockedCount - rows.length)
            const nextBelow = below + unmounted
            // Bail when nothing moved: this runs every scroll frame, and a
            // fresh object each time would re-render every row in the list.
            setBlockedOffscreen((previous) => (
                previous.above === above && previous.below === nextBelow
                    ? previous
                    : { above, below: nextBelow }
            ))
        }
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(measure)
        }
        schedule()
        container.addEventListener('scroll', schedule, { passive: true })
        window.addEventListener('resize', schedule)
        return () => {
            if (frame) cancelAnimationFrame(frame)
            container.removeEventListener('scroll', schedule)
            window.removeEventListener('resize', schedule)
        }
    }, [blockedCount, blockedSectionSessions, blockedSectionCollapsed, pinnedSectionCollapsed, machineFilteredSessions])

    const blockedDirection: BlockedJumpDirection = blockedOffscreen.above > 0 && blockedOffscreen.below > 0
        ? 'both'
        : blockedOffscreen.above > 0
            ? 'up'
            : blockedOffscreen.below > 0
                ? 'down'
                : 'none'

    return (
        <div ref={sessionListRef} className="flex min-h-0 w-full flex-1 flex-col">
            <div className="session-list-scrollbar-offset mx-auto w-full max-w-content shrink-0">
            {showHeaderRow ? (
                // One toolbar row always. Never flex-wrap: wrapping burned a whole
                // line on Quest when the icon slab did not fit beside search
                // (tiann/hapi#2039). Secondary chrome sheds via container query
                // instead of taking a second row.
                <div
                    ref={headerRowRef}
                    data-testid="session-list-header-row"
                    className="@container flex min-w-0 w-full flex-nowrap items-center gap-1 px-2 py-1"
                >
                    {showSearch ? (
                        <SessionListSearch
                            value={searchQuery}
                            onChange={setSearchQuery}
                            expanded={searchExpanded}
                            onExpandedChange={setSearchExpanded}
                            customStart={customStart}
                            customEnd={customEnd}
                            sessionActivityDates={sessionActivityDates}
                            onDateRangeChange={(start, end) => {
                                setCustomStart(start)
                                setCustomEnd(end)
                            }}
                            showDateFilter={false}
                            searchMode={searchMode}
                            onSearchModeChange={setSearchMode}
                            searchMatchMode={searchMatchMode}
                            onSearchMatchModeChange={setSearchMatchMode}
                            chromeMinPx={searchQuery.length > 0 ? searchChromePx : 0}
                            maxWidthPx={searchQuery.length > 0 ? searchMaxPx : 0}
                        />
                    ) : null}
                    {!(showSearch && searchExpanded) ? (
                        <div
                            ref={setHeaderActionsNode}
                            data-testid="session-list-header-actions"
                            // flex-1 min-w-0: the box is the row's leftover after search
                            // chrome, not the width of whatever icons are already
                            // showing. shrink-0 made that leftover follow the
                            // cluster and search overlapped (#2040).
                            className="relative flex min-w-0 flex-1 flex-nowrap items-center gap-1"
                        >
                            {(() => {
                                // Shed one control at a time, highest keep first.
                                // Do not ml-auto a lone ⋯ across empty space, and do
                                // not fold the whole row at a single width gate (#2039).
                                // The blocked pill + lens sit in this row but are not
                                // shed-able slots, so their width has to come off the
                                // budget too or the shedder over-fills the row.
                                const blockedAndGap = toolbarChrome.blockedPx > 0
                                    ? toolbarChrome.blockedPx + toolbarChrome.gapPx
                                    : 0
                                // Prefer the flex allocation. It tracks the row, not the
                                // icons already on it. If they all fit, More is empty.
                                const allocated = headerActionsRef.current?.clientWidth ?? 0
                                const gutter = allocated > 0
                                    ? allocated
                                    : headerRowWidth > 0
                                        ? headerRowWidth
                                        : 0
                                const budget = gutter > 0
                                    ? Math.max(0, gutter - blockedAndGap)
                                    : toolbarActionBudget(0, searchQuery.length > 0)
                                const slotWidth = (id: string, fallback: number) => {
                                    const measured = toolbarSlotWidths[id] ?? 0
                                    return measured > 0 ? measured : fallback
                                }
                                const definedSlots: Array<ToolbarShedSlot & { node: ReactNode }> = []
                                definedSlots.push({
                                    id: 'view',
                                    keep: 5,
                                    widthPx: slotWidth('view', TOOLBAR_ICON_PX),
                                    node: (
                                        <SessionListViewMenu
                                            view={listView}
                                            onChange={setListView}
                                            onReset={() => {
                                                setListView(DEFAULT_SESSION_LIST_VIEW)
                                                setShowScratchlistOnly(false)
                                                setShowActiveOnly(false)
                                                setShowWorkingOnly(false)
                                                setCustomStart('')
                                                setCustomEnd('')
                                                setMachineFilter(null)
                                            }}
                                            scratchlistOnly={showScratchlistOnly}
                                            onScratchlistChange={setShowScratchlistOnly}
                                            activeOnly={showActiveOnly}
                                            onActiveChange={setShowActiveOnly}
                                            workingOnly={showWorkingOnly}
                                            onWorkingChange={setShowWorkingOnly}
                                            customStart={customStart}
                                            customEnd={customEnd}
                                            sessionActivityDates={sessionActivityDates}
                                            onDateRangeChange={(start, end) => {
                                                setCustomStart(start)
                                                setCustomEnd(end)
                                            }}
                                            datePickerCenterRef={sessionListRef}
                                            machines={showMachineFilterBar ? machineFilterItems : undefined}
                                            machineFilter={activeMachineFilter}
                                            onMachineChange={setMachineFilter}
                                            totalCount={allSessions.length}
                                        />
                                    )
                                })

                                if (renderHeader) {
                                    definedSlots.push({
                                        id: 'new',
                                        keep: 4,
                                        widthPx: slotWidth('new', TOOLBAR_ICON_PX),
                                        node: (
                                            <button
                                                type="button"
                                                onClick={props.onNewSession}
                                                className="session-list-new-button flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-link)] transition-colors"
                                                title={t('sessions.new')}
                                            >
                                                <PlusIcon className="h-5 w-5" />
                                            </button>
                                        )
                                    })
                                }
                                for (const extra of props.toolbarExtras ?? []) {
                                    definedSlots.push({
                                        id: extra.id,
                                        keep: extra.keep,
                                        widthPx: slotWidth(extra.id, extra.widthPx ?? TOOLBAR_ICON_PX),
                                        node: extra.node
                                    })
                                }
                                if (props.headerActions) {
                                    definedSlots.push({
                                        id: 'header-actions',
                                        keep: 6,
                                        widthPx: slotWidth('header-actions', TOOLBAR_ICON_PX),
                                        node: props.headerActions
                                    })
                                }
                                // Conditional, so it goes last: appearing or clearing
                                // it never shifts the controls before it.
                                if (unreadSessionCount > 0) {
                                    definedSlots.push({
                                        id: 'mark-all',
                                        keep: 7,
                                        widthPx: slotWidth('mark-all', TOOLBAR_ICON_PX),
                                        node: (
                                            <button
                                                type="button"
                                                onClick={() => setMarkAllReadOpen(true)}
                                                title={t('sessions.markAllRead.button', { count: unreadSessionCount })}
                                                aria-label={t('sessions.markAllRead.button', { count: unreadSessionCount })}
                                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                            >
                                                <MarkAllReadIcon className="h-5 w-5" />
                                            </button>
                                        )
                                    })
                                }
                                const { visibleIds, overflowIds } = shedToolbarSlots(definedSlots, budget, {
                                    morePx: toolbarChrome.morePx,
                                    gapPx: toolbarChrome.gapPx
                                })
                                const byId = new Map(definedSlots.map((slot) => [slot.id, slot]))
                                const visible = visibleIds.map((id) => byId.get(id)).filter((slot) => slot != null)
                                const overflow = overflowIds.map((id) => byId.get(id)).filter((slot) => slot != null)
                                return (
                                    <>
                                        <div
                                            ref={toolbarMeasureRef}
                                            aria-hidden
                                            inert
                                            className="pointer-events-none absolute left-0 top-0 -z-10 flex h-0 w-max gap-1 overflow-hidden opacity-0"
                                        >
                                            {definedSlots.map((slot) => (
                                                <span key={slot.id} data-measure-id={slot.id} className="inline-flex shrink-0">
                                                    {slot.node}
                                                </span>
                                            ))}
                                            <span data-measure-id="__more" className="inline-flex h-9 w-9 shrink-0" />
                                        </div>
                                        {/* One measured box so `blockedPx` can be subtracted from
                                            the shed budget below. These controls live in the
                                            actions row but outside `definedSlots`, so without
                                            reserving their width the shedder keeps icons inline
                                            that no longer fit and the row overflows (#2039). */}
                                        {blockedCount > 0 || showBlockedOnly ? (
                                            <div
                                                ref={blockedControlsRef}
                                                data-testid="blocked-toolbar-controls"
                                                className="flex shrink-0 items-center gap-1"
                                            >
                                                {blockedCount > 0 ? (
                                                    <BlockedJumpPill
                                                        count={blockedCount}
                                                        direction={blockedDirection}
                                                        alerting={blockedAlerting}
                                                        onJump={jumpToNextBlocked}
                                                    />
                                                ) : null}
                                                {/* Survives `blockedCount` reaching zero while the
                                                    lens is on. Dropping it there would leave the
                                                    list filtered to blocked-only with every row
                                                    hidden and no control left to turn it off. */}
                                                <BlockedLensToggle
                                                    active={showBlockedOnly}
                                                    count={blockedCount}
                                                    onToggle={() => setShowBlockedOnly((value) => !value)}
                                                />
                                            </div>
                                        ) : null}
                                        {visible.map((slot) => (
                                            <span key={slot.id} data-testid={`session-toolbar-slot-${slot.id}`} className="contents">
                                                {slot.node}
                                            </span>
                                        ))}
                                        {overflow.length > 0 ? (
                                            <SessionListHeaderOverflow>
                                                {overflow.map((slot) => (
                                                    <span key={slot.id} data-testid={`session-toolbar-slot-${slot.id}`} className="contents">
                                                        {slot.node}
                                                    </span>
                                                ))}
                                            </SessionListHeaderOverflow>
                                        ) : null}
                                    </>
                                )
                            })()}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {showMachineFilterBar ? (
                <MachineFilterBar
                    machines={machineFilterItems}
                    totalCount={allSessions.length}
                    value={activeMachineFilter}
                    onChange={setMachineFilter}
                />
            ) : singleMachineItem ? (
                <MachineSummaryRow machine={singleMachineItem} />
            ) : null}
            </div>

            <div className="relative flex min-h-0 flex-1 flex-col">
            {isRefreshing || pullState !== 'idle' || props.isLoading ? (
                <div
                    role="status"
                    aria-live="polite"
                    className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 px-2.5 py-1 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur"
                >
                    {isRefreshing || props.isLoading
                        ? <Spinner size="sm" label={null} className="text-current" />
                        : <PullRefreshIcon rotation={getPullRefreshIndicatorRotation(pullState)} />}
                    <span>
                        {isRefreshing
                            ? t('sessions.refresh.refreshing')
                            : props.isLoading
                                ? t('misc.loading')
                                : pullState === 'ready'
                                    ? t('sessions.refresh.release')
                                    : t('sessions.refresh.pull')}
                    </span>
                </div>
            ) : null}
            <div ref={scrollContainerRef} className="app-scroll-y session-list-scrollbar-left scrollbar-auto-hide min-h-0 flex-1">
            <QuickUnpinFocusContext.Provider value={quickUnpinFocusRef}>
            <BlockedDialogHoldContext.Provider value={holdBlockedDialog}>
            <SessionListScrollAnchor sessions={props.sessions} className="mx-auto flex w-full max-w-content flex-col gap-1 pl-1.5 pr-2 pb-2">
                {props.sessions.length === 0 && !props.isLoading ? (
                    <SessionsEmptyState
                        onNewSession={props.onNewSession}
                        onBrowse={props.onBrowse}
                    />
                ) : null}

                {props.sessions.length > 0 && isScratchlistStatusLoading && showScratchlistOnly ? (
                    <div role="status" className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('sessions.filter.loading')}
                    </div>
                ) : null}

                {props.sessions.length > 0 && scratchlistStatusError && showScratchlistOnly ? (
                    <div role="alert" className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('sessions.filter.error')}
                        <button
                            type="button"
                            onClick={() => { void refetchScratchlistSessionIds() }}
                            className="rounded-md px-2 py-1 text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            {t('sessions.filter.retry')}
                        </button>
                    </div>
                ) : null}

                {props.sessions.length > 0 && contentSearchLoading ? (
                    <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('sessions.search.content.loading')}
                    </div>
                ) : null}

                {props.sessions.length > 0 && contentSearchError ? (
                    <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('sessions.search.content.error')}
                    </div>
                ) : null}

                {props.sessions.length > 0 && contentSearchHasIncompleteResults ? (
                    <div
                        role="status"
                        aria-live="polite"
                        className="mx-2 my-1 flex items-start gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-2 text-xs text-[var(--app-hint)]"
                    >
                        <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            {contentSearchResponse?.results.length
                                ? t('sessions.search.content.incomplete')
                                : t('sessions.search.content.noResultsIncomplete')}
                        </span>
                    </div>
                ) : null}

                {props.sessions.length > 0 && !contentSearchLoading && !contentSearchError && !contentSearchHasIncompleteResults && !isScratchlistStatusLoading && !scratchlistStatusError && (isFiltering || activeMachineFilter !== null || listView.status !== 'all' || listView.unreadOnly || showBlockedOnly) && groups.length === 0 && runningSessionTotal === 0 && globalPinnedSessions.length === 0 && blockedSectionSessions.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {contentSearchActive
                            ? contentSearchReady
                                ? contentSearchResponse?.hasPotentiallyIncompleteResults
                                    ? t('sessions.search.content.noResultsIncomplete')
                                    : t('sessions.search.content.noResults')
                                : t('sessions.search.content.minQuery')
                            : t('sessions.search.noResults')}
                    </div>
                ) : null}

                {globalPinnedSessions.length > 0 ? (
                    <div key="pinned-section">
                        <div
                            className="group/pinned flex min-w-0 w-full select-none cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-2 pr-2 transition-colors hover:bg-[var(--app-secondary-bg)]"
                            role="button"
                            tabIndex={0}
                            aria-expanded={!pinnedSectionCollapsed || isFiltering}
                            onClick={() => setPinnedSectionCollapsed((value) => !value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    setPinnedSectionCollapsed((value) => !value)
                                }
                            }}
                            title={t('sessions.pinnedSection')}
                        >
                            <ChevronIcon className="h-3.5 w-3.5 text-[var(--app-hint)] shrink-0" collapsed={pinnedSectionCollapsed && !isFiltering} />
                            <span className="inline-flex min-w-0 items-center gap-1">
                                <span className="min-w-0 truncate text-sm font-medium">
                                    {t('sessions.pinnedSection')}
                                </span>
                                <PinnedSectionIcon className="h-3.5 w-3.5 shrink-0 -translate-y-px text-[var(--app-hint)]" />
                            </span>
                            <span className="min-w-0 flex-1" aria-hidden="true" />
                            <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                                ({globalPinnedSessions.length})
                            </span>
                        </div>
                        <CollapsiblePanel open={!pinnedSectionCollapsed || isFiltering}>
                                <div className="flex flex-col gap-0.5 ml-3 pl-1 py-1">
                                    {globalPinnedSessions.map((s) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            showPath={false}
                                            api={api}
                                            features={features}
                                            prNowMs={prNowMs}
                                            titleSuggestionAvailable={titleSuggestionAvailable}
                                            selected={s.id === selectedSessionId}
                                            showDetailedStatus={showDetailedStatus}
                                            inRunningSection
                                            projectLabel={getSessionProjectLabel(getSessionProjectPath(s.metadata) ?? 'Other')}
                                            machineLabel={showMachineFilterBar && activeMachineFilter === null
                                                ? resolveMachineLabel(s.metadata?.machineId ?? null)
                                                : undefined}
                                            contentSnippet={contentSnippetBySessionId.get(s.id)}
                                            contentSearchTruncated={contentSearchTruncatedBySessionId.has(s.id)}
                                            targetMessageId={contentTargetMessageIdBySessionId.get(s.id)}
                                            targetMessageQuery={contentSearchActive ? normalizedQuery : undefined}
                                            lastSeenVersion={lastSeenVersion}
                                            flashHighlight={s.id === flashBlockedSessionId}
                                        />
                                    ))}
                                </div>
                        </CollapsiblePanel>
                    </div>
                ) : null}

                {blockedSectionSessions.length > 0 ? (
                    <div key="blocked-section" data-testid="blocked-section">
                        <div
                            className="group/blocked flex min-w-0 w-full select-none cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-2 pr-2 transition-colors hover:bg-[var(--app-secondary-bg)]"
                            role="button"
                            tabIndex={0}
                            aria-expanded={!blockedSectionCollapsed || isFiltering}
                            onClick={() => setBlockedSectionCollapsed((value) => !value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    setBlockedSectionCollapsed((value) => !value)
                                }
                            }}
                            title={t('sessions.blockedSection')}
                        >
                            <ChevronIcon className="h-3.5 w-3.5 text-[var(--app-hint)] shrink-0" collapsed={blockedSectionCollapsed && !isFiltering} />
                            <span className="inline-flex min-w-0 items-center gap-1 text-[var(--app-badge-warning-text)]">
                                <BlockedFlagIcon className="h-3.5 w-3.5 shrink-0" />
                                <span className="min-w-0 truncate text-sm font-medium">
                                    {t('sessions.blockedSection')}
                                </span>
                            </span>
                            <span className="min-w-0 flex-1" aria-hidden="true" />
                            <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                                ({blockedSectionSessions.length})
                            </span>
                        </div>
                        {/* CollapsiblePanel unmounts its children once the close
                            transition settles. The raw panel markup kept the row
                            buttons mounted and focusable, so a keyboard user tabbing
                            out of a collapsed header landed on invisible rows — one
                            dead tab stop per blocker. */}
                        <CollapsiblePanel open={!blockedSectionCollapsed || isFiltering}>
                                <div className="flex flex-col gap-0.5 ml-3 pl-1 py-1">
                                    {blockedSectionSessions.map((s) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            showPath={false}
                                            api={api}
                                            features={features}
                                            prNowMs={prNowMs}
                                            titleSuggestionAvailable={titleSuggestionAvailable}
                                            selected={s.id === selectedSessionId}
                                            showDetailedStatus={showDetailedStatus}
                                            inRunningSection
                                            projectLabel={getSessionProjectLabel(s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other')}
                                            machineLabel={resolveMachineLabel(s.metadata?.machineId ?? null)}
                                            lastSeenVersion={lastSeenVersion}
                                            flashHighlight={s.id === flashBlockedSessionId}
                                            // Blocked rows float out of their directory group during
                                            // a content search too, so they need the same search
                                            // payload as every other path — without it the match
                                            // preview disappears and the click opens the
                                            // conversation instead of the matching message.
                                            contentSnippet={contentSnippetBySessionId.get(s.id)}
                                            contentSearchTruncated={contentSearchTruncatedBySessionId.has(s.id)}
                                            targetMessageId={contentTargetMessageIdBySessionId.get(s.id)}
                                            targetMessageQuery={contentSearchActive ? normalizedQuery : undefined}
                                        />
                                    ))}
                                </div>
                        </CollapsiblePanel>
                    </div>
                ) : null}

                {renderPinnedSection({
                    sectionKey: 'running-section',
                    titleKey: 'sessions.runningSection',
                    collapsed: runningSectionCollapsed,
                    onToggle: () => setRunningSectionCollapsed((value) => !value),
                    pulse: true,
                    count: runningSessionTotal,
                    bucketKeys: ['jobs', 'working', 'pending'],
                })}
                {groups.map(renderDirectoryGroup)}
                {actionOnlyGroups.map(renderActionOnlyGroupHeader)}
            </SessionListScrollAnchor>
            </BlockedDialogHoldContext.Provider>
            </QuickUnpinFocusContext.Provider>
            </div>
            {openSessionTickRatio != null ? (
                <span
                    className="session-list-open-tick"
                    style={{ top: `${openSessionTickRatio * 100}%` }}
                    title={t('sessions.openTick.tooltip')}
                    aria-hidden="true"
                />
            ) : null}
            </div>
            <ConfirmDialog
                isOpen={markAllReadOpen}
                onClose={() => setMarkAllReadOpen(false)}
                title={t('sessions.markAllRead.title')}
                description={t('sessions.markAllRead.description', { count: unreadSessionCount })}
                confirmLabel={t('sessions.markAllRead.confirm')}
                confirmingLabel={t('sessions.markAllRead.confirming')}
                onConfirm={async () => {
                    markAllSessionsSeen(readableSessions)
                }}
                isPending={false}
                centerTitle
                destructive
            />
        </div>
    )
}
