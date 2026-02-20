import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type WheelEvent } from 'react'
import {
    DndContext,
    KeyboardSensor,
    MouseSensor,
    TouchSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from '@dnd-kit/core'
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { generateKeyBetween } from 'fractional-indexing'
import { useSwipeable, type SwipeEventData } from 'react-swipeable'
import type { SessionSummary, SessionsResponse } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import {
    useSessionActions,
    useSessionSortOrderMutation,
    type SessionSortOrderUpdate
} from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { clearMessageWindow } from '@/lib/message-window-store'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

const SESSION_READ_HISTORY_KEY = 'hapi:sessionReadHistory'

type SessionGroup = {
    key: string
    directory: string
    machineId: string | null
    displayName: string
    sessions: SessionSummary[]
    minSortOrder: string | null
    latestUpdatedAt: number
    latestReadAt: number
    hasActiveSession: boolean
}

export type SessionReadHistory = Record<string, number>

function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function normalizeTimestamp(value: number): number {
    return value < 1_000_000_000_000 ? value * 1000 : value
}

type SessionWithSortOrder = SessionSummary & {
    sortOrder?: string | null
    sort_order?: string | null
}

function parseSortOrderValue(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) return null
    return value
}

export function getSessionSortOrder(session: SessionSummary): string | null {
    const sessionWithSortOrder = session as SessionWithSortOrder
    const direct = parseSortOrderValue(sessionWithSortOrder.sortOrder)
    if (direct !== null) return direct
    return parseSortOrderValue(sessionWithSortOrder.sort_order)
}

export function setSessionSortOrderValue(session: SessionSummary, sortOrder: string | null): SessionSummary {
    return {
        ...(session as SessionWithSortOrder),
        sortOrder,
        sort_order: sortOrder
    } as SessionSummary
}

