import { useEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { useSwipeable, type SwipeEventData } from 'react-swipeable'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'

type SessionGroup = {
    key: string
    directory: string
    machineId: string | null
    displayName: string
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
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

function groupSessionsByDirectory(sessions: SessionSummary[]): SessionGroup[] {
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
            const sortedSessions = [...group.sessions].sort((a, b) => {
                const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
                const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = group.sessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
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
                latestUpdatedAt,
                hasActiveSession
            }
        })
        .sort((a, b) => {
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
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
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
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

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
    api: ApiClient | null
    selected?: boolean
}) {
    const { t } = useTranslation()
    const { session: s, onSelect, showPath = true, api, selected = false } = props
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
    const showSwipeUi = isTouch || enableTrackpadSwipe
    const showSwipeAction = showSwipeUi && (isSwiping || swipeOffset < 0)

    const { archiveSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )

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
        if (!enableTrackpadSwipe || isPending) return
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
    return (
        <>
            <div
                {...(isTouch ? swipeHandlers : {})}
                onWheel={enableTrackpadSwipe ? handleTrackpadWheel : undefined}
                className="relative isolate overflow-hidden"
                style={{ touchAction: 'pan-y' }}
            >
                {showSwipeUi ? (
                    <div
                        className="absolute inset-y-0 right-0 -z-10 flex w-28 items-center justify-center bg-red-500/85 transition-opacity duration-100 pointer-events-none"
                        style={{ opacity: showSwipeAction ? 1 : 0 }}
                    >
                        <span className="text-xs font-semibold uppercase tracking-wide text-white">
                            {s.active ? t('session.action.archive') : t('session.action.delete')}
                        </span>
                    </div>
                ) : null}
                <div
                    className={`session-list-item relative z-10 flex w-full select-none ${selected ? 'bg-[var(--app-secondary-bg)] border-l-2 border-[var(--app-link)]' : 'bg-[var(--app-bg)]'}`}
                    style={{
                        WebkitTouchCallout: 'none',
                        transform: showSwipeUi && swipeOffset !== 0 ? `translateX(${swipeOffset}px)` : undefined,
                        transition: showSwipeUi ? (isSwiping ? 'none' : 'transform 150ms ease-out') : undefined
                    }}
                >
                    <button
                        type="button"
                        {...longPressHandlers}
                        className="flex-1 flex flex-col gap-1.5 px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        aria-current={selected ? 'page' : undefined}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
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

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: (opts?: { directory?: string; machineId?: string }) => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    selectedSessionId?: string | null
    machineNames?: Map<string, string>
}) {
    const { t } = useTranslation()
    const { renderHeader = true, api, selectedSessionId, machineNames } = props
    const groups = useMemo(
        () => groupSessionsByDirectory(props.sessions),
        [props.sessions]
    )
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
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownGroups = new Set(groups.map(group => group.key))
            let changed = false
            for (const groupKey of next.keys()) {
                if (!knownGroups.has(groupKey)) {
                    next.delete(groupKey)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [groups])

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('sessions.count', { n: props.sessions.length, m: groups.length })}
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

            <div className="flex flex-col">
                {groups.map((group) => {
                    const isCollapsed = isGroupCollapsed(group)
                    const canQuickCreateInGroup = group.directory !== 'Other'
                    const groupMachineId = group.machineId ?? undefined
                    const groupMachineName = groupMachineId ? machineNames?.get(groupMachineId) : undefined
                    return (
                        <div key={group.key}>
                            <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-3 py-2">
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
                                <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)]">
                                    {group.sessions.map((s) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            showPath={false}
                                            api={api}
                                            selected={s.id === selectedSessionId}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
