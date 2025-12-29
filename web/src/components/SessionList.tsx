import { useMemo, useState } from 'react'
import type { SessionSummary } from '@/types/api'

type SessionGroup = {
    directory: string
    displayName: string
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

function groupSessionsByDirectory(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, SessionSummary[]>()

    sessions.forEach(session => {
        const path = session.metadata?.path ?? 'Other'
        if (!groups.has(path)) {
            groups.set(path, [])
        }
        groups.get(path)!.push(session)
    })

    return Array.from(groups.entries())
        .map(([directory, groupSessions]) => {
            const sortedSessions = [...groupSessions].sort((a, b) => b.updatedAt - a.updatedAt)
            const latestUpdatedAt = groupSessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = groupSessions.some(s => s.active)
            const parts = directory.split('/').filter(Boolean)
            const displayName = parts.length > 0 ? parts[parts.length - 1] : directory

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
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '-rotate-90' : ''}`}
        >
            <polyline points="6 9 12 15 18 9" />
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

function getLastSeenLabel(session: SessionSummary): string | null {
    if (session.active) return null
    const lastSeen = formatRelativeTime(session.activeAt ?? session.updatedAt)
    if (!lastSeen) return null
    return `last seen ${lastSeen}`
}

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
}) {
    const { session: s, onSelect, showPath = true } = props
    return (
        <button
            type="button"
            onClick={() => onSelect(s.id)}
            className="session-list-item flex w-full flex-col gap-1.5 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                    <span
                        className={`h-2 w-2 rounded-full ${s.active ? 'bg-[var(--app-badge-success-text)]' : 'bg-[var(--app-hint)]'}`}
                        aria-hidden="true"
                    />
                    <div className="truncate text-sm font-medium">
                        {getSessionTitle(s)}
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
                </div>
            </div>
            {showPath ? (
                <div className="truncate text-xs text-[var(--app-hint)]">
                    {s.metadata?.path ?? s.id}
                </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--app-hint)]">
                <span>❖ {getAgentLabel(s)}</span>
                <span>model: {getModelLabel(s)}</span>
                {s.metadata?.worktree?.branch ? (
                    <span>worktree: {s.metadata.worktree.branch}</span>
                ) : null}
                {(() => {
                    const lastSeen = getLastSeenLabel(s)
                    if (!lastSeen) return null
                    return <span>{lastSeen}</span>
                })()}
            </div>
        </button>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
}) {
    const { renderHeader = true } = props
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

    const groups = useMemo(
        () => groupSessionsByDirectory(props.sessions),
        [props.sessions]
    )

    const toggleGroup = (directory: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev)
            if (next.has(directory)) {
                next.delete(directory)
            } else {
                next.add(directory)
            }
            return next
        })
    }

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {props.sessions.length} sessions in {groups.length} projects
                    </div>
                    <button
                        type="button"
                        onClick={props.onNewSession}
                        className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                        title="New Session"
                    >
                        <PlusIcon className="h-5 w-5" />
                    </button>
                </div>
            ) : null}

            <div className="flex flex-col">
                {groups.map((group) => {
                    const isCollapsed = collapsedGroups.has(group.directory)
                    return (
                        <div key={group.directory} className="border-b border-[var(--app-divider)]">
                            <button
                                type="button"
                                onClick={() => toggleGroup(group.directory)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--app-secondary-bg)]"
                            >
                                <ChevronIcon
                                    className="h-4 w-4 text-[var(--app-hint)]"
                                    collapsed={isCollapsed}
                                />
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                    {group.hasActiveSession ? (
                                        <span
                                            className="h-2 w-2 rounded-full bg-[var(--app-badge-success-text)]"
                                            aria-hidden="true"
                                        />
                                    ) : null}
                                    <span className="truncate font-medium text-sm">
                                        {group.displayName}
                                    </span>
                                    <span className="text-xs text-[var(--app-hint)]">
                                        ({group.sessions.length})
                                    </span>
                                </div>
                            </button>
                            {!isCollapsed ? (
                                <div className="flex flex-col divide-y divide-[var(--app-divider)]">
                                    {group.sessions.map((s) => (
                                        <SessionItem
                                            key={s.id}
                                            session={s}
                                            onSelect={props.onSelect}
                                            showPath={false}
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
