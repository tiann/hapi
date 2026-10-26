import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { SessionListScrollAnchor } from './SessionListScrollAnchor'
import type { SessionSummary } from '@/types/api'
import { SESSION_LIFECYCLE_IDLE } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import {
    buildSessionSearchScoreIndex,
    compareSessionsBySearchRelevance,
    rankSessionGroupsBySearchRelevance,
    sessionMatchesQuery,
    sortSessionsBySearchRelevance,
} from '@/lib/sessionListSearch'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CopyIcon, CheckIcon, MarkAllReadIcon } from '@/components/icons'

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
import { useShowActiveSessionsOnly } from '@/hooks/useShowActiveSessionsOnly'
import { usePinInProgressSessions } from '@/hooks/usePinInProgressSessions'
import { useFixedSessionOrder } from '@/hooks/useFixedSessionOrder'
import {
    compareDescWithKeyTiebreak,
    compareSessionsByOrderKeyDesc,
    getSessionOrderKey
} from '@/lib/sessionOrder'
import { classifySessionAttention, sessionIsUnread } from '@/lib/sessionAttention'
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
import { retargetSharePendingTransfer } from '@/lib/sharePendingState'
import type { Machine } from '@/types/api'
import { getMachinePlatform, presentMachineHealth } from '@/lib/machineHealth'
import { MachineFilterBar, MachineFilterMenu } from '@/components/MachineFilterBar'
import { useSessionListMachineFilter } from '@/hooks/useSessionListMachineFilter'
import { useTransientScrollbar } from '@/hooks/useTransientScrollbar'
import { useCursorChatStoreStatus } from '@/hooks/queries/useCursorChatStoreStatus'
import { SessionRowSummary } from '@/components/SessionRowSummary'
import { Spinner } from '@/components/Spinner'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { useToast } from '@/lib/toast-context'
import { getPathDisplayName } from '@/utils/path'
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
    latestUpdatedAt: number
    /** Newest creation-time key in the group. Drives the fixed-order group
     *  sort: a group only moves when a NEW session is created inside it. */
    latestCreatedAt: number
    hasActiveSession: boolean
    hasPinnedSession: boolean
}

const RUNNING_BUCKETS = [
    { key: 'working', labelKey: 'session.item.running', colorClass: 'text-[var(--app-badge-success-text)]', pulse: true },
    { key: 'pending', labelKey: 'session.item.pending', colorClass: 'text-[var(--app-badge-warning-text)]', pulse: true },
    { key: 'active', labelKey: 'session.item.active', colorClass: 'text-[var(--app-hint)]', pulse: false },
    // tiann/hapi#1820: connected, but the hub has seen nothing except
    // keepalives for the configured window. Split out so a fleet of zombies
    // does not read as a fleet of ready sessions.
    { key: 'idle', labelKey: 'session.item.idle', colorClass: 'text-[var(--app-hint)]', pulse: false },
] as const

type RunningBucketKey = (typeof RUNNING_BUCKETS)[number]['key']

export function emptyRunningBuckets(): Record<RunningBucketKey, SessionSummary[]> {
    return { working: [], pending: [], active: [], idle: [] }
}

/**
 * Split the connected sessions into the in-progress / active sub-buckets the
 * pinned sections render. Pure so the bucketing rules stay testable.
 */
export function bucketRunningSessions(
    sessions: SessionSummary[],
    pinInProgressSessions: boolean,
    compare: (a: SessionSummary, b: SessionSummary) => number = (a, b) => b.updatedAt - a.updatedAt
): Record<RunningBucketKey, SessionSummary[]> {
    const buckets = emptyRunningBuckets()
    if (!pinInProgressSessions) {
        return buckets
    }
    for (const session of sessions) {
        if (session.globalPinned || session.pinned) {
            continue
        }
        if (!session.active) {
            continue
        }
        if (session.thinking || (session.backgroundTaskCount ?? 0) > 0) {
            buckets.working.push(session)
        } else if ((session.pendingRequestsCount ?? 0) > 0) {
            buckets.pending.push(session)
        } else if (session.metadata?.lifecycleState === SESSION_LIFECYCLE_IDLE) {
            // Keepalive-only: socket up, no agent progress for hours.
            buckets.idle.push(session)
        } else {
            // Quiet but connected: finished executing, operator will continue.
            buckets.active.push(session)
        }
    }
    for (const key of Object.keys(buckets) as RunningBucketKey[]) {
        buckets[key].sort(compare)
    }
    return buckets
}

/**
 * Sessions that warrant the optional pinned top sections.
 * Any connected session floats — a session that just finished executing stays
 * visible at the top (Active tier) because the operator usually continues the
 * conversation; only disconnected sessions fall into directory groups.
 */
function isPinnedInProgressSession(session: SessionSummary): boolean {
    return session.active
}

export type SessionTimeRange = {
    start: number | null
    end: number | null
}

function parseLocalDate(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
    return date
}

export function getSessionTimeRange(start: string, end: string): SessionTimeRange | null {
    const startDate = parseLocalDate(start)
    const endDate = parseLocalDate(end)
    if (!startDate || !endDate) return null
    if (endDate) endDate.setDate(endDate.getDate() + 1)
    return { start: startDate.getTime(), end: endDate.getTime() }
}

export function sessionMatchesTimeRange(session: SessionSummary, range: SessionTimeRange | null): boolean {
    if (!range) return true
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
    latestUpdatedAt: number
    latestCreatedAt: number
}

