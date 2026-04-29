import { useState, useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSession } from '@/hooks/queries/useSession'
import { useMessages } from '@/hooks/queries/useMessages'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { queryKeys } from '@/lib/query-keys'
import { fetchLatestMessages, seedMessageWindowFromSession } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { SessionChat } from '@/components/SessionChat'
import type { ApiClient } from '@/api/client'
import type { SessionSummary, AttachmentMetadata } from '@/types/api'
import './dashboard.css'

// ─── Icons ────────────────────────────────────────────────────────────────────

function PinIcon({ filled }: { filled?: boolean }) {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="17" x2="12" y2="22" />
            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
        </svg>
    )
}

function PlusIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}


function XIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SessionStatus = 'done' | 'thinking' | 'waiting' | 'active' | 'error' | 'archived'

function getSessionStatus(session: SessionSummary): SessionStatus {
    if (!session.active) return 'archived'
    if (session.thinking) return 'thinking'
    if (session.pendingRequestsCount > 0) return 'waiting'  // waiting for user to approve
    return 'active'
}

function getAgentLabel(session: SessionSummary): string {
    const flavor = session.metadata?.flavor ?? 'claude'
    if (flavor === 'codex') return 'Codex'
    if (flavor === 'gemini') return 'Gemini'
    return 'Claude'
}

function getModelLabel(session: SessionSummary): string | null {
    const model = session.model
    if (!model) return null
    // Compact model names
    return model
        .replace(/^claude-/, '')
        .replace(/^gpt-/, 'gpt-')
        .replace(/^gemini-/, '')
        .replace(/-latest$/, '')
        .replace(/-\d{8}$/, '')  // strip date suffixes
        .substring(0, 18)
}

function getProjectName(session: SessionSummary): string {
    const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? ''
    if (!path) return 'Unknown Project'
    const parts = path.split('/')
    return parts[parts.length - 1] || parts[parts.length - 2] || path
}

function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.summary?.text) return session.metadata.summary.text.substring(0, 60)
    return `Session ${session.id.substring(0, 6)}`
}

function groupByProject(sessions: SessionSummary[]): { project: string; sessions: SessionSummary[] }[] {
    const map = new Map<string, SessionSummary[]>()
    for (const s of sessions) {
        const p = getProjectName(s)
        if (!map.has(p)) map.set(p, [])
        map.get(p)!.push(s)
    }
    return [...map.entries()].map(([project, sessions]) => ({ project, sessions }))
}

function formatElapsed(updatedAt: number): string {
    const diff = Date.now() - updatedAt
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
}

