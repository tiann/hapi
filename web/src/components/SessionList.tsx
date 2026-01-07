import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { useSwipe } from '@/hooks/useSwipe'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { NotificationSettings, NotificationSettingsButton } from '@/components/NotificationSettings'

type SessionGroup = {
    directory: string
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

function groupSessionsByDirectory(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, SessionSummary[]>()

    sessions.forEach(session => {
        const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
        if (!groups.has(path)) {
            groups.set(path, [])
        }
        groups.get(path)!.push(session)
    })

    return Array.from(groups.entries())
        .map(([directory, groupSessions]) => {
            const sortedSessions = [...groupSessions].sort((a, b) => {
                const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
                const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = groupSessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = groupSessions.some(s => s.active)
            const displayName = getGroupDisplayName(directory)

            return { directory, displayName, sessions: sortedSessions, latestUpdatedAt, hasActiveSession }
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

function TrashIcon(props: { className?: string }) {
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
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
    )
}

function InfoIcon(props: { className?: string }) {
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
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
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

function getModelLabel(session: SessionSummary): string {
    return session.modelMode ?? 'default'
}

function formatRelativeTime(value: number): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return 'just now'
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`
    return new Date(ms).toLocaleDateString()
}

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
    api: ApiClient | null
}) {
    const { session: s, onSelect, showPath = true, api } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )

    // Swipe-to-delete only for inactive sessions
    const canSwipeDelete = !s.active
    const { handlers: swipeHandlers, offset, isRevealed, reset: resetSwipe } = useSwipe({
        enabled: canSwipeDelete,
        threshold: 80,
        onSwipeLeft: () => {
            haptic.impact('light')
        }
    })

    const longPressHandlers = useLongPress({
        onLongPress: () => {
            // Don't trigger menu if mid-swipe
            if (Math.abs(offset) > 10) return
            haptic.impact('medium')
            setMenuOpen(true)
        },
        onClick: () => {
            // Don't select if swiped open - reset instead
            if (isRevealed) {
                resetSwipe()
                return
            }
            onSelect(s.id)
        },
        threshold: 500
    })

    const handleSwipeDelete = () => {
        resetSwipe()
        setDeleteOpen(true)
    }

    const sessionName = getSessionTitle(s)
    const statusDotClass = s.active
        ? (s.thinking ? 'bg-[#007AFF]' : 'bg-[var(--app-badge-success-text)]')
        : 'bg-[var(--app-hint)]'

    return (
        <>
            <div className="relative overflow-hidden">
                {/* Delete action revealed on swipe */}
                {canSwipeDelete && (
                    <button
                        type="button"
                        onClick={handleSwipeDelete}
                        className="absolute inset-y-0 right-0 flex items-center justify-center w-20 bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)] font-medium text-sm"
                        style={{ opacity: Math.min(1, Math.abs(offset) / 40) }}
                    >
                        Delete
                    </button>
                )}

                {/* Main session item - slides on swipe */}
                <div
                    role="button"
                    tabIndex={0}
                    {...longPressHandlers}
                    {...(canSwipeDelete ? swipeHandlers : {})}
                    onClick={(e) => {
                        // Only navigate if the click wasn't on a nested button
                        if ((e.target as HTMLElement).closest('button')) return
                        onSelect(s.id)
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onSelect(s.id)
                        }
                    }}
                    className="session-list-item relative flex w-full flex-col gap-1.5 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none bg-[var(--app-bg)] cursor-pointer"
                    style={{
                        WebkitTouchCallout: 'none',
                        transform: `translateX(${offset}px)`,
                        transition: offset === 0 || Math.abs(offset) === 80 ? 'transform 0.2s ease-out' : 'none'
                    }}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                                <span
                                    className={`h-2 w-2 rounded-full ${statusDotClass}`}
                                />
                            </span>
                            <div className="truncate text-sm font-medium">
                                {sessionName}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 text-xs">
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
                                    pending {s.pendingRequestsCount}
                                </span>
                            ) : null}
                            <span className="text-[var(--app-hint)]">
                                {formatRelativeTime(s.updatedAt)}
                            </span>
                            {/* Info icon - tap to open action menu */}
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    e.preventDefault()
                                    setMenuOpen(true)
                                }}
                                className="p-1 -m-1 text-[var(--app-hint)] opacity-60 hover:opacity-100 active:opacity-100 transition-opacity"
                                title="Session options"
                            >
                                <InfoIcon className="h-4 w-4" />
                            </button>
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
                        <span>model: {getModelLabel(s)}</span>
                        {s.metadata?.worktree?.branch ? (
                            <span>worktree: {s.metadata.worktree.branch}</span>
                        ) : null}
                    </div>
                </div>
            </div>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={s.active}
                onRename={() => setRenameOpen(true)}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
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
                title="Archive Session"
                description={`Are you sure you want to archive "${sessionName}"? This will disconnect the active session.`}
                confirmLabel="Archive"
                confirmingLabel="Archiving..."
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <ConfirmDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title="Delete Session"
                description={`Are you sure you want to delete "${sessionName}"? This action cannot be undone.`}
                confirmLabel="Delete"
                confirmingLabel="Deleting..."
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
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
}) {
    const { renderHeader = true, api } = props
    const groups = useMemo(
        () => groupSessionsByDirectory(props.sessions),
        [props.sessions]
    )
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
    const [bulkDeletePending, setBulkDeletePending] = useState(false)
    const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false)

    // Count inactive sessions for bulk delete
    const inactiveSessions = useMemo(
        () => props.sessions.filter(s => !s.active),
        [props.sessions]
    )
    const isGroupCollapsed = (group: SessionGroup): boolean => {
        const override = collapseOverrides.get(group.directory)
        if (override !== undefined) return override
        return !group.hasActiveSession
    }

    const toggleGroup = (directory: string, isCollapsed: boolean) => {
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(directory, !isCollapsed)
            return next
        })
    }

    useEffect(() => {
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownGroups = new Set(groups.map(group => group.directory))
            let changed = false
            for (const directory of next.keys()) {
                if (!knownGroups.has(directory)) {
                    next.delete(directory)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [groups])

    const handleBulkDelete = async () => {
        if (!api || inactiveSessions.length === 0) return
        setBulkDeletePending(true)
        try {
            // Delete all inactive sessions sequentially
            for (const session of inactiveSessions) {
                await api.deleteSession(session.id)
            }
            props.onRefresh()
        } finally {
            setBulkDeletePending(false)
            setBulkDeleteOpen(false)
        }
    }

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {props.sessions.length} sessions in {groups.length} projects
                    </div>
                    <div className="flex items-center gap-1">
                        <NotificationSettingsButton onClick={() => setNotificationSettingsOpen(true)} />
                        {inactiveSessions.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setBulkDeleteOpen(true)}
                                className="session-list-new-button p-1.5 rounded-full text-[var(--app-badge-error-text)] transition-colors"
                                title={`Clear ${inactiveSessions.length} inactive session${inactiveSessions.length === 1 ? '' : 's'}`}
                            >
                                <TrashIcon className="h-5 w-5" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={props.onNewSession}
                            className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                            title="New Session"
                        >
                            <PlusIcon className="h-5 w-5" />
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="flex flex-col">
                {groups.map((group) => {
                    const isCollapsed = isGroupCollapsed(group)
                    return (
                        <div key={group.directory}>
                            <button
                                type="button"
                                onClick={() => toggleGroup(group.directory, isCollapsed)}
                                className="sticky top-0 z-10 flex w-full items-center gap-2 px-3 py-2 text-left bg-[var(--color-primary-dark)] text-white border-b-2 border-[var(--color-accent)] transition-colors hover:brightness-110"
                            >
                                <ChevronIcon
                                    className="h-4 w-4 text-white/70"
                                    collapsed={isCollapsed}
                                />
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <span className="font-medium text-sm break-words text-white" title={group.directory}>
                                        {group.displayName}
                                    </span>
                                    <span className="shrink-0 text-xs text-white/70">
                                        ({group.sessions.length})
                                    </span>
                                </div>
                            </button>
                            {!isCollapsed ? (
                                <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)]">
                                    {group.sessions.map((s) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            showPath={false}
                                            api={api}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    )
                })}
            </div>

            <ConfirmDialog
                isOpen={bulkDeleteOpen}
                onClose={() => setBulkDeleteOpen(false)}
                title="Clear Inactive Sessions"
                description={`Delete ${inactiveSessions.length} inactive session${inactiveSessions.length === 1 ? '' : 's'}? This action cannot be undone.`}
                confirmLabel="Delete All"
                confirmingLabel="Deleting..."
                onConfirm={handleBulkDelete}
                isPending={bulkDeletePending}
                destructive
            />

            <NotificationSettings
                isOpen={notificationSettingsOpen}
                onClose={() => setNotificationSettingsOpen(false)}
                api={api}
            />
        </div>
    )
}