export const UNKNOWN_MACHINE_ID = '__unknown__'
export const GROUP_SESSION_PREVIEW_LIMIT = DEFAULT_SESSION_PREVIEW_LIMIT

export function getSessionDedupKey(session: SessionSummary): string | null {
    const agentId = session.metadata?.agentSessionId?.trim()
    if (!agentId) return null
    // Scope by flavor: agentSessionId is flattened from native ids and can retain a
    // stale cross-flavor value (codexSessionId ?? claudeSessionId ?? ...).
    return `${session.metadata?.flavor ?? 'unknown'}:${agentId}`
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
        result.push(group[0])
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
    if (session.active || session.pinned || session.globalPinned) return true
    return !isSidebarEmptySessionStub(session)
}

export function prepareSidebarSessions(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return deduplicateSessionsByAgentId(sessions, selectedSessionId)
        .filter(session => shouldShowSessionInSidebar(session, selectedSessionId))
}

// "Active sessions only" view: hide inactive sessions, but never hide the one the
// operator currently has open — otherwise toggling the filter would yank the
// selected session out from under them.
export function filterActiveSessionsOnly(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return sessions.filter(session => session.active || session.id === selectedSessionId)
}

// Transient unread lens: hide sessions the operator has already seen.
// Keep the open session visible. Not Overseer / "needs attention" — just unread.
export function filterUnreadSessionsOnly(
    sessions: SessionSummary[],
    selectedSessionId: string | null | undefined,
    getLastSeenAt: (sessionId: string) => number
): SessionSummary[] {
    return sessions.filter(session =>
        session.id === selectedSessionId
        || sessionIsUnread(session, { lastSeenAt: getLastSeenAt(session.id) })
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

// Exported for tests. `fixedOrder` ("固定会话顺序") freezes the list:
// sessions sort by creation time only (manual pins still float) and groups
// sort by their newest creation time — updates and activity never move
// anything, a group only moves when a new session is created inside it.
export function groupSessionsByDirectory(sessions: SessionSummary[], fixedOrder = false): SessionGroup[] {
    const groups = new Map<string, { directory: string; machineId: string | null; sessions: SessionSummary[] }>()

    sessions.forEach(session => {
        const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
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
                if (fixedOrder) {
                    return compareSessionsByOrderKeyDesc(a, b)
                }
                const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
                const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = group.sessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const latestCreatedAt = group.sessions.reduce(
                (max, s) => Math.max(max, getSessionOrderKey(s)),
                -Infinity
            )
            const hasActiveSession = group.sessions.some(s => s.active)
            const hasPinnedSession = group.sessions.some(s => s.pinned)
            const displayName = getPathDisplayName(group.directory)

            return {
                key,
                directory: group.directory,
                displayName,
                machineId: group.machineId,
                sessions: sortedSessions,
                latestUpdatedAt,
                latestCreatedAt,
                hasActiveSession,
                hasPinnedSession
            }
        })
        .sort((a, b) => {
            if (a.hasPinnedSession !== b.hasPinnedSession) {
                return a.hasPinnedSession ? -1 : 1
            }
            if (fixedOrder) {
                return compareDescWithKeyTiebreak(
                    { key: a.key, order: a.latestCreatedAt },
                    { key: b.key, order: b.latestCreatedAt }
                )
            }
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
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
    resolveMachineLabel: (id: string | null) => string,
    fixedOrder = false
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
                latestUpdatedAt: 0,
                latestCreatedAt: -Infinity,
            }
            map.set(key, mg)
        }
        mg.projectGroups.push(g)
        mg.totalSessions += g.sessions.length
        if (g.hasActiveSession) mg.hasActiveSession = true
        if (g.hasPinnedSession) mg.hasPinnedSession = true
        if (g.latestUpdatedAt > mg.latestUpdatedAt) mg.latestUpdatedAt = g.latestUpdatedAt
        if (g.latestCreatedAt > mg.latestCreatedAt) mg.latestCreatedAt = g.latestCreatedAt
    }
    return [...map.values()].sort((a, b) => {
        if (a.hasPinnedSession !== b.hasPinnedSession) return a.hasPinnedSession ? -1 : 1
        if (fixedOrder) {
            return compareDescWithKeyTiebreak(
                { key: a.machineId ?? UNKNOWN_MACHINE_ID, order: a.latestCreatedAt },
                { key: b.machineId ?? UNKNOWN_MACHINE_ID, order: b.latestCreatedAt }
            )
        }
        if (a.hasActiveSession !== b.hasActiveSession) return a.hasActiveSession ? -1 : 1
        return b.latestUpdatedAt - a.latestUpdatedAt
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


export function getVisibleSessionPreview(
    sessions: SessionSummary[],
    options: {
        expanded?: boolean
        selectedSessionId?: string | null
        limit?: number
    } = {}
): SessionSummary[] {
    const limit = options.limit ?? GROUP_SESSION_PREVIEW_LIMIT
    if (options.expanded || sessions.length <= limit) return sessions

    const requiredIds = new Set<string>()
    for (const session of sessions) {
        if (session.active && session.pendingRequestsCount > 0) requiredIds.add(session.id)
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

function CalendarIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 10h18" />
        </svg>
    )
}

function formatDateValue(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function SessionDateRangePicker(props: {
    start: string
    end: string
    sessionActivityDates: ReadonlySet<string>
    onChange: (start: string, end: string) => void
    onClear: () => void
    onClose: () => void
    align: 'left' | 'right'
}) {
    const { t } = useTranslation()
    const initialDate = parseLocalDate(props.start) ?? new Date()
    const [visibleMonth, setVisibleMonth] = useState(() => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1))
    const today = formatDateValue(new Date())
    const firstWeekday = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1).getDay()
    const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate()
    const weekdays = Array.from({ length: 7 }, (_, day) => (
        new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2026, 5, 7 + day))
    ))

    const selectDate = (value: string) => {
        if (!props.start || props.end) {
            props.onChange(value, '')
            return
        }
        props.onChange(value < props.start ? value : props.start, value < props.start ? props.start : value)
        props.onClose()
    }

    return (
        <div className={cn(
            'absolute top-full z-30 mt-2 w-72 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-xl',
            props.align === 'left' ? 'left-0' : 'right-0'
        )}>
            <div className="mb-2 flex items-center justify-between">
                <button
                    type="button"
                    onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))}
                    className="rounded-lg p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('sessions.timeFilter.previousMonth')}
                >
                    <span aria-hidden="true">‹</span>
                </button>
                <div className="text-sm font-medium">
                    {visibleMonth.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
                </div>
                <button
                    type="button"
                    onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))}
                    className="rounded-lg p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('sessions.timeFilter.nextMonth')}
                >
                    <span aria-hidden="true">›</span>
                </button>
            </div>
            <div className="mb-1 grid grid-cols-7 text-center text-[10px] text-[var(--app-hint)]">
                {weekdays.map((weekday, index) => <div key={`${weekday}-${index}`} className="py-1">{weekday}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
                {Array.from({ length: firstWeekday }, (_, index) => <div key={`blank-${index}`} />)}
                {Array.from({ length: daysInMonth }, (_, index) => {
                    const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), index + 1)
                    const value = formatDateValue(date)
                    const isToday = value === today
                    const isEndpoint = value === props.start || value === props.end
                    const isInRange = Boolean(props.start && props.end && value > props.start && value < props.end)
                    const hasSessionActivity = props.sessionActivityDates.has(value)
                    const dateLabel = date.toLocaleDateString()
                    const activityLabel = hasSessionActivity
                        ? t('sessions.timeFilter.dayWithActivity', { date: dateLabel })
                        : dateLabel
                    return (
                        <button
                            key={value}
                            type="button"
                            onClick={() => selectDate(value)}
                            aria-label={activityLabel}
                            aria-current={isToday ? 'date' : undefined}
                            title={hasSessionActivity ? activityLabel : undefined}
                            className={cn(
                                'h-8 rounded-lg text-xs transition-colors',
                                isEndpoint && 'bg-[var(--app-button)] text-[var(--app-button-text)]',
                                isInRange && 'bg-[var(--app-link)]/15 text-[var(--app-link)]',
                                !isEndpoint && !isInRange && isToday && 'bg-[var(--app-subtle-bg)]',
                                !isEndpoint && !isInRange && hasSessionActivity && 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]',
                                !isEndpoint && !isInRange && !hasSessionActivity && 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
                            )}
                        >
                            {index + 1}
                        </button>
                    )
                })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-[var(--app-divider)] pt-2 text-xs">
                <span className="text-[var(--app-hint)]">
                    {!props.start
                        ? t('sessions.timeFilter.pickStart')
                        : !props.end
                            ? t('sessions.timeFilter.pickEnd')
                            : `${props.start} – ${props.end}`}
                </span>
                {props.start ? (
                    <button type="button" onClick={props.onClear} className="text-[var(--app-link)]">
                        {t('sessions.timeFilter.clear')}
                    </button>
                ) : null}
            </div>
        </div>
    )
}