// Duration since a timestamp, updated live
function formatDuration(since: number): string {
    const secs = Math.floor((Date.now() - since) / 1000)
    if (secs < 60) return `${secs}s`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ${secs % 60}s`
    return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function getStatusPriority(status: SessionStatus): number {
    const map: Record<SessionStatus, number> = {
        waiting: 0, done: 1, thinking: 2, active: 3, error: 4, archived: 99
    }
    return map[status]
}

// ─── Pinned Panel (wraps full SessionChat, no redirect) ───────────────────────

interface PinnedPanelProps {
    sessionId: string
    api: ApiClient | null
    onUnpin: () => void
    onSessionResolved?: (newSessionId: string) => void
}

function PinnedPanel({ sessionId, api, onUnpin, onSessionResolved }: PinnedPanelProps) {
    const queryClient = useQueryClient()
    const { session, refetch: refetchSession } = useSession(api, sessionId)
    const {
        messages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
        pendingCount,
        messagesVersion,
        flushPending,
        setAtBottom,
    } = useMessages(api, sessionId)

    const agentType = session?.metadata?.flavor ?? 'claude'
    const { commands: slashCommands, getSuggestions: getSlashSuggestions } = useSlashCommands(api, sessionId, agentType)
    const { getSuggestions: getSkillSuggestions } = useSkills(api, sessionId)

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('$')) return await getSkillSuggestions(query)
        return await getSlashSuggestions(query)
    }, [getSkillSuggestions, getSlashSuggestions])

    const { sendMessage, retryMessage, isSending } = useSendMessage(api, sessionId, {
        isSessionThinking: session?.thinking ?? false,
        onSuccess: (sentSessionId) => {
            clearDraftsAfterSend(sentSessionId, sessionId)
        },
        resolveSessionId: async (currentSessionId) => {
            if (!api || !session || session.active) return currentSessionId
            return await api.resumeSession(currentSessionId, {
                permissionMode: session.permissionMode ?? undefined
            })
        },
        onSessionResolved: (resolvedSessionId) => {
            void (async () => {
                if (api && session && resolvedSessionId !== session.id) {
                    seedMessageWindowFromSession(session.id, resolvedSessionId)
                    queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
                        session: { ...session, id: resolvedSessionId, active: true }
                    })
                    try {
                        await Promise.all([
                            queryClient.prefetchQuery({
                                queryKey: queryKeys.session(resolvedSessionId),
                                queryFn: () => api.getSession(resolvedSessionId),
                            }),
                            fetchLatestMessages(api, resolvedSessionId),
                        ])
                    } catch { /* ignore */ }
                }
                // Instead of navigating, notify Dashboard to update pinnedId
                onSessionResolved?.(resolvedSessionId)
            })()
        },
    })

    const refreshSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchSession, refetchMessages])

    if (!session) {
        return (
            <div className="db-pinned db-pinned--loading">
                <div className="db-pinned__log-hint">Loading session…</div>
            </div>
        )
    }

    return (
        <div className="db-pinned">
            <SessionChat
                api={api!}
                session={session}
                messages={messages}
                messagesWarning={messagesWarning}
                hasMoreMessages={messagesHasMore}
                isLoadingMessages={messagesLoading}
                isLoadingMoreMessages={messagesLoadingMore}
                isSending={isSending}
                pendingCount={pendingCount}
                messagesVersion={messagesVersion}
                onBack={onUnpin}
                onRefresh={refreshSession}
                onLoadMore={loadMoreMessages}
                onSend={(text: string, attachments?: AttachmentMetadata[]) => sendMessage(text, attachments)}
                onFlushPending={flushPending}
                onAtBottomChange={setAtBottom}
                onRetryMessage={retryMessage}
                autocompleteSuggestions={getAutocompleteSuggestions}
                availableSlashCommands={slashCommands}
            />
        </div>
    )
}

// ─── Session Card ─────────────────────────────────────────────────────────────

interface SessionCardProps {
    session: SessionSummary
    status: SessionStatus
    isPinned: boolean
    compact?: boolean
    isAddedArchived?: boolean
    onSelect: () => void
    onDetach?: () => void
}

function SessionCard({ session, status, isPinned, compact, isAddedArchived, onSelect, onDetach }: SessionCardProps) {
    const agent = getAgentLabel(session)
    const elapsed = formatElapsed(session.updatedAt)
    const title = getSessionTitle(session)
    const todoProgress = session.todoProgress
    const modelLabel = getModelLabel(session)
    const branchName = session.metadata?.worktree?.name ?? null
    const effort = session.effort

    // Live ticker for thinking duration
    const [, tick] = useState(0)
    useEffect(() => {
        if (status !== 'thinking') return
        const id = setInterval(() => tick(n => n + 1), 1000)
        return () => clearInterval(id)
    }, [status])
    // Time since last request (updatedAt ~ when thinking started)
    const requestDuration = status === 'thinking' ? formatDuration(session.updatedAt) : null
    // Total session run time
    const sessionDuration = status === 'thinking' ? formatDuration(session.activeAt) : null

    return (
        <div
            className={[
                'db-card',
                `db-card--${status}`,
                isPinned ? 'db-card--pinned' : '',
                compact ? 'db-card--compact' : '',
                isAddedArchived ? 'db-card--archived-added' : '',
            ].filter(Boolean).join(' ')}
            onClick={onSelect}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }}
            title={isPinned ? 'Click to unpin' : 'Click to pin & chat'}
        >
            <div className={`db-card__glow-bar db-card__glow-bar--${status}`} />

            {isAddedArchived && onDetach && (
                <button
                    type="button"
                    className="db-card__detach"
                    onClick={e => { e.stopPropagation(); onDetach() }}
                    title="Remove from dashboard"
                >
                    <XIcon />
                </button>
            )}

            {/* Header: title + elapsed */}
            <div className="db-card__header">
                <div className="db-card__title">{title}</div>
                <div className="db-card__meta-row">
                    {isPinned && <span className="db-card__pin-icon"><PinIcon filled /></span>}
                    <span className="db-card__elapsed">{elapsed}</span>
                </div>
            </div>

            {/* Status area — not shown in compact mode */}
            {!compact && (
                <div className="db-card__status-area">
                    {status === 'thinking' && (
                        <div className="db-card__thinking">
                            <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
                            <span className="db-card__thinking-label">Thinking</span>
                            {requestDuration && (
                                <span className="db-card__thinking-dur" title="Time since request sent">
                                    {requestDuration}
                                </span>
                            )}
                            {sessionDuration && sessionDuration !== requestDuration && (
                                <span className="db-card__thinking-total" title="Total session run time">
                                    / {sessionDuration}
                                </span>
                            )}
                        </div>
                    )}
                    {status === 'waiting' && (
                        <span className="db-status-badge db-status-badge--waiting">⚠ Waiting</span>
                    )}
                    {status === 'done' && <span className="db-status-badge db-status-badge--done">✓ Done</span>}
                    {status === 'error' && <span className="db-status-badge db-status-badge--error">✕ Error</span>}
                    {status === 'archived' && <span className="db-status-badge db-status-badge--archived">Archived</span>}
                </div>
            )}

            {/* Footer: badges row */}
            <div className="db-card__footer">
                <span className={`db-card__agent db-card__agent--${session.metadata?.flavor ?? 'claude'}`}>{agent}</span>
                {modelLabel && !compact && (
                    <span className="db-card__model">{modelLabel}</span>
                )}
                {branchName && !compact && (
                    <span className="db-card__branch">⎇ {branchName}</span>
                )}
                {effort && !compact && (
                    <span className="db-card__effort">{effort}</span>
                )}
                {todoProgress && (
                    <span className="db-card__todo">
                        {todoProgress.completed}/{todoProgress.total}
                    </span>
                )}
                <span className={`db-card__dot db-card__dot--${status}`} />
            </div>
        </div>
    )
}

// ─── Archived Sessions Modal ──────────────────────────────────────────────────

interface ArchivedModalProps {
    archivedSessions: SessionSummary[]
    addedIds: Set<string>
    onAdd: (ids: string[]) => void
    onClose: () => void
}

function ArchivedModal({ archivedSessions, addedIds, onAdd, onClose }: ArchivedModalProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set())
    // Which project groups are collapsed (default: all expanded)
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

    const eligible = archivedSessions.filter(s => !addedIds.has(s.id))
    const groups = groupByProject(archivedSessions)

    const toggleOne = useCallback((id: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }, [])

    const toggleAll = useCallback(() => {
        const eligibleIds = eligible.map(s => s.id)
        setSelected(prev => prev.size === eligibleIds.length ? new Set() : new Set(eligibleIds))
    }, [eligible])

    const toggleGroup = useCallback((project: string, groupSessions: SessionSummary[]) => {
        const eligibleInGroup = groupSessions.filter(s => !addedIds.has(s.id)).map(s => s.id)
        setSelected(prev => {
            const next = new Set(prev)
            const allChecked = eligibleInGroup.every(id => next.has(id))
            if (allChecked) {
                eligibleInGroup.forEach(id => next.delete(id))
            } else {
                eligibleInGroup.forEach(id => next.add(id))
            }
            return next
        })
    }, [addedIds])

    const toggleCollapse = useCallback((project: string) => {
        setCollapsed(prev => {
            const next = new Set(prev)
            if (next.has(project)) next.delete(project)
            else next.add(project)
            return next
        })
    }, [])

    const handleAdd = useCallback(() => {
        onAdd([...selected])
        onClose()
    }, [selected, onAdd, onClose])

    const allEligibleSelected = eligible.length > 0 && selected.size === eligible.length

    return (
        <div className="db-modal-overlay" onClick={onClose}>
            <div className="db-modal" onClick={e => e.stopPropagation()}>
                <div className="db-modal__header">
                    <div>
                        <div className="db-modal__title">Archived Sessions</div>
                        <div className="db-modal__sub">{archivedSessions.length} sessions · Select to add to dashboard</div>
                    </div>
                    <button type="button" className="db-pinned__unpin" onClick={onClose}><XIcon /></button>
                </div>

                {eligible.length > 0 && (
                    <div className="db-modal__select-all">
                        <label className="db-modal__check-row">
                            <input
                                type="checkbox"
                                checked={allEligibleSelected}
                                onChange={toggleAll}
                            />
                            <span>Select all ({eligible.length})</span>
                        </label>
                    </div>
                )}

                <div className="db-modal__list">
                    {archivedSessions.length === 0 && (
                        <div className="db-modal__empty">No archived sessions</div>
                    )}
                    {groups.map(({ project, sessions: groupSessions }) => {
                        const eligibleInGroup = groupSessions.filter(s => !addedIds.has(s.id))
                        const checkedInGroup = eligibleInGroup.filter(s => selected.has(s.id))
                        const allGroupSelected = eligibleInGroup.length > 0 && checkedInGroup.length === eligibleInGroup.length
                        const someGroupSelected = checkedInGroup.length > 0 && !allGroupSelected
                        const isCollapsed = collapsed.has(project)

                        return (
                            <div key={project} className="db-modal__group">
                                {/* Group header */}
                                <div className="db-modal__group-header">
                                    <label className="db-modal__group-check" onClick={e => e.stopPropagation()}>
                                        <input
                                            type="checkbox"
                                            checked={allGroupSelected}
                                            ref={el => { if (el) el.indeterminate = someGroupSelected }}
                                            disabled={eligibleInGroup.length === 0}
                                            onChange={() => toggleGroup(project, groupSessions)}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className="db-modal__group-toggle"
                                        onClick={() => toggleCollapse(project)}
                                    >
                                        <span className={`db-modal__group-chevron ${isCollapsed ? 'db-modal__group-chevron--collapsed' : ''}`}>›</span>
                                        <span className="db-modal__group-name">{project}</span>
                                        <span className="db-modal__group-count">{groupSessions.length}</span>
                                        {checkedInGroup.length > 0 && (
                                            <span className="db-modal__group-selected">{checkedInGroup.length} selected</span>
                                        )}
                                    </button>
                                </div>

                                {/* Group rows */}
                                {!isCollapsed && groupSessions.map(s => {
                                    const isAdded = addedIds.has(s.id)
                                    const isChecked = selected.has(s.id)
                                    const title = getSessionTitle(s)
                                    const agent = getAgentLabel(s)
                                    const elapsed = formatElapsed(s.updatedAt)
                                    return (
                                        <label
                                            key={s.id}
                                            className={`db-modal__row db-modal__row--indented ${isAdded ? 'db-modal__row--added' : ''}`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={isChecked || isAdded}
                                                disabled={isAdded}
                                                onChange={() => !isAdded && toggleOne(s.id)}
                                            />
                                            <div className="db-modal__row-info">
                                                <span className="db-modal__row-project">{title}</span>
                                                <span className="db-modal__row-meta">
                                                    <span className={`db-card__agent db-card__agent--${s.metadata?.flavor ?? 'claude'}`}>{agent}</span>
                                                    <span style={{ opacity: 0.5, fontSize: 10 }}>{elapsed}</span>
                                                    {isAdded && <span className="db-modal__added-badge">Added</span>}
                                                </span>
                                            </div>
                                        </label>
                                    )
                                })}
                            </div>
                        )
                    })}
                </div>

                <div className="db-modal__footer">
                    <button type="button" className="db-modal__cancel" onClick={onClose}>Cancel</button>
                    <button
                        type="button"
                        className="db-modal__confirm"
                        disabled={selected.size === 0}
                        onClick={handleAdd}
                    >
                        Add {selected.size > 0 ? `${selected.size} session${selected.size > 1 ? 's' : ''}` : 'sessions'}
                    </button>
                </div>
            </div>
        </div>
    )
}

// ─── Add Card ─────────────────────────────────────────────────────────────────

function AddArchivedCard({ archivedCount, addedCount, onClick }: { archivedCount: number; addedCount: number; onClick: () => void }) {
    const label = archivedCount > 0
        ? `+ ${archivedCount} archived${addedCount > 0 ? ` · ${addedCount} shown` : ''}`
        : 'No archived sessions'
    return (
        <button type="button" className="db-card db-card--add" onClick={onClick} disabled={archivedCount === 0}>
            <PlusIcon />
            <span>{label}</span>
        </button>
    )
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

interface DashboardProps {
    api: ApiClient | null
    initialPinnedId?: string | null
}

export function Dashboard({ api, initialPinnedId }: DashboardProps) {
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const { sessions, isLoading } = useSessions(api)
    const [showArchived, setShowArchived] = useState(false)
    // IDs of archived sessions the user has added to the dashboard
    const [addedArchivedIds, setAddedArchivedIds] = useState<Set<string>>(new Set())

    // B: Filter by session status — persist to localStorage, default 'active'
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>(() => {
        const saved = localStorage.getItem('dashboard-status-filter')
        return (saved === 'all' || saved === 'active' || saved === 'archived') ? saved : 'active'
    })
    useEffect(() => {
        localStorage.setItem('dashboard-status-filter', statusFilter)
    }, [statusFilter])

    // A: Inline confirm state (replaces window.confirm)
    const [pendingConfirm, setPendingConfirm] = useState<{
        project: string
        action: 'archive' | 'delete'
        targetSessions: SessionSummary[]
    } | null>(null)

    // URL is the single source of truth for pinnedId
    const pinnedId = initialPinnedId ?? null

    // Compute statuses for ALL sessions
    const statuses = new Map<string, SessionStatus>()
    for (const s of sessions) {
        statuses.set(s.id, getSessionStatus(s))
    }

    const activeSessions = sessions.filter(s => s.active)
    const archivedSessions = sessions.filter(s => !s.active)

    // B: Apply status filter, C: sort by priority then updatedAt desc
    const visibleSessions = [...sessions]
        .filter(s => {
            if (statusFilter === 'active') return s.active
            if (statusFilter === 'archived') return !s.active
            return true
        })
        .sort((a, b) => {
            const pa = getStatusPriority(statuses.get(a.id) ?? 'active')
            const pb = getStatusPriority(statuses.get(b.id) ?? 'active')
            // C: same priority → newer first
            return pa !== pb ? pa - pb : b.updatedAt - a.updatedAt
        })
    const projectGroups = groupByProject(visibleSessions)

    // Pinned session lookup across ALL sessions (including archived)
    const pinnedSession = pinnedId ? sessions.find(s => s.id === pinnedId) ?? null : null

    const handlePin = useCallback((sessionId: string) => {
        const next = pinnedId === sessionId ? null : sessionId
        if (next) {
            void navigate({ to: '/sessions', search: (prev) => ({ ...prev, sessionId: next }) })
        } else {
            void navigate({ to: '/sessions', search: (prev) => ({ ...prev, sessionId: undefined }) })
        }
    }, [navigate, pinnedId])

    const handleUnpin = useCallback(() => {
        void navigate({ to: '/sessions', search: (prev) => ({ ...prev, sessionId: undefined }) })
    }, [navigate])

    const handleAddArchived = useCallback((ids: string[]) => {
        setAddedArchivedIds(prev => new Set([...prev, ...ids]))
    }, [])

    const handleDetach = useCallback((sessionId: string) => {
        setAddedArchivedIds(prev => {
            const next = new Set(prev)
            next.delete(sessionId)
            return next
        })
        if (pinnedId === sessionId) {
            void navigate({ to: '/sessions', search: (prev) => ({ ...prev, sessionId: undefined }) })
        }
    }, [navigate, pinnedId])

    // Stats for topbar
    const thinkingCount = [...statuses.values()].filter(s => s === 'thinking').length
    const doneCount = [...statuses.values()].filter(s => s === 'done').length

    const isPinned = pinnedId !== null
    const unarchivedCount = archivedSessions.length - addedArchivedIds.size


    // A: Bulk group actions — request confirm (no window.confirm)
    const handleRequestArchiveAll = useCallback((project: string, groupSessions: SessionSummary[]) => {
        const active = groupSessions.filter(s => s.active)
        if (!api || active.length === 0) return
        setPendingConfirm({ project, action: 'archive', targetSessions: active })
    }, [api])

    const handleRequestDeleteAll = useCallback((project: string, groupSessions: SessionSummary[]) => {
        const archived = groupSessions.filter(s => !s.active)
        if (!api || archived.length === 0) return
        setPendingConfirm({ project, action: 'delete', targetSessions: archived })
    }, [api])

    const handleExecuteConfirm = useCallback(async () => {
        if (!api || !pendingConfirm) return
        const { action, targetSessions } = pendingConfirm
        setPendingConfirm(null)
        if (action === 'archive') {
            await Promise.allSettled(targetSessions.map(s => api.archiveSession(s.id)))
        } else {
            await Promise.allSettled(targetSessions.map(s => api.deleteSession(s.id)))
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }, [api, pendingConfirm, queryClient])

    const handleCopyPath = useCallback((project: string, groupSessions: SessionSummary[]) => {
        const path = groupSessions[0]?.metadata?.worktree?.basePath ?? groupSessions[0]?.metadata?.path ?? project
        void navigator.clipboard.writeText(path)
    }, [])

    const handleNewInGroup = useCallback((groupSessions: SessionSummary[]) => {
        const path = groupSessions[0]?.metadata?.worktree?.basePath ?? groupSessions[0]?.metadata?.path
        void navigate({ to: '/sessions/new', search: path ? { directory: path } : {} })
    }, [navigate])

    return (
        <div className="db">
            {/* Top bar */}
            <div className="db__topbar">
                <div className="db__topbar-left">
                    <h1 className="db__title">Mission Control</h1>
                    <div className="db__stats">
                        {thinkingCount > 0 && (
                            <span className="db__stat db__stat--thinking">
                                <span className="thinking-dot thinking-dot--sm" /> {thinkingCount} running
                            </span>
                        )}
                        {doneCount > 0 && (
                            <span className="db__stat db__stat--done">✓ {doneCount} done</span>
                        )}
                        <span className="db__stat">{visibleSessions.length} sessions</span>
                    </div>
                </div>
                <div className="db__topbar-actions">
                    <button
                        type="button"
                        className="db__topbar-btn"
                        title="Browse workspace"
                        onClick={() => void navigate({ to: '/browse' })}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        <span className="db__label">Browse</span>
                    </button>
                    <button
                        type="button"
                        className="db__topbar-btn"
                        title="Settings"
                        onClick={() => void navigate({ to: '/settings' })}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        <span className="db__label">Settings</span>
                    </button>
                    <button
                        type="button"
                        className="db__topbar-btn db__topbar-btn--primary"
                        title="New session"
                        onClick={() => void navigate({ to: '/sessions/new' })}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        <span className="db__label">New Session</span>
                    </button>
                    {isPinned && (
                        <button type="button" className="db__unpin-all" onClick={handleUnpin}>
                            <XIcon /> Unpin
                        </button>
                    )}
                </div>
            </div>

            {/* B: Filter bar */}
            <div className="db__filter-bar">
                <button
                    type="button"
                    className={`db__filter-btn ${statusFilter === 'all' ? 'db__filter-btn--active' : ''}`}
                    onClick={() => setStatusFilter('all')}
                >
                    All
                    <span className="db__filter-count">{sessions.length}</span>
                </button>
                <button
                    type="button"
                    className={`db__filter-btn ${statusFilter === 'active' ? 'db__filter-btn--active' : ''}`}
                    onClick={() => setStatusFilter('active')}
                >
                    Active
                    <span className="db__filter-count">{activeSessions.length}</span>
                </button>
                <button
                    type="button"
                    className={`db__filter-btn ${statusFilter === 'archived' ? 'db__filter-btn--active' : ''}`}
                    onClick={() => setStatusFilter('archived')}
                >
                    Archived
                    <span className="db__filter-count">{archivedSessions.length}</span>
                </button>
            </div>

            {/* Main content: single unified layout */}
            <div className={`db__content ${isPinned ? 'db__content--split' : 'db__content--grid'}`}>

                {/* Pinned panel — shown on the left when a session is pinned */}
                {isPinned && pinnedSession && (
                    <PinnedPanel
                        key={pinnedSession.id}
                        sessionId={pinnedSession.id}
                        api={api}
                        onUnpin={handleUnpin}
                        onSessionResolved={(newId) => void navigate({ to: '/sessions', search: (prev) => ({ ...prev, sessionId: newId }) })}
                    />
                )}

                {/* Grid of session cards — always visible, shrinks to sidebar when pinned */}
                <div className={`db__grid-area ${isPinned ? 'db__grid-area--sidebar' : ''}`}>
                    {isLoading && <div className="db__loading">Loading sessions…</div>}

                    {!isLoading && visibleSessions.length === 0 && !isPinned && (
                        <div className="db__empty">
                            <p>No active sessions</p>
                            <p style={{ fontSize: 12, opacity: 0.5, marginTop: 4 }}>
                                Start a session from the Sessions tab
                            </p>
                        </div>
                    )}

                    <div className={`db__groups ${isPinned ? 'db__groups--compact' : ''}`}>
                        {projectGroups.map(({ project, sessions: groupSessions }) => (
                            <div key={project} className="db__group">
                                {!isPinned && (
                                    <div className="db__group-header">
                                        <div className="db__group-header-left">
                                            <span className="db__group-name">{project}</span>
                                            <span className="db__group-count">{groupSessions.length}</span>
                                        </div>
                                        <div className="db__group-actions">
                                            <button
                                                type="button"
                                                className="db__group-action"
                                                title={`New session in ${project}`}
                                                onClick={() => handleNewInGroup(groupSessions)}
                                            >
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                                <span className="db__label">New</span>
                                            </button>
                                            <button
                                                type="button"
                                                className="db__group-action"
                                                title="Copy project path"
                                                onClick={() => handleCopyPath(project, groupSessions)}
                                            >
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                                <span className="db__label">Copy Path</span>
                                            </button>
                                            {/* A: Inline confirm OR action buttons */}
                                            {pendingConfirm?.project === project ? (
                                                <div className={`db__inline-confirm ${pendingConfirm.action === 'delete' ? 'db__inline-confirm--danger' : ''}`}>
                                                    <span className="db__inline-confirm-text">
                                                        {pendingConfirm.action === 'archive'
                                                            ? `Archive ${pendingConfirm.targetSessions.length} session(s)?`
                                                            : `Delete ${pendingConfirm.targetSessions.length} archived session(s)?`
                                                        }
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="db__inline-confirm-yes"
                                                        onClick={() => void handleExecuteConfirm()}
                                                    >
                                                        Confirm
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="db__inline-confirm-no"
                                                        onClick={() => setPendingConfirm(null)}
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <>
                                                    {groupSessions.some(s => s.active) && (
                                                        <button
                                                            type="button"
                                                            className="db__group-action db__group-action--warning"
                                                            title="Archive all active sessions in this group"
                                                            onClick={() => handleRequestArchiveAll(project, groupSessions)}
                                                        >
                                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                                                            <span className="db__label">Archive All</span>
                                                        </button>
                                                    )}
                                                    {groupSessions.some(s => !s.active) && (
                                                        <button
                                                            type="button"
                                                            className="db__group-action db__group-action--danger"
                                                            title="Delete all archived sessions in this group"
                                                            onClick={() => handleRequestDeleteAll(project, groupSessions)}
                                                        >
                                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                                                            <span className="db__label">Delete Archived</span>
                                                        </button>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                                <div className={`db__grid ${isPinned ? 'db__grid--compact' : ''}`}>
                                    {groupSessions.map(session => {
                                        const isArchived = statuses.get(session.id) === 'archived'
                                        return (
                                            <SessionCard
                                                key={session.id}
                                                session={session}
                                                status={statuses.get(session.id) ?? 'archived'}
                                                isPinned={session.id === pinnedId}
                                                compact={isPinned}
                                                isAddedArchived={isArchived}
                                                onSelect={() => handlePin(session.id)}
                                            />
                                        )
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

        </div>
    )
}