export function loadSessionReadHistory(): SessionReadHistory {
    if (typeof window === 'undefined') return {}

    try {
        const raw = localStorage.getItem(SESSION_READ_HISTORY_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const entries = Object.entries(parsed)
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
            .map(([key, value]) => [key, value as number])
        return Object.fromEntries(entries)
    } catch {
        return {}
    }
}

export function saveSessionReadHistory(history: SessionReadHistory): void {
    if (typeof window === 'undefined') return

    try {
        localStorage.setItem(SESSION_READ_HISTORY_KEY, JSON.stringify(history))
    } catch {
        // best-effort
    }
}

export function pruneSessionReadHistory(
    history: SessionReadHistory,
    sessionIds: Set<string>
): SessionReadHistory {
    let changed = false
    const next: SessionReadHistory = {}

    for (const [sessionId, readAt] of Object.entries(history)) {
        if (!sessionIds.has(sessionId)) {
            changed = true
            continue
        }
        next[sessionId] = readAt
    }

    return changed ? next : history
}

export function sortSessionsBySortOrder(
    sessions: SessionSummary[],
): SessionSummary[] {
    return [...sessions].sort((a, b) => {
        const sortOrderA = getSessionSortOrder(a)
        const sortOrderB = getSessionSortOrder(b)

        if (sortOrderA === null && sortOrderB !== null) return 1
        if (sortOrderA !== null && sortOrderB === null) return -1
        if (sortOrderA !== null && sortOrderB !== null && sortOrderA !== sortOrderB) {
            return sortOrderA < sortOrderB ? -1 : 1
        }

        return a.id.localeCompare(b.id)
    })
}

function getSessionDirectory(session: SessionSummary): string {
    return session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
}

function getSessionMachineId(session: SessionSummary): string | null {
    return session.metadata?.machineId ?? null
}

function getSessionGroupKey(directory: string, machineId: string | null): string {
    return `${machineId ?? 'unknown-machine'}::${directory}`
}

export function groupSessionsByDirectory(
    sessions: SessionSummary[],
    readHistory: SessionReadHistory,
    _unreadSessionIds: Set<string> = new Set(),
    _now: number = Date.now()
): SessionGroup[] {
    const groups = new Map<string, { directory: string; machineId: string | null; sessions: SessionSummary[] }>()

    sessions.forEach(session => {
        const directory = getSessionDirectory(session)
        const machineId = getSessionMachineId(session)
        const key = getSessionGroupKey(directory, machineId)

        if (!groups.has(key)) {
            groups.set(key, {
                directory,
                machineId,
                sessions: []
            })
        }
        groups.get(key)!.sessions.push(session)
    })

    return Array.from(groups.entries())
        .map(([key, group]) => {
            const sortedSessions = sortSessionsBySortOrder(group.sessions)
            const minSortOrder = sortedSessions.reduce<string | null>((min, session) => {
                const sortOrder = getSessionSortOrder(session)
                if (sortOrder === null) return min
                if (min === null || sortOrder < min) return sortOrder
                return min
            }, null)

            const latestUpdatedAt = group.sessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const latestReadAt = group.sessions.reduce(
                (max, s) => (readHistory[s.id] && readHistory[s.id] > max ? readHistory[s.id] : max),
                -Infinity
            )
            const hasActiveSession = group.sessions.some(s => s.active)
            const displayName = getGroupDisplayName(group.directory)

            return {
                key,
                directory: group.directory,
                machineId: group.machineId,
                displayName,
                sessions: sortedSessions,
                minSortOrder,
                latestUpdatedAt,
                latestReadAt,
                hasActiveSession
            }
        })
        .sort((a, b) => {
            if (a.minSortOrder === null && b.minSortOrder !== null) return 1
            if (a.minSortOrder !== null && b.minSortOrder === null) return -1
            if (a.minSortOrder !== null && b.minSortOrder !== null && a.minSortOrder !== b.minSortOrder) {
                return a.minSortOrder < b.minSortOrder ? -1 : 1
            }

            const machineCompare = (a.machineId ?? '').localeCompare(b.machineId ?? '')
            if (machineCompare !== 0) return machineCompare

            return a.directory.localeCompare(b.directory)
        })
}

export const FLAT_DIRECTORY_KEY = '__hapi_flat__'

export function flattenSessions(
    sessions: SessionSummary[],
    readHistory: SessionReadHistory,
    _unreadSessionIds: Set<string> = new Set(),
    _now: number = Date.now()
): SessionGroup[] {
    if (sessions.length === 0) return []

    const sortedSessions = sortSessionsBySortOrder(sessions)
    const minSortOrder = sortedSessions.reduce<string | null>((min, session) => {
        const sortOrder = getSessionSortOrder(session)
        if (sortOrder === null) return min
        if (min === null || sortOrder < min) return sortOrder
        return min
    }, null)

    return [{
        key: FLAT_DIRECTORY_KEY,
        directory: FLAT_DIRECTORY_KEY,
        machineId: null,
        displayName: '',
        sessions: sortedSessions,
        minSortOrder,
        latestUpdatedAt: sessions.reduce((max, s) => Math.max(max, s.updatedAt), -Infinity),
        latestReadAt: sessions.reduce((max, s) => Math.max(max, readHistory[s.id] ?? -Infinity), -Infinity),
        hasActiveSession: sessions.some(s => s.active)
    }]
}

export function buildSortOrderUpdatesForReorder(
    reorderedScope: SessionSummary[],
    movedSessionId: string
): SessionSortOrderUpdate[] {
    const movedIndex = reorderedScope.findIndex(session => session.id === movedSessionId)
    if (movedIndex < 0) return []

    const movedSession = reorderedScope[movedIndex]
    if (!movedSession) return []

    const previousSortOrder = movedIndex > 0
        ? getSessionSortOrder(reorderedScope[movedIndex - 1]!)
        : null
    const nextSortOrder = movedIndex < reorderedScope.length - 1
        ? getSessionSortOrder(reorderedScope[movedIndex + 1]!)
        : null

    const generated = (() => {
        try {
            return generateKeyBetween(previousSortOrder, nextSortOrder)
        } catch {
            try {
                return generateKeyBetween(previousSortOrder, null)
            } catch {
                try {
                    return generateKeyBetween(null, nextSortOrder)
                } catch {
                    return generateKeyBetween(null, null)
                }
            }
        }
    })()
    if (generated === getSessionSortOrder(movedSession)) {
        return []
    }

    return [{
        sessionId: movedSession.id,
        sortOrder: generated
    }]
}

export function applySortOrderUpdatesToSessions(
    sessions: SessionSummary[],
    updates: SessionSortOrderUpdate[]
): SessionSummary[] {
    if (updates.length === 0) return sessions
    const updateMap = new Map(updates.map(update => [update.sessionId, update.sortOrder]))
    let changed = false
    const nextSessions = sessions.map(session => {
        if (!updateMap.has(session.id)) return session
        changed = true
        return setSessionSortOrderValue(session, updateMap.get(session.id)!)
    })
    return changed ? nextSessions : sessions
}

export function applyOptimisticSortOrderUpdates(
    queryClient: QueryClient,
    updates: SessionSortOrderUpdate[]
): () => void {
    if (updates.length === 0) {
        return () => {
            // no-op
        }
    }

    const previous = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
    queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, current => {
        if (!current) return current
        return {
            ...current,
            sessions: applySortOrderUpdatesToSessions(current.sessions, updates)
        }
    })

    return () => {
        if (previous === undefined) return
        queryClient.setQueryData(queryKeys.sessions, previous)
    }
}

export function patchGroupsVisuals(
    frozenGroups: SessionGroup[],
    latestSessions: SessionSummary[]
): SessionGroup[] {
    const sessionMap = new Map(latestSessions.map(s => [s.id, s]))
    let anyChanged = false

    const patched = frozenGroups.map(group => {
        const patchedSessions: SessionSummary[] = []
        let groupChanged = false
        for (const frozenSession of group.sessions) {
            const latest = sessionMap.get(frozenSession.id)
            if (!latest) {
                groupChanged = true
                continue
            }
            if (latest !== frozenSession) groupChanged = true
            patchedSessions.push(latest)
        }
        if (!groupChanged) return group
        anyChanged = true
        const minSortOrder = patchedSessions.reduce<string | null>((min, session) => {
            const sortOrder = getSessionSortOrder(session)
            if (sortOrder === null) return min
            if (min === null || sortOrder < min) return sortOrder
            return min
        }, null)
        return {
            ...group,
            sessions: patchedSessions,
            minSortOrder,
            hasActiveSession: patchedSessions.some(s => s.active)
        }
    }).filter(group => group.sessions.length > 0)

    return anyChanged || patched.length !== frozenGroups.length ? patched : frozenGroups
}

export function getSessionIdHash(sessions: SessionSummary[]): string {
    return sessions.map(s => s.id).sort().join('\0')
}

export type FreezeState = {
    frozenGroups: SessionGroup[] | null
    prevSelectedSessionId: string | null
    prevSessionIdHash: string
    prevViewKey: string
    unfreezeCount: number
    selectionFreezeArmed: boolean
}