export function SessionListSearch(props: {
    value: string
    onChange: (value: string) => void
    customStart: string
    customEnd: string
    sessionActivityDates: ReadonlySet<string>
    onDateRangeChange: (start: string, end: string) => void
    expanded: boolean
    onExpandedChange: (expanded: boolean) => void
    /** Minimum width of icon + clear + calendar. Query text may shrink; these may not. */
    chromeMinPx?: number
    /**
     * Caps the collapsed query group so machine menu + More stay in the row.
     * The 9rem chip is a ceiling, not a reservation (#2040).
     */
    maxWidthPx?: number
}) {
    const { t } = useTranslation()
    const [datePickerOpen, setDatePickerOpen] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const collapsedButtonRef = useRef<HTMLButtonElement>(null)
    const dateButtonRef = useRef<HTMLButtonElement>(null)
    const hasDateRange = Boolean(props.customStart && props.customEnd)

    useEffect(() => {
        if (props.expanded) {
            inputRef.current?.focus()
        } else {
            setDatePickerOpen(false)
        }
    }, [props.expanded])

    const returnDateFocus = () => {
        if (props.expanded) {
            inputRef.current?.focus()
            return
        }
        dateButtonRef.current?.focus()
    }

    // Layout A (#2019 / Quest): calendar sits INSIDE the expanded field,
    // immediately left of the furthest-right 48px clear end-cap. Both hit
    // targets are min 48x48 so the clear is no longer a ~14px absolute X.
    // Date button only — picker mounts on the search-group container so
    // left-0 / right-0 stay viewport-safe (not a 48px button containing block).
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
                    ? `${props.customStart} - ${props.customEnd}`
                    : t('sessions.timeFilter.label')}
                aria-label={hasDateRange
                    ? `${t('sessions.timeFilter.label')}: ${props.customStart} - ${props.customEnd}`
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
                start={props.customStart}
                end={props.customEnd}
                sessionActivityDates={props.sessionActivityDates}
                onChange={props.onDateRangeChange}
                onClear={() => {
                    props.onDateRangeChange('', '')
                    // The footer Clear button unmounts once the range is
                    // empty; return focus so it does not drop to <body>.
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

    const searchLabel = t('sessions.search.open')

    if (!props.expanded) {
        const hasTextQuery = props.value.length > 0
        const collapsedLabel = hasTextQuery ? `${searchLabel}: ${props.value}` : searchLabel
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
                    // Query text shrinks. minWidth is the icon/clear/calendar floor
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
                        <span data-toolbar-chrome="" className="inline-flex shrink-0">
                            <SearchIcon className="h-5 w-5 shrink-0" />
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
                                // The clear button unmounts with the query; keep focus on
                                // the collapsed search trigger instead of dropping to body.
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
                {renderDateButton('standalone')}
                {datePicker}
            </div>
        )
    }

    return (
        <div
            data-testid="session-list-search"
            data-expanded="true"
            className="relative min-w-0 flex-1"
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    props.onExpandedChange(false)
                }
            }}
        >
            <div className="relative flex min-h-12 min-w-0 items-stretch rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] transition-colors focus-within:border-[var(--app-link)]">
                <div className="pointer-events-none flex shrink-0 items-center pl-2.5 text-[var(--app-hint)]">
                    <SearchIcon className="h-3.5 w-3.5" />
                </div>
                <input
                    ref={inputRef}
                    type="search"
                    value={props.value}
                    onChange={(event) => props.onChange(event.target.value)}
                    placeholder={t('sessions.search.placeholder')}
                    aria-label={searchLabel}
                    title={searchLabel}
                    className="min-w-0 flex-1 appearance-none bg-transparent px-2 py-1.5 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] [text-overflow:ellipsis] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
                />
                {renderDateButton('embedded')}
                {props.value ? (
                    <button
                        type="button"
                        onClick={() => {
                            props.onChange('')
                            // The clear button unmounts with the query; keep focus off <body>
                            // so a later outside click still routes blur through the wrapper.
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
            {datePicker}
        </div>
    )
}

// A row with an open menu or dialog holds its collapsed panel mounted.
const CollapsiblePanelHoldContext = createContext<((held: boolean) => void) | null>(null)

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
                <CollapsiblePanelHoldContext.Provider value={hold}>
                    {!settled || holds > 0 ? props.children : null}
                </CollapsiblePanelHoldContext.Provider>
            </div>
        </div>
    )
}