export function computeFreezeStep(
    state: FreezeState,
    liveGroups: SessionGroup[],
    selectedSessionId: string | null | undefined,
    sessions: SessionSummary[],
    viewKey: 'grouped' | 'flat'
): FreezeState & { displayGroups: SessionGroup[] } {
    const normalizedSelectedSessionId = selectedSessionId ?? null
    const prevSelectedSessionId = state.prevSelectedSessionId ?? null
    const selectionChanged = normalizedSelectedSessionId !== prevSelectedSessionId
    const sessionIdHash = getSessionIdHash(sessions)
    const sessionsChanged = sessionIdHash !== state.prevSessionIdHash
    const viewChanged = viewKey !== state.prevViewKey

    let frozenGroups = state.frozenGroups
    let unfreezeCount = state.unfreezeCount
    let selectionFreezeArmed = state.selectionFreezeArmed

    // Freeze strategy:
    // - While a session is selected, keep list order frozen to prevent selection-induced jumps.
    // - Patch visuals in-place so status badges/timestamps still update.
    // - Release freeze only on deselect, view change, or session ID set changes.
    const isDeselecting = selectionChanged && normalizedSelectedSessionId === null
    const shouldForceUnfreeze = sessionsChanged || isDeselecting || viewChanged

    if (!frozenGroups) {
        frozenGroups = liveGroups
    }

    if (shouldForceUnfreeze) {
        frozenGroups = liveGroups
        unfreezeCount += 1
        selectionFreezeArmed = false
    } else if (normalizedSelectedSessionId !== null) {
        frozenGroups = patchGroupsVisuals(frozenGroups, sessions)
        selectionFreezeArmed = true
    } else {
        frozenGroups = liveGroups
        selectionFreezeArmed = false
    }

    return {
        frozenGroups,
        prevSelectedSessionId: normalizedSelectedSessionId,
        prevSessionIdHash: sessionIdHash,
        prevViewKey: viewKey,
        unfreezeCount,
        selectionFreezeArmed,
        displayGroups: frozenGroups
    }
}

function useFrozenGroups(
    liveGroups: SessionGroup[],
    selectedSessionId: string | null | undefined,
    sessions: SessionSummary[],
    viewKey: 'grouped' | 'flat'
): { displayGroups: SessionGroup[] } {
    const stateRef = useRef<FreezeState>({
        frozenGroups: null,
        prevSelectedSessionId: null,
        prevSessionIdHash: getSessionIdHash(sessions),
        prevViewKey: viewKey,
        unfreezeCount: 0,
        selectionFreezeArmed: false
    })

    const result = computeFreezeStep(stateRef.current, liveGroups, selectedSessionId, sessions, viewKey)
    stateRef.current = result

    return {
        displayGroups: result.displayGroups
    }
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

function MoreVerticalIcon(props: { className?: string }) {
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
            <circle cx="12" cy="12" r="1" />
            <circle cx="12" cy="5" r="1" />
            <circle cx="12" cy="19" r="1" />
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

function TrashIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M6 6l1 14h10l1-14" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
        </svg>
    )
}

function CheckIcon(props: { className?: string }) {
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
            <polyline points="20 6 9 17 4 12" />
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

function GripVerticalIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="9" cy="5" r="1" />
            <circle cx="9" cy="12" r="1" />
            <circle cx="9" cy="19" r="1" />
            <circle cx="15" cy="5" r="1" />
            <circle cx="15" cy="12" r="1" />
            <circle cx="15" cy="19" r="1" />
        </svg>
    )
}

function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

function getAgentLabel(session: SessionSummary): string {
    const flavor = session.metadata?.flavor?.trim()
    if (flavor) return flavor
    return 'unknown'
}

function formatRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const ms = normalizeTimestamp(value)
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
    return new Date(ms).toLocaleDateString()
}

export function getUnreadLabelClass(thinking: boolean): string {
    return thinking
        ? 'text-[var(--app-hint)] opacity-70'
        : 'text-[#34C759]'
}

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    onToggleSelected: (sessionId: string) => void
    showPath?: boolean
    projectLabel?: string
    api: ApiClient | null
    selected?: boolean
    selectionMode: boolean
    selectedForBulk: boolean
    unread?: boolean
    dndEnabled: boolean
    dragInstructionsId: string
    dragHandleBindings: Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners' | 'setActivatorNodeRef'>
    dragging: boolean
    dropTarget: boolean
    dragInProgress: boolean
}) {
    const { t } = useTranslation()
    const {
        session: s,
        onSelect,
        onToggleSelected,
        showPath = true,
        projectLabel,
        api,
        selected = false,
        selectionMode,
        selectedForBulk,
        unread = false,
        dndEnabled,
        dragInstructionsId,
        dragHandleBindings,
        dragging,
        dropTarget,
        dragInProgress
    } = props
    const { haptic, isTouch } = usePlatform()
    const SWIPE_MAX_PX = 112
    const SWIPE_TRIGGER_PX = 72
    const TRACKPAD_SWIPE_MULTIPLIER = 0.45
    const TRACKPAD_TRIGGER_PX = 92
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [swipeOffset, setSwipeOffset] = useState(0)
    const [isSwiping, setIsSwiping] = useState(false)
    const trackpadSwipeOffsetRef = useRef(0)
    const trackpadSwipeEndTimerRef = useRef<number | null>(null)
    const isMacPlatform = useMemo(() => {
        if (typeof navigator === 'undefined') return false
        const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        const platform = userAgentData?.platform ?? navigator.platform ?? ''
        return /mac/i.test(platform)
    }, [])
    const enableTrackpadSwipe = !isTouch && isMacPlatform
    const disableGestureActions = dragInProgress
    const showSwipeUi = isTouch || enableTrackpadSwipe
    const showSwipeAction = showSwipeUi && (isSwiping || swipeOffset < 0)

    const { archiveSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            if (disableGestureActions) return
            if (selectionMode) {
                onToggleSelected(s.id)
                return
            }
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (disableGestureActions) return
            if (menuOpen) return
            if (selectionMode) {
                onToggleSelected(s.id)
                return
            }
            onSelect(s.id)
        },
        threshold: 500,
        disabled: disableGestureActions
    })

    const clearTrackpadSwipeEndTimer = () => {
        if (trackpadSwipeEndTimerRef.current !== null) {
            window.clearTimeout(trackpadSwipeEndTimerRef.current)
            trackpadSwipeEndTimerRef.current = null
        }
    }

    const resetSwipe = () => {
        clearTrackpadSwipeEndTimer()
        trackpadSwipeOffsetRef.current = 0
        setSwipeOffset(0)
        setIsSwiping(false)
    }

    const triggerArchiveFromSwipe = () => {
        if (s.active) {
            haptic.notification('warning')
            setArchiveOpen(true)
        } else {
            haptic.notification('error')
            setDeleteOpen(true)
        }
        resetSwipe()
    }

    const swipeHandlers = useSwipeable({
        trackMouse: false,
        trackTouch: isTouch,
        onSwipeStart: () => {
            setIsSwiping(false)
            setSwipeOffset(0)
        },
        onSwiping: (eventData: SwipeEventData) => {
            if (eventData.dir !== 'Left') {
                return
            }
            setIsSwiping(true)
            setSwipeOffset(-Math.min(SWIPE_MAX_PX, eventData.absX))
        },
        onSwipedLeft: (eventData: SwipeEventData) => {
            if (eventData.absX >= SWIPE_TRIGGER_PX && !isPending) {
                triggerArchiveFromSwipe()
                return
            }
            resetSwipe()
        },
        onSwiped: () => {
            resetSwipe()
        }
    })

    const scheduleTrackpadSwipeEnd = () => {
        clearTrackpadSwipeEndTimer()
        trackpadSwipeEndTimerRef.current = window.setTimeout(() => {
            if (trackpadSwipeOffsetRef.current <= -TRACKPAD_TRIGGER_PX && !isPending) {
                triggerArchiveFromSwipe()
                return
            }
            resetSwipe()
        }, 90)
    }

    const handleTrackpadWheel = (event: WheelEvent<HTMLDivElement>) => {
        if (!enableTrackpadSwipe || isPending || disableGestureActions) return
        if (event.deltaMode !== 0) return
        if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return

        const adjustedDeltaX = event.deltaX * TRACKPAD_SWIPE_MULTIPLIER
        const nextOffset = Math.max(
            -SWIPE_MAX_PX,
            Math.min(0, trackpadSwipeOffsetRef.current + adjustedDeltaX)
        )
        if (nextOffset === trackpadSwipeOffsetRef.current) return

        event.preventDefault()
        trackpadSwipeOffsetRef.current = nextOffset
        setSwipeOffset(nextOffset)
        setIsSwiping(true)
        scheduleTrackpadSwipeEnd()
    }

    useEffect(() => {
        return () => {
            clearTrackpadSwipeEndTimer()
        }
    }, [])

    const sessionName = getSessionTitle(s)
    const statusDotClass = s.active
        ? (s.thinking ? 'bg-[#007AFF]' : 'bg-[var(--app-badge-success-text)]')
        : 'bg-[var(--app-hint)]'
    const unreadLabelClass = getUnreadLabelClass(s.thinking)
    const highlighted = selected || (selectionMode && selectedForBulk)

    return (
        <>
            <div
                data-session-id={s.id}
                {...(isTouch && !selectionMode && !disableGestureActions ? swipeHandlers : {})}
                onWheel={enableTrackpadSwipe && !selectionMode && !disableGestureActions ? handleTrackpadWheel : undefined}
                className="relative isolate overflow-hidden group"
                style={{ touchAction: 'pan-y' }}
            >
                {showSwipeUi && !selectionMode && !disableGestureActions ? (
                    <div
                        className="absolute inset-y-0 right-0 -z-10 flex w-28 items-center justify-center bg-red-500/85 transition-opacity duration-100 pointer-events-none"
                        style={{ opacity: showSwipeAction ? 1 : 0 }}
                    >
                        <span className="text-xs font-semibold uppercase tracking-wide text-white">
                            {s.active ? t('session.action.archive') : t('session.action.delete')}
                        </span>
                    </div>
                ) : null}
                {dropTarget ? (
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 bg-[var(--app-link)]" />
                ) : null}
                <div
                    className={`session-list-item relative z-10 flex w-full select-none ${highlighted ? 'bg-[var(--app-secondary-bg)] border-l-2 border-[var(--app-link)]' : 'bg-[var(--app-bg)]'} ${dragging ? 'opacity-95 ring-2 ring-[var(--app-link)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]' : ''}`}
                    style={{
                        WebkitTouchCallout: 'none',
                        transform: showSwipeUi && swipeOffset !== 0 ? `translateX(${swipeOffset}px)` : undefined,
                        transition: showSwipeUi ? (isSwiping ? 'none' : 'transform 150ms ease-out') : undefined
                    }}
                >
                    <button
                        type="button"
                        ref={dragHandleBindings.setActivatorNodeRef}
                        {...dragHandleBindings.attributes}
                        {...dragHandleBindings.listeners}
                        disabled={!dndEnabled}
                        data-drag-handle={s.id}
                        className={`inline-flex h-11 w-11 shrink-0 items-center justify-center border-r border-[var(--app-divider)] text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${dndEnabled ? 'cursor-grab active:cursor-grabbing hover:text-[var(--app-fg)]' : 'cursor-not-allowed opacity-50'}`}
                        aria-label={dndEnabled
                            ? t('session.dragHandle.label', { name: sessionName })
                            : t('session.dragHandle.disabled')}
                        aria-describedby={dragInstructionsId}
                        title={dndEnabled
                            ? t('session.dragHandle.label', { name: sessionName })
                            : t('session.dragHandle.disabled')}
                    >
                        <GripVerticalIcon className="h-5 w-5" />
                    </button>
                    <button
                        type="button"
                        {...longPressHandlers}
                        className="flex-1 flex flex-col gap-1.5 px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        aria-current={selected ? 'page' : undefined}
                        aria-pressed={selectionMode ? selectedForBulk : undefined}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                                {selectionMode ? (
                                    <span
                                        className={`flex h-4 w-4 items-center justify-center rounded border ${selectedForBulk ? 'border-[var(--app-link)] bg-[var(--app-link)] text-white' : 'border-[var(--app-border)] text-transparent'}`}
                                        aria-hidden="true"
                                    >
                                        <CheckIcon className="h-3 w-3" />
                                    </span>
                                ) : null}
                                <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                                    <span
                                        className={`h-2 w-2 rounded-full ${statusDotClass}`}
                                    />
                                </span>
                                <div className="truncate text-base font-medium">
                                    {sessionName}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 text-xs">
                                {s.thinking ? (
                                    <span className="text-[#007AFF] animate-pulse">
                                        {t('session.item.thinking')}
                                    </span>
                                ) : null}
                                {unread ? (
                                    <span className={unreadLabelClass}>
                                        {t('session.item.unread')}
                                    </span>
                                ) : null}
                                {(() => {
                                    const progress = getTodoProgress(s)
                                    if (!progress) return null
                                    return (
                                        <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                            <BulbIcon className="h-3 w-3" />
                                            {progress.completed}/{progress.total}
                                        </span>
                                    )
                                })()}
                                {s.pendingRequestsCount > 0 ? (
                                    <span className="text-[var(--app-badge-warning-text)]">
                                        {t('session.item.pending')} {s.pendingRequestsCount}
                                    </span>
                                ) : null}
                                <span className="text-[var(--app-hint)]">
                                    {formatRelativeTime(s.updatedAt, t)}
                                </span>
                            </div>
                        </div>
                        {showPath ? (
                            <div className="truncate text-xs text-[var(--app-hint)]">
                                {s.metadata?.path ?? s.id}
                            </div>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--app-hint)]">
                            {projectLabel ? (
                                <span className="truncate max-w-[160px]" title={projectLabel} data-session-project-label>
                                    {projectLabel}
                                </span>
                            ) : null}
                            <span className="inline-flex items-center gap-2">
                                <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                                    ❖
                                </span>
                                {getAgentLabel(s)}
                            </span>
                            <span>{t('session.item.modelMode')}: {s.modelMode || 'default'}</span>
                            {s.metadata?.worktree?.branch ? (
                                <span>{t('session.item.worktree')}: {s.metadata.worktree.branch}</span>
                            ) : null}
                        </div>
                    </button>
                    <button
                        type="button"
                        className="px-2 flex items-center justify-center text-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        onClick={(e) => {
                            e.stopPropagation()
                            const rect = e.currentTarget.getBoundingClientRect()
                            setMenuAnchorPoint({ x: rect.left, y: rect.bottom })
                            setMenuOpen(true)
                        }}
                        aria-label={t('session.more')}
                        aria-haspopup="true"
                        aria-expanded={menuOpen}
                    >
                        <MoreVerticalIcon className="h-5 w-5" />
                    </button>
                </div>
            </div>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={s.active}
                onRename={() => setRenameOpen(true)}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
            />

            <RenameSessionDialog
                isOpen={renameOpen}
                onClose={() => setRenameOpen(false)}
                currentName={sessionName}
                onRename={renameSession}
                isPending={isPending}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name: sessionName })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <ConfirmDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title={t('dialog.delete.title')}
                description={t('dialog.delete.description', { name: sessionName })}
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                onConfirm={deleteSession}
                isPending={isPending}
                destructive
            />
        </>
    )
}