const SessionItem = memo(function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
    api: ApiClient | null
    titleSuggestionAvailable?: boolean
    selected?: boolean
    showDetailedStatus?: boolean
    inRunningSection?: boolean
    projectLabel?: string
    machineLabel?: string
    lastSeenVersion: number
}) {
    const { t } = useTranslation()
    const { addToast } = useToast()
    const {
        session: s,
        onSelect,
        showPath = true,
        api,
        titleSuggestionAvailable = false,
        selected = false,
        showDetailedStatus = false,
        inRunningSection = false,
        projectLabel,
        machineLabel,
        lastSeenVersion
    } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
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

    const { archiveSession, reopenSession, renameSession, suggestSessionTitle, updateSessionSummary, deleteSession, setPinMode, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )
    const [reopenError, setReopenError] = useState<string | null>(null)
    const holdPanel = useContext(CollapsiblePanelHoldContext)
    const overlayOpen = menuOpen || renameOpen || exportOpen || archiveOpen || deleteOpen || reopenError !== null
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

    const handleReopen = async () => {
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
            setReopenError(formatReopenError(error))
        }
    }

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (!menuOpen) {
                onSelect(s.id)
            }
        },
        threshold: 500
    })

    const sessionName = getSessionTitle(s)
    const attention = useMemo(
        () => showDetailedStatus
            ? classifySessionAttention(s, {
                selected,
                lastSeenAt: getSessionLastSeenAt(s.id),
                manualUnreadAt: getSessionManualUnreadAt(s.id)
            })
            : null,
        [s, selected, showDetailedStatus, lastSeenVersion]
    )
    const hasScheduleTooltip = showDetailedStatus && s.futureScheduledMessageCount > 0
    const { attentionId, scheduleId, describedBy } = useSessionRowTooltipIds(
        Boolean(attention),
        hasScheduleTooltip
    )
    return (
        <>
            <button
                type="button"
                {...longPressHandlers}
                data-session-scroll-anchor
                className={`session-list-item group/session-row flex w-full flex-col gap-1 py-2 pl-2.5 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none rounded-lg ${selected ? 'bg-[var(--app-secondary-bg)]' : ''}`}
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
                    inRunningSection={inRunningSection}
                    projectLabel={projectLabel}
                    machineLabel={machineLabel}
                />
            </button>

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
                onExport={() => setExportOpen(true)}
                onMarkUnread={() => markSessionUnread(s.id, s.updatedAt)}
                onArchive={() => setArchiveOpen(true)}
                onReopen={cursorReopenDisabledReason ? undefined : handleReopen}
                reopenDisabledReason={cursorReopenDisabledReason}
                reopenHint={cursorReopenUnverifiedHint}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
            />

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
                    onRename={renameSession}
                    onSuggestTitle={api && titleSuggestionAvailable ? suggestSessionTitle : undefined}
                    onUpdateSummary={api && titleSuggestionAvailable ? updateSessionSummary : undefined}
                    isPending={isPending}
                />
            ) : null}

            {exportOpen ? (
                <SessionExportDialog
                    isOpen={true}
                    onClose={() => setExportOpen(false)}
                    sessionId={s.id}
                    api={api}
                />
            ) : null}

            {archiveOpen ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setArchiveOpen(false)}
                    title={t('dialog.archive.title')}
                    description={t('dialog.archive.description', { name: sessionName })}
                    confirmLabel={t('dialog.archive.confirm')}
                    confirmingLabel={t('dialog.archive.confirming')}
                    onConfirm={archiveSession}
                    isPending={isPending}
                    destructive
                    centerTitle
                />
            ) : null}

            {deleteOpen ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setDeleteOpen(false)}
                    title={t('dialog.delete.title')}
                    description={t('dialog.delete.description', { name: sessionName })}
                    confirmLabel={t('dialog.delete.confirm')}
                    confirmingLabel={t('dialog.delete.confirming')}
                    onConfirm={deleteSession}
                    isPending={isPending}
                    destructive
                    centerTitle
                />
            ) : null}
        </>
    )
})

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
    onSelect: (sessionId: string) => void
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
    const { sessionPreviewLimit } = useSessionPreviewLimit()
    const { sessionListStatusMode } = useSessionListStatusMode()
    const { showActiveSessionsOnly } = useShowActiveSessionsOnly()
    const lastSeenVersion = useSessionLastSeenVersion()
    // Transient unread lens — not a Settings preference. Cleared on reload; rows drop as they're seen.
    const [showUnreadOnly, setShowUnreadOnly] = useState(false)
    const { pinInProgressSessions } = usePinInProgressSessions()
    const { fixedSessionOrder } = useFixedSessionOrder()
    // "固定会话顺序": the running buckets are status-driven ordering, which
    // contradicts a frozen list — fixed order pauses the feature entirely.
    const effectivePinInProgress = pinInProgressSessions && !fixedSessionOrder
    const { machineFilter, setMachineFilter } = useSessionListMachineFilter()
    const showDetailedStatus = sessionListStatusMode === 'detailed'
    const [searchQuery, setSearchQuery] = useState('')
    const [searchExpanded, setSearchExpanded] = useState(false)
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [markAllReadOpen, setMarkAllReadOpen] = useState(false)
    // Actions-box width is the real icon budget (#2039). Measuring the full
    // row and subtracting a guessed search reserve left empty space after More.
    const headerRowRef = useRef<HTMLDivElement>(null)
    const headerActionsRef = useRef<HTMLDivElement>(null)
    const toolbarMeasureRef = useRef<HTMLDivElement>(null)
    const machineMenuRef = useRef<HTMLDivElement>(null)
    const actionsObserverRef = useRef<ResizeObserver | null>(null)
    const [headerRowWidth, setHeaderRowWidth] = useState(0)
    const [toolbarSlotWidths, setToolbarSlotWidths] = useState<Record<string, number>>({})
    const [toolbarChrome, setToolbarChrome] = useState({ morePx: TOOLBAR_MORE_PX, gapPx: TOOLBAR_GAP_PX, machinePx: 0 })
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
    const isFiltering = normalizedQuery.length > 0 || timeRange !== null

    const resolveMachineLabel = (machineId: string | null): string => {
        if (machineId && machineLabelsById[machineId]) {
            return machineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }

    const sidebarSessions = useMemo(
        () => prepareSidebarSessions(props.sessions, selectedSessionId),
        [props.sessions, selectedSessionId]
    )
    const readableSessions = useMemo(
        () => props.sessions.filter(session => shouldShowSessionInSidebar(session, selectedSessionId)),
        [props.sessions, selectedSessionId]
    )
    const allSessions = useMemo(
        () => showActiveSessionsOnly
            ? filterActiveSessionsOnly(sidebarSessions, selectedSessionId)
            : sidebarSessions,
        [sidebarSessions, selectedSessionId, showActiveSessionsOnly]
    )
    const unreadSessionCount = useMemo(
        () => getUnreadSessionCount(readableSessions),
        [lastSeenVersion, readableSessions]
    )
    const sessionActivityDates = useMemo(
        () => new Set(allSessions.map(session => formatDateValue(new Date(session.updatedAt)))),
        [allSessions]
    )
    const hasTextQuery = normalizedQuery.length > 0
    const timeScopedSessions = useMemo(
        () => timeRange === null
            ? allSessions
            : allSessions.filter(session => sessionMatchesTimeRange(session, timeRange)),
        [allSessions, timeRange?.start, timeRange?.end] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const searchScoreIndex = useMemo(
        () => hasTextQuery
            ? buildSessionSearchScoreIndex(timeScopedSessions, normalizedQuery, resolveMachineLabel)
            : null,
        [hasTextQuery, timeScopedSessions, normalizedQuery, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const visibleSessions = useMemo(
        () => {
            if (!isFiltering) return allSessions
            const matched = hasTextQuery && searchScoreIndex
                ? timeScopedSessions.filter(session => searchScoreIndex.matchedIds.has(session.id))
                : timeScopedSessions.filter(session => (
                    sessionMatchesQuery(
                        session,
                        normalizedQuery,
                        resolveMachineLabel(session.metadata?.machineId ?? null)
                    )
                ))
            if (hasTextQuery && searchScoreIndex) {
                return sortSessionsBySearchRelevance(matched, searchScoreIndex)
            }
            return matched
        },
        [allSessions, hasTextQuery, isFiltering, normalizedQuery, searchScoreIndex, timeScopedSessions, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )
    const allGroups = useMemo(
        () => groupSessionsByDirectory(allSessions, fixedSessionOrder),
        [allSessions, fixedSessionOrder]
    )
    const machineFilters = useMemo(
        () => groupByMachine(allGroups, resolveMachineLabel, fixedSessionOrder),
        [allGroups, fixedSessionOrder, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
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
    // A persisted filter whose machine no longer has sessions falls back to
    // "All"; with at most one machine the bar is hidden and never filters.
    const activeMachineFilter = showMachineFilterBar && machineFilter !== null
        && machineFilters.some(mg => (mg.machineId ?? UNKNOWN_MACHINE_ID) === machineFilter)
        ? machineFilter
        : null
    // Unread after search/time, before machine scope — so machineFilters (from allSessions)
    // stay stable. Filtering unread into allSessions would drop machines with zero unread
    // and clear a persisted machine selection (showing other machines' unread instead).
    const unreadFilteredSessions = useMemo(() => {
        if (!showUnreadOnly) return visibleSessions
        const lastSeenById = getSessionLastSeenSnapshot()
        return filterUnreadSessionsOnly(
            visibleSessions,
            selectedSessionId,
            id => lastSeenById[id] ?? 0
        )
    }, [lastSeenVersion, visibleSessions, selectedSessionId, showUnreadOnly])
    const machineFilteredSessions = useMemo(
        () => activeMachineFilter === null
            ? unreadFilteredSessions
            : unreadFilteredSessions.filter(session =>
                (session.metadata?.machineId ?? UNKNOWN_MACHINE_ID) === activeMachineFilter
            ),
        [unreadFilteredSessions, activeMachineFilter]
    )
    const globalPinnedSessions = useMemo(() => {
        const pinned = machineFilteredSessions.filter((session) => Boolean(session.globalPinned))
        if (searchScoreIndex && hasTextQuery) {
            return sortSessionsBySearchRelevance(pinned, searchScoreIndex)
        }
        if (fixedSessionOrder) {
            return [...pinned].sort(compareSessionsByOrderKeyDesc)
        }
        return [...pinned].sort((a, b) => b.updatedAt - a.updatedAt)
    }, [machineFilteredSessions, searchScoreIndex, hasTextQuery, fixedSessionOrder])
    const runningSessions = useMemo(() => {
        const byRelevanceOrRecent = (a: SessionSummary, b: SessionSummary) => {
            if (searchScoreIndex && hasTextQuery) {
                return compareSessionsBySearchRelevance(a, b, searchScoreIndex)
            }
            return b.updatedAt - a.updatedAt
        }
        return bucketRunningSessions(machineFilteredSessions, effectivePinInProgress, byRelevanceOrRecent)
    }, [machineFilteredSessions, effectivePinInProgress, searchScoreIndex, hasTextQuery])
    const runningSessionTotal = runningSessions.working.length
        + runningSessions.pending.length
    const activeSessionTotal = runningSessions.active.length + runningSessions.idle.length
    const groups = useMemo(
        () => {
            const grouped = groupSessionsByDirectory(
                machineFilteredSessions.filter((session) => {
                    if (session.globalPinned) return false
                    if (effectivePinInProgress && !session.pinned && isPinnedInProgressSession(session)) return false
                    return true
                }),
                fixedSessionOrder
            )
            if (searchScoreIndex && hasTextQuery) {
                return rankSessionGroupsBySearchRelevance(grouped, searchScoreIndex)
            }
            return grouped
        },
        [machineFilteredSessions, effectivePinInProgress, fixedSessionOrder, searchScoreIndex, hasTextQuery]
    )
    // Directory groups whose rows all floated to the pinned sections still
    // render an action-only header so copy-path / new-session-in-directory
    // stay available (no rows to group, but the project itself is live).
    // Based on the same machineFilteredSessions set as `groups` so machine /
    // unread filters stay consistent.
    const allDirectoryGroups = useMemo(
        () => groupSessionsByDirectory(
            machineFilteredSessions.filter((session) => !session.globalPinned),
            fixedSessionOrder
        ),
        [machineFilteredSessions, fixedSessionOrder]
    )
    const actionOnlyGroups = useMemo(() => {
        if (!effectivePinInProgress) {
            return []
        }
        const visibleKeys = new Set(groups.map((group) => group.key))
        return allDirectoryGroups.filter((group) => !visibleKeys.has(group.key))
    }, [groups, allDirectoryGroups, effectivePinInProgress])
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [runningSectionCollapsed, setRunningSectionCollapsed] = useState(false)
    const [activeSectionCollapsed, setActiveSectionCollapsed] = useState(false)
    const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false)
    const autoExpandedSelectedSessionKeyRef = useRef<string | null>(null)
    const isGroupCollapsed = (group: SessionGroup): boolean => {
        if (isFiltering) return false
        const override = collapseOverrides.get(group.key)
        if (override !== undefined) return override
        const hasSelectedSession = selectedSessionId
            ? group.sessions.some(session => session.id === selectedSessionId)
            : false
        return !group.hasActiveSession && !group.hasPinnedSession && !hasSelectedSession
    }

    const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }

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
                limit: currentLimit
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
                limit: getGroupVisibleCount(group)
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
                    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                        <span className={`h-1.5 w-1.5 rounded-full bg-[var(--app-badge-success-text)] ${pulse ? 'animate-pulse' : ''}`} />
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
                                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${bucket.pulse ? 'animate-pulse' : ''}`} aria-hidden="true" />
                                        {t(bucket.labelKey)} ({sessions.length})
                                    </div>
                                    {sessions.map((s) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            showPath={false}
                                            api={api}
                                            titleSuggestionAvailable={titleSuggestionAvailable}
                                            selected={s.id === selectedSessionId}
                                            showDetailedStatus={showDetailedStatus}
                                            inRunningSection
                                            projectLabel={getPathDisplayName(s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other')}
                                            machineLabel={resolveMachineLabel(s.metadata?.machineId ?? null)}
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

    const renderActionOnlyGroupHeader = (group: SessionGroup) => {
        // With multiple machines in the unfiltered view, disambiguate
        // same-named directories by suffixing the machine label.
        const groupTitle = showMachineFilterBar && activeMachineFilter === null
            ? `${group.displayName} · ${resolveMachineLabel(group.machineId)}`
            : group.displayName
        return (
            <div key={group.key} data-session-scroll-anchor>
                <div
                    className="group/project sticky top-0 z-10 flex items-center gap-2 bg-[var(--app-bg)] py-1.5 pl-2 pr-2 text-left rounded-lg transition-colors hover:bg-[var(--app-secondary-bg)] min-w-0 w-full select-none"
                    title={group.directory}
                >
                    <span className="font-medium text-sm truncate flex-1">
                        {groupTitle}
                    </span>
                    <CopyPathButton path={group.directory} className="opacity-0 group-hover/project:opacity-100 transition-opacity duration-150" />
                    {onNewSessionInDirectory && group.directory !== 'Other' ? (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation()
                                onNewSessionInDirectory({
                                    machineId: group.machineId,
                                    directory: group.directory
                                })
                            }}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] opacity-70 transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                            title={t('sessions.group.new')}
                            aria-label={t('sessions.group.new')}
                        >
                            <PlusIcon className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                </div>
            </div>
        )
    }

    const renderDirectoryGroup = (group: SessionGroup) => {
        const isCollapsed = isGroupCollapsed(group)
        const visibleGroupSessions = getVisibleGroupSessions(group)
        const hiddenSessionCount = group.sessions.length - visibleGroupSessions.length
        const currentLimit = Math.min(
            getGroupVisibleCount(group),
            group.sessions.length
        )
        const previousLimit = getPreviousSessionVisibleCount(currentLimit, sessionPreviewLimit)
        const previousGroupSessions = getVisibleSessionPreview(group.sessions, {
            selectedSessionId,
            limit: previousLimit
        })
        const collapseCount = visibleGroupSessions.length - previousGroupSessions.length
        const canShowFewerSessions = previousLimit < currentLimit && collapseCount > 0
        const expandCount = Math.min(sessionPreviewLimit, hiddenSessionCount)
        const canStartInGroupDirectory = group.directory !== 'Other'
        // With multiple machines in the unfiltered view, disambiguate
        // same-named directories by suffixing the machine label.
        const groupTitle = showMachineFilterBar && activeMachineFilter === null
            ? `${group.displayName} · ${resolveMachineLabel(group.machineId)}`
            : group.displayName
        return (
            <div key={group.key} data-session-scroll-anchor>
                <div
                    className="group/project sticky top-0 z-10 flex items-center gap-2 bg-[var(--app-bg)] py-1.5 pl-2 pr-2 text-left rounded-lg transition-colors hover:bg-[var(--app-secondary-bg)] cursor-pointer min-w-0 w-full select-none"
                    onClick={() => toggleGroup(group.key, isCollapsed)}
                    title={group.directory}
                >
                    <ChevronIcon className="h-3.5 w-3.5 text-[var(--app-hint)] shrink-0" collapsed={isCollapsed} />
                    <span className="font-medium text-sm truncate flex-1">
                        {groupTitle}
                    </span>
                    <CopyPathButton path={group.directory} className="opacity-0 group-hover/project:opacity-100 transition-opacity duration-150" />
                    {onNewSessionInDirectory && canStartInGroupDirectory ? (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation()
                                onNewSessionInDirectory({
                                    machineId: group.machineId,
                                    directory: group.directory
                                })
                            }}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] opacity-70 transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                            title={t('sessions.group.new')}
                            aria-label={t('sessions.group.new')}
                        >
                            <PlusIcon className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                    <span className="text-[11px] tabular-nums text-[var(--app-hint)] shrink-0">
                        ({group.sessions.length})
                    </span>
                </div>

                {/* Sessions */}
                <CollapsiblePanel open={!isCollapsed}>
                    <div className="flex flex-col gap-0.5 ml-3 pl-1 py-1">
                        {visibleGroupSessions.map((s, index) => (
                            <div key={s.id} className="contents">
                                {shouldShowPinnedDivider(visibleGroupSessions, index) ? (
                                    <div
                                        data-testid="session-pin-divider"
                                        className="ml-2.5 mr-2 my-1 border-t border-[var(--app-border)]"
                                        aria-hidden="true"
                                    />
                                ) : null}
                                <SessionItem
                                    session={s}
                                    onSelect={props.onSelect}
                                    showPath={false}
                                    api={api}
                                    titleSuggestionAvailable={titleSuggestionAvailable}
                                    selected={s.id === selectedSessionId}
                                    showDetailedStatus={showDetailedStatus}
                                    lastSeenVersion={lastSeenVersion}
                                />
                            </div>
                        ))}
                        {group.sessions.length > sessionPreviewLimit && (hiddenSessionCount > 0 || canShowFewerSessions) ? (
                            <div className="ml-2.5 mr-2 my-1 flex gap-1.5">
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
                        ) : null}
                    </div>
                </CollapsiblePanel>
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
            autoExpandedSelectedSessionKeyRef.current = null
            return
        }

        const autoExpandKey = `${selectedSessionId}::${group.key}`
        if (autoExpandedSelectedSessionKeyRef.current === autoExpandKey) return
        autoExpandedSelectedSessionKeyRef.current = autoExpandKey

        setCollapseOverrides(prev => expandSelectedSessionCollapseOverrides(prev, group))
    }, [selectedSessionId, groups])

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
        const machinePx = machineMenuRef.current?.offsetWidth ?? 0
        setToolbarChrome((previous) => (
            previous.morePx === morePx && previous.gapPx === gapPx && previous.machinePx === machinePx
                ? previous
                : { morePx, gapPx, machinePx }
        ))
        // Search may use a 9rem chip. Reserve padding + gap + visible machine
        // menu + More so that chip cannot eat the trailing controls (#2040).
        const row = headerRowRef.current
        const rowBox = row && row.clientWidth > 0 ? row.clientWidth : toolbarRowBoxPx
        const rowStyle = row ? getComputedStyle(row) : null
        const rowPad = rowStyle
            ? (Number.parseFloat(rowStyle.paddingLeft) || 0) + (Number.parseFloat(rowStyle.paddingRight) || 0)
            : 0
        const trailing = gapPx
            + (machinePx > 0 ? machinePx + gapPx : 0)
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
    useEffect(() => {
        onRefreshRef.current = props.onRefresh
    }, [props.onRefresh])

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
            void Promise.resolve(onRefreshRef.current()).finally(() => {
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

    return (
        <div className="flex min-h-0 w-full flex-1 flex-col">
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
                            customStart={customStart}
                            customEnd={customEnd}
                            sessionActivityDates={sessionActivityDates}
                            onDateRangeChange={(start, end) => {
                                setCustomStart(start)
                                setCustomEnd(end)
                            }}
                            expanded={searchExpanded}
                            onExpandedChange={setSearchExpanded}
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
                                const machineAndGap = toolbarChrome.machinePx > 0
                                    ? toolbarChrome.machinePx + toolbarChrome.gapPx
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
                                    ? Math.max(0, gutter - machineAndGap)
                                    : toolbarActionBudget(0, searchQuery.length > 0)
                                const slotWidth = (id: string, fallback: number) => {
                                    const measured = toolbarSlotWidths[id] ?? 0
                                    return measured > 0 ? measured : fallback
                                }
                                const definedSlots: Array<ToolbarShedSlot & { node: ReactNode }> = []
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
                                definedSlots.push({
                                    id: 'unread',
                                    keep: 5,
                                    widthPx: slotWidth('unread', TOOLBAR_ICON_PX),
                                    node: (
                                        <button
                                            type="button"
                                            onClick={() => setShowUnreadOnly(!showUnreadOnly)}
                                            aria-pressed={showUnreadOnly}
                                            title={t('sessions.unreadFilter.toggle')}
                                            aria-label={t('sessions.unreadFilter.toggle')}
                                            className={cn(
                                                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                                                showUnreadOnly
                                                    ? 'bg-[var(--app-subtle-bg)]'
                                                    : 'hover:bg-[var(--app-subtle-bg)]'
                                            )}
                                        >
                                            <span
                                                aria-hidden
                                                className={cn(
                                                    'inline-flex h-2.5 w-2.5 shrink-0 rounded-full',
                                                    showUnreadOnly
                                                        ? 'bg-[var(--app-link)]'
                                                        : 'bg-[var(--app-hint)]'
                                                )}
                                            />
                                        </button>
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
                                        {showMachineFilterBar ? (
                                            <div
                                                ref={machineMenuRef}
                                                data-testid="session-list-header-machine-menu"
                                                className="inline-flex shrink-0"
                                            >
                                                <MachineFilterMenu
                                                    machines={machineFilterItems}
                                                    totalCount={allSessions.length}
                                                    value={activeMachineFilter}
                                                    onChange={setMachineFilter}
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
            <SessionListScrollAnchor sessions={props.sessions} className="mx-auto flex w-full max-w-content flex-col gap-1 pl-1.5 pr-2 pb-2">
                {props.sessions.length === 0 && !props.isLoading ? (
                    <SessionsEmptyState
                        onNewSession={props.onNewSession}
                        onBrowse={props.onBrowse}
                    />
                ) : null}

                {props.sessions.length > 0 && (isFiltering || activeMachineFilter !== null || showUnreadOnly) && groups.length === 0 && runningSessionTotal === 0 && activeSessionTotal === 0 && globalPinnedSessions.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('sessions.search.noResults')}
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
                                            titleSuggestionAvailable={titleSuggestionAvailable}
                                            selected={s.id === selectedSessionId}
                                            showDetailedStatus={showDetailedStatus}
                                            inRunningSection
                                            projectLabel={getPathDisplayName(s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other')}
                                            machineLabel={resolveMachineLabel(s.metadata?.machineId ?? null)}
                                            lastSeenVersion={lastSeenVersion}
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
                    bucketKeys: ['working', 'pending'],
                })}
                {renderPinnedSection({
                    sectionKey: 'active-section',
                    titleKey: 'sessions.activeSection',
                    collapsed: activeSectionCollapsed,
                    onToggle: () => setActiveSectionCollapsed((value) => !value),
                    pulse: false,
                    count: activeSessionTotal,
                    bucketKeys: ['active', 'idle'],
                })}
                {groups.map(renderDirectoryGroup)}
                {actionOnlyGroups.map(renderActionOnlyGroupHeader)}
            </SessionListScrollAnchor>
            </div>
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