type SessionItemProps = Parameters<typeof SessionItem>[0]

function SortableSessionItem(
    props: Omit<SessionItemProps, 'dragHandleBindings' | 'dragging' | 'dropTarget'>
) {
    const sortable = useSortable({
        id: props.session.id,
        disabled: !props.dndEnabled,
    })

    const transform = CSS.Transform.toString(sortable.transform)
    const draggingTransform = sortable.isDragging
        ? (transform ? `${transform} scale(1.02)` : 'scale(1.02)')
        : transform

    return (
        <div
            ref={sortable.setNodeRef}
            style={{
                transform: draggingTransform,
                transition: sortable.transition,
            }}
            className={sortable.isDragging ? 'relative z-50' : undefined}
            data-session-dragging={sortable.isDragging ? 'true' : 'false'}
        >
            <SessionItem
                {...props}
                dragging={sortable.isDragging}
                dropTarget={sortable.isOver && !sortable.isDragging}
                dragInProgress={props.dragInProgress}
                dragHandleBindings={{
                    attributes: sortable.attributes,
                    listeners: sortable.listeners,
                    setActivatorNodeRef: sortable.setActivatorNodeRef
                }}
            />
        </div>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: (opts?: { directory?: string; machineId?: string }) => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    selectedSessionId?: string | null
    scrollContainerRef?: RefObject<HTMLElement | null>
    machineNames?: Map<string, string>
    view?: 'grouped' | 'flat'
    onToggleView?: () => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { renderHeader = true, api, selectedSessionId, machineNames } = props

    const [selectionMode, setSelectionMode] = useState(false)
    const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set())
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
    const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null)
    const [isBulkDeleting, setIsBulkDeleting] = useState(false)

    const [readHistory, setReadHistory] = useState<SessionReadHistory>(() => loadSessionReadHistory())

    const prevUpdatedAtRef = useRef<Map<string, number>>(new Map())
    const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set())

    useEffect(() => {
        const knownSessionIds = new Set(props.sessions.map(session => session.id))

        setReadHistory(prev => {
            const pruned = pruneSessionReadHistory(prev, knownSessionIds)
            if (pruned !== prev) {
                saveSessionReadHistory(pruned)
            }
            return pruned
        })

        setSelectedSessionIds(prev => {
            let changed = false
            const next = new Set<string>()
            for (const sessionId of prev) {
                if (knownSessionIds.has(sessionId)) {
                    next.add(sessionId)
                } else {
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [props.sessions])

    useEffect(() => {
        const prevUpdatedAt = prevUpdatedAtRef.current
        const nextUpdatedAt = new Map<string, number>()

        setUnreadSessionIds(prev => {
            let next = prev
            for (const session of props.sessions) {
                nextUpdatedAt.set(session.id, session.updatedAt)
                const previousUpdatedAt = prevUpdatedAt.get(session.id)
                if (
                    previousUpdatedAt !== undefined
                    && session.updatedAt > previousUpdatedAt
                    && session.id !== selectedSessionId
                ) {
                    if (!next.has(session.id)) {
                        next = new Set(next)
                        next.add(session.id)
                    }
                }
            }
            return next
        })

        prevUpdatedAtRef.current = nextUpdatedAt
    }, [props.sessions, selectedSessionId])

    useEffect(() => {
        if (!selectedSessionId) return

        // Update read history when a session is selected.
        setReadHistory(prev => {
            const next = { ...prev, [selectedSessionId]: Date.now() }
            saveSessionReadHistory(next)
            return next
        })

        setUnreadSessionIds(prev => {
            if (!prev.has(selectedSessionId)) return prev
            const next = new Set(prev)
            next.delete(selectedSessionId)
            return next
        })
    }, [selectedSessionId])

    const { setSessionSortOrder, isPending: isSortOrderMutationPending } = useSessionSortOrderMutation(api)
    const [activeDragSessionId, setActiveDragSessionId] = useState<string | null>(null)
    const [dragFrozenGroups, setDragFrozenGroups] = useState<SessionGroup[] | null>(null)

    const isFlat = props.view === 'flat'
    const liveGroups = useMemo(
        () => isFlat
            ? flattenSessions(props.sessions, readHistory, unreadSessionIds)
            : groupSessionsByDirectory(props.sessions, readHistory, unreadSessionIds),
        [props.sessions, readHistory, unreadSessionIds, isFlat]
    )
    const displayGroups = useMemo(
        () => dragFrozenGroups
            ? patchGroupsVisuals(dragFrozenGroups, props.sessions)
            : liveGroups,
        [dragFrozenGroups, props.sessions, liveGroups]
    )

    const dndEnabled = !selectionMode && !isBulkDeleting && !isSortOrderMutationPending && Boolean(api)
    const dragInProgress = activeDragSessionId !== null
    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: { distance: 4 }
        }),
        useSensor(TouchSensor, {
            activationConstraint: { delay: 200, tolerance: 5 }
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates
        })
    )
    const dragInstructionsId = 'session-dnd-instructions'

    const listContainerRef = useRef<HTMLDivElement>(null)


    const sessionById = useMemo(
        () => new Map(props.sessions.map(session => [session.id, session])),
        [props.sessions]
    )

    const selectedSessions = useMemo(
        () => Array.from(selectedSessionIds)
            .map(sessionId => sessionById.get(sessionId))
            .filter((session): session is SessionSummary => Boolean(session)),
        [selectedSessionIds, sessionById]
    )

    const selectedCount = selectedSessions.length
    const selectedActiveCount = selectedSessions.filter(session => session.active).length

    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )

    const isGroupCollapsed = (group: SessionGroup): boolean => {
        const override = collapseOverrides.get(group.key)
        if (override !== undefined) return override
        return !group.hasActiveSession
    }

    const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }

    useEffect(() => {
        if (isFlat) return
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownGroups = new Set(displayGroups.map(group => group.key))
            let changed = false
            for (const groupKey of next.keys()) {
                if (!knownGroups.has(groupKey)) {
                    next.delete(groupKey)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [displayGroups, isFlat])

    const toggleSelectedSession = useCallback((sessionId: string) => {
        setSelectedSessionIds(prev => {
            const next = new Set(prev)
            if (next.has(sessionId)) {
                next.delete(sessionId)
            } else {
                next.add(sessionId)
            }
            return next
        })
    }, [])

    const handleSessionSelect = useCallback((sessionId: string) => {
        if (selectionMode) {
            toggleSelectedSession(sessionId)
            return
        }

        props.onSelect(sessionId)
    }, [props, selectionMode, toggleSelectedSession])

    const handleEnableSelectionMode = useCallback(() => {
        setSelectionMode(true)
        setBulkDeleteError(null)
    }, [])

    const handleCancelSelectionMode = useCallback(() => {
        setSelectionMode(false)
        setSelectedSessionIds(new Set())
        setBulkDeleteError(null)
    }, [])

    const handleBulkDelete = useCallback(async () => {
        if (!api || selectedSessions.length === 0) {
            setBulkDeleteOpen(false)
            return
        }

        setIsBulkDeleting(true)
        setBulkDeleteError(null)

        const failedSessionIds: string[] = []

        for (const session of selectedSessions) {
            try {
                if (session.active) {
                    await api.archiveSession(session.id)
                } else {
                    await api.deleteSession(session.id)
                    clearMessageWindow(session.id)
                    queryClient.removeQueries({ queryKey: queryKeys.session(session.id) })
                }
            } catch {
                failedSessionIds.push(session.id)
            }
        }

        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })

        setIsBulkDeleting(false)
        setBulkDeleteOpen(false)

        if (failedSessionIds.length > 0) {
            setBulkDeleteError(t('dialog.delete.selected.error', { n: failedSessionIds.length }))
            setSelectedSessionIds(new Set(failedSessionIds))
            setSelectionMode(true)
            return
        }

        setSelectionMode(false)
        setSelectedSessionIds(new Set())
    }, [api, queryClient, selectedSessions, t])

    const finishDrag = useCallback(() => {
        setActiveDragSessionId(null)
        setDragFrozenGroups(null)
    }, [])

    useEffect(() => {
        if (!activeDragSessionId) return
        const sessionStillExists = props.sessions.some(session => session.id === activeDragSessionId)
        if (!sessionStillExists) {
            finishDrag()
        }
    }, [activeDragSessionId, finishDrag, props.sessions])

    const handleDragStart = useCallback((event: DragStartEvent) => {
        if (!dndEnabled) return
        setActiveDragSessionId(String(event.active.id))
        setDragFrozenGroups(displayGroups)
    }, [dndEnabled, displayGroups])

    const handleDragCancel = useCallback(() => {
        finishDrag()
    }, [finishDrag])

    const handleScopeDragEnd = useCallback(async (event: DragEndEvent, scopeSessions: SessionSummary[]) => {
        const activeId = String(event.active.id)
        const overId = event.over?.id ? String(event.over.id) : null

        if (!overId || activeId === overId || !api) {
            finishDrag()
            return
        }

        const fromIndex = scopeSessions.findIndex(session => session.id === activeId)
        const toIndex = scopeSessions.findIndex(session => session.id === overId)
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
            finishDrag()
            return
        }

        const reorderedScope = arrayMove(scopeSessions, fromIndex, toIndex)
        const updates = buildSortOrderUpdatesForReorder(reorderedScope, activeId)
        if (updates.length === 0) {
            finishDrag()
            return
        }

        const rollback = applyOptimisticSortOrderUpdates(queryClient, updates)
        finishDrag()

        try {
            for (const update of updates) {
                await setSessionSortOrder(update)
            }
        } catch {
            rollback()
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
    }, [api, finishDrag, queryClient, setSessionSortOrder])

    const bulkDeleteDescription = selectedActiveCount > 0
        ? t('dialog.delete.selected.descriptionWithActive', { n: selectedCount, m: selectedActiveCount })
        : t('dialog.delete.selected.description', { n: selectedCount })

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {isFlat
                            ? t('sessions.countFlat', { n: props.sessions.length })
                            : t('sessions.count', { n: props.sessions.length, m: displayGroups.length })}
                    </div>
                    <button
                        type="button"
                        onClick={() => props.onNewSession()}
                        className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                        title={t('sessions.new')}
                    >
                        <PlusIcon className="h-5 w-5" />
                    </button>
                </div>
            ) : null}

            <div className="flex items-center justify-between border-b border-[var(--app-divider)] px-3 py-2">
                {selectionMode ? (
                    <>
                        <span className="text-xs text-[var(--app-hint)]">
                            {t('sessions.selection.count', { n: selectedCount })}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleCancelSelectionMode}
                                className="rounded border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-hint)]"
                            >
                                {t('sessions.selection.cancel')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setBulkDeleteOpen(true)}
                                disabled={selectedCount === 0}
                                className="rounded bg-red-500 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {t('sessions.selection.delete')}
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="ml-auto flex items-center gap-2">
                        {props.onToggleView ? (
                            <button
                                type="button"
                                onClick={props.onToggleView}
                                className={`rounded border px-2 py-1 text-xs ${isFlat
                                    ? 'border-[var(--app-link)] text-[var(--app-link)]'
                                    : 'border-[var(--app-border)] text-[var(--app-hint)]'}`}
                                aria-pressed={isFlat}
                                title={isFlat ? t('sessions.view.grouped') : t('sessions.view.flat')}
                            >
                                {isFlat ? t('sessions.view.flat') : t('sessions.view.grouped')}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={handleEnableSelectionMode}
                            className="rounded border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-hint)]"
                        >
                            {t('sessions.selection.edit')}
                        </button>
                    </div>
                )}
            </div>

            {bulkDeleteError ? (
                <div className="px-3 py-2 text-xs text-red-600">
                    {bulkDeleteError}
                </div>
            ) : null}

            <div ref={listContainerRef} className="flex flex-col">
                <p id={dragInstructionsId} className="sr-only">
                    {t('session.dragHandle.instructions')}
                </p>
                {displayGroups.map((group) => {
                    if (isFlat) {
                        return (
                            <DndContext
                                key={FLAT_DIRECTORY_KEY}
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragStart={handleDragStart}
                                onDragCancel={handleDragCancel}
                                onDragEnd={(event) => {
                                    void handleScopeDragEnd(event, group.sessions)
                                }}
                            >
                                <SortableContext
                                    items={group.sessions.map(session => session.id)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    <div className="flex flex-col divide-y divide-[var(--app-divider)]">
                                        {group.sessions.map((session) => (
                                            <SortableSessionItem
                                                key={session.id}
                                                session={session}
                                                onSelect={handleSessionSelect}
                                                onToggleSelected={toggleSelectedSession}
                                                showPath={false}
                                                projectLabel={getGroupDisplayName(
                                                    session.metadata?.worktree?.basePath
                                                    ?? session.metadata?.path
                                                    ?? 'Other'
                                                )}
                                                api={api}
                                                selected={session.id === selectedSessionId}
                                                selectionMode={selectionMode}
                                                selectedForBulk={selectedSessionIds.has(session.id)}
                                                unread={unreadSessionIds.has(session.id)}
                                                dndEnabled={dndEnabled}
                                                dragInstructionsId={dragInstructionsId}
                                                dragInProgress={dragInProgress}
                                            />
                                        ))}
                                    </div>
                                </SortableContext>
                            </DndContext>
                        )
                    }

                    const isCollapsed = isGroupCollapsed(group)
                    const canQuickCreateInGroup = group.directory !== 'Other'
                    const groupMachineId = group.machineId ?? group.sessions[0]?.metadata?.machineId
                    const groupMachineName = groupMachineId ? machineNames?.get(groupMachineId) : undefined
                    const groupUnreadCount = group.sessions.filter(session => unreadSessionIds.has(session.id)).length
                    return (
                        <div key={group.key}>
                            <div data-group-header={group.directory} className="sticky top-0 z-10 flex items-center gap-1 border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-3 py-2">
                                <button
                                    type="button"
                                    onClick={() => toggleGroup(group.key, isCollapsed)}
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:bg-[var(--app-secondary-bg)]"
                                    aria-expanded={!isCollapsed}
                                >
                                    <ChevronIcon
                                        className="h-4 w-4 text-[var(--app-hint)]"
                                        collapsed={isCollapsed}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium text-base break-words" title={group.directory}>
                                                {group.displayName}
                                            </span>
                                            <span className="shrink-0 text-xs text-[var(--app-hint)]">
                                                ({group.sessions.length})
                                            </span>
                                            {groupUnreadCount > 0 ? (
                                                <span className="shrink-0 text-xs text-[#34C759]">
                                                    {groupUnreadCount} {t('session.item.unread')}
                                                </span>
                                            ) : null}
                                        </div>
                                        {groupMachineName ? (
                                            <div className="text-xs text-[var(--app-hint)] truncate">
                                                {groupMachineName}
                                            </div>
                                        ) : null}
                                    </div>
                                </button>
                                {canQuickCreateInGroup ? (
                                    <button
                                        type="button"
                                        onClick={() => props.onNewSession({
                                            directory: group.directory,
                                            machineId: groupMachineId
                                        })}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                                        title={`${t('sessions.new')}: ${group.directory}`}
                                        aria-label={`${t('sessions.new')}: ${group.directory}`}
                                    >
                                        <PlusIcon className="h-4 w-4" />
                                    </button>
                                ) : null}
                            </div>
                            {!isCollapsed ? (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragStart={handleDragStart}
                                    onDragCancel={handleDragCancel}
                                    onDragEnd={(event) => {
                                        void handleScopeDragEnd(event, group.sessions)
                                    }}
                                >
                                    <SortableContext
                                        items={group.sessions.map(session => session.id)}
                                        strategy={verticalListSortingStrategy}
                                    >
                                        <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)]">
                                            {group.sessions.map((session) => (
                                                <SortableSessionItem
                                                    key={session.id}
                                                    session={session}
                                                    onSelect={handleSessionSelect}
                                                    onToggleSelected={toggleSelectedSession}
                                                    showPath={false}
                                                    api={api}
                                                    selected={session.id === selectedSessionId}
                                                    selectionMode={selectionMode}
                                                    selectedForBulk={selectedSessionIds.has(session.id)}
                                                    unread={unreadSessionIds.has(session.id)}
                                                    dndEnabled={dndEnabled}
                                                    dragInstructionsId={dragInstructionsId}
                                                    dragInProgress={dragInProgress}
                                                />
                                            ))}
                                        </div>
                                    </SortableContext>
                                </DndContext>
                            ) : null}
                        </div>
                    )
                })}
            </div>

            <ConfirmDialog
                isOpen={bulkDeleteOpen}
                onClose={() => setBulkDeleteOpen(false)}
                title={t('dialog.delete.selected.title')}
                description={bulkDeleteDescription}
                confirmLabel={t('dialog.delete.selected.confirm')}
                confirmingLabel={t('dialog.delete.selected.confirming')}
                onConfirm={handleBulkDelete}
                isPending={isBulkDeleting}
                destructive
            />
        </div>
    )
}
