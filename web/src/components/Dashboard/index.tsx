import { useState, useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { RootSearch } from '@/router'
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
import { useTranslation } from '@/lib/use-translation'
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
    // Priority: user/agent-set name > AI summary > last user request (truncated) > session ID
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.summary?.text) return session.metadata.summary.text.substring(0, 60)
    if (session.metadata?.lastUserRequest) return session.metadata.lastUserRequest.substring(0, 60)
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
    pinIndex: number      // 1-based display index
    compact?: boolean     // true when 3-4 panels (collapse mode)
    isActive?: boolean
    onFocus?: () => void
}

function PinnedPanel({ sessionId, api, onUnpin, onSessionResolved, pinIndex, compact, isActive, onFocus }: PinnedPanelProps) {
    const { t } = useTranslation()
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
                <div className="db-pinned__log-hint">{t('dashboard.loading')}</div>
            </div>
        )
    }

    return (
        <div 
            className={`db-pinned db-pinned--compact ${isActive ? 'db-pinned--active' : ''}`}
            onFocus={onFocus}
            onClick={onFocus}
            onFocusCapture={onFocus}
        >
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
                disableVoice
                compactMode={true}
                pinIndex={pinIndex}
            />

        </div>
    )
}

// ─── Session Card ─────────────────────────────────────────────────────────────

interface SessionCardProps {
    session: SessionSummary
    status: SessionStatus
    isPinned: boolean
    pinIndex?: number     // 1-based index if pinned
    pinDisabled?: boolean
    compact?: boolean
    isAddedArchived?: boolean
    isHighlighted?: boolean
    onSelect: (e?: React.MouseEvent) => void
    onDetach?: () => void
    onFocusCapture?: () => void
}

function SessionCard({ session, status, isPinned, pinIndex, pinDisabled, compact, isAddedArchived, isHighlighted, onSelect, onDetach, onFocusCapture }: SessionCardProps) {
    const { t } = useTranslation()
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

    const requestDuration = status === 'thinking' ? formatDuration(session.updatedAt) : null
    const sessionDuration = status === 'thinking' ? formatDuration(session.activeAt) : null

    return (
        <div
            className={[
                'db-card',
                `db-card--${status}`,
                isPinned ? 'db-card--pinned' : '',
                compact ? 'db-card--compact' : '',
                isAddedArchived ? 'db-card--archived-added' : '',
                isHighlighted ? 'ring-2 ring-[var(--app-button)]' : ''
            ].filter(Boolean).join(' ')}
            onClick={(e) => onSelect(e)}
            role="button"
            tabIndex={0}
            onFocusCapture={onFocusCapture}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }}
            title={isPinned ? t('dashboard.clickToUnpin') : t('dashboard.clickToPin')}
        >
            <div className={`db-card__glow-bar db-card__glow-bar--${status}`} />

            {/* Pin index badge — shown when card is pinned */}
            {isPinned && pinIndex !== undefined && (
                <span className="db-card__pin-index">{pinIndex}</span>
            )}

            {isAddedArchived && onDetach && (
                <button
                    type="button"
                    className="db-card__detach"
                    onClick={e => { e.stopPropagation(); onDetach() }}
                    title={t('dashboard.removeFromDashboard')}
                >
                    <XIcon />
                </button>
            )}

            {/* Header: title + elapsed */}
            <div className="db-card__header">
                <div className="db-card__title">{title}</div>
                <div className="db-card__meta-row">
                    <button
                        type="button"
                        className={`db-card__pin-btn ${isPinned ? 'db-card__pin-btn--active' : ''}`}
                        onClick={e => { e.stopPropagation(); onSelect(e) }}
                        title={isPinned ? t('dashboard.unpinSession') : t('dashboard.pinSession')}
                    >
                        <PinIcon filled={isPinned} />
                    </button>
                    <span className="db-card__elapsed">{elapsed}</span>
                </div>
            </div>

            {/* Status area — not shown in compact mode */}
            {!compact && (
                <div className="db-card__status-area">
                    {status === 'thinking' && (
                        <div className="db-card__thinking">
                            <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
                            <span className="db-card__thinking-label">{t('dashboard.thinking')}</span>
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
                        <span className="db-status-badge db-status-badge--waiting">{t('dashboard.waiting')}</span>
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

// ─── Pinned Session Context Menu ──────────────────────────────────────────────

interface PinnedSessionContextMenuProps {
    sessionTitle: string
    x: number
    y: number
    onFocus: () => void
    onUnpin: () => void
    onCancel: () => void
}

function PinnedSessionContextMenu({ sessionTitle, x, y, onFocus, onUnpin, onCancel }: PinnedSessionContextMenuProps) {
    const { t } = useTranslation()
    const menuRef = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState({ left: x, top: y })

    useEffect(() => {
        if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect()
            let newX = x
            let newY = y
            if (x + rect.width > window.innerWidth) newX = window.innerWidth - rect.width - 10
            if (y + rect.height > window.innerHeight) newY = window.innerHeight - rect.height - 10
            setPos({ left: newX, top: newY })
        }
    }, [x, y])

    useEffect(() => {
        const handleClickOutside = () => onCancel()
        const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 10)
        return () => {
            clearTimeout(timer)
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [onCancel])

    return (
        <div 
            ref={menuRef}
            className="db__context-menu" 
            style={{ 
                position: 'fixed', 
                left: pos.left, 
                top: pos.top, 
                zIndex: 9999, 
                background: 'var(--app-bg)', 
                border: '1px solid var(--app-border)', 
                borderRadius: 6, 
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 160,
                padding: '4px 0'
            }}
            onMouseDown={e => e.stopPropagation()} 
        >
            <div style={{ padding: '8px 12px', fontSize: 12, opacity: 0.5, borderBottom: '1px solid var(--app-border)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {sessionTitle}
            </div>
            <button 
                type="button"
                style={{ textAlign: 'left', padding: '8px 12px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13 }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--app-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={onFocus}
            >
                {t('dashboard.focus')}
            </button>
            <button 
                type="button"
                style={{ textAlign: 'left', padding: '8px 12px', background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 13 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={onUnpin}
            >
                {t('dashboard.unpinSession')}
            </button>
        </div>
    )
}

// ─── Replace Pin Modal ────────────────────────────────────────────────────────

interface ReplacePinModalProps {
    sessionToPinId: string
    pinnedSessions: SessionSummary[]
    onReplace: (oldId: string) => void
    onCancel: () => void
}

function ReplacePinModal({ sessionToPinId, pinnedSessions, onReplace, onCancel }: ReplacePinModalProps) {
    const { t } = useTranslation()
    return (
        <div className="db-modal-overlay" onClick={onCancel}>
            <div className="db-modal" onClick={e => e.stopPropagation()}>
                <div className="db-modal__header">
                    <h2 className="db-modal__title">{t('dashboard.replacePinTitle')}</h2>
                    <button type="button" className="db-modal__close" onClick={onCancel}>
                        <XIcon />
                    </button>
                </div>
                <div className="db-modal__body">
                    <p style={{ fontSize: 13, color: 'var(--app-hint)', marginBottom: 12, lineHeight: 1.5 }}>
                        {t('dashboard.replacePinBody')}
                    </p>
                    <div className="db__replace-pin-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {pinnedSessions.map((session, idx) => (
                            <button
                                key={session.id}
                                type="button"
                                className="db__pin-tab"
                                style={{ width: '100%', justifyContent: 'flex-start', padding: '10px 12px' }}
                                onClick={() => onReplace(session.id)}
                            >
                                <span className="db__pin-tab-index" style={{ opacity: 0.5, marginRight: 8, fontWeight: 600 }}>{idx + 1}</span>
                                <span className="db__pin-tab-title">{getSessionTitle(session)}</span>
                            </button>
                        ))}
                    </div>
                </div>
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

const MAX_PINS = 4
const LS_PINS_KEY = 'mc-pinned-ids'

interface DashboardProps {
    api: ApiClient | null
    initialPinnedIds: string[]
}

export function Dashboard({ api, initialPinnedIds }: DashboardProps) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const search = useSearch({ strict: false }) as RootSearch
    const modalNewSessionId = search.modalNewSessionId
    const { sessions, isLoading } = useSessions(api)
    const [addedArchivedIds, setAddedArchivedIds] = useState<Set<string>>(new Set())
    const [showOverviewDrawer, setShowOverviewDrawer] = useState(false)
    const [activePinIndex, setActivePinIndex] = useState(0)
    const [pendingReplacePin, setPendingReplacePin] = useState<string | null>(null)
    const [pinnedAction, setPinnedAction] = useState<{ id: string, x: number, y: number } | null>(null)

    // ── Inline confirm ────────────────────────────────────────────────────────
    const [pendingConfirm, setPendingConfirm] = useState<{
        project: string
        action: 'archive' | 'delete'
        targetSessions: SessionSummary[]
    } | null>(null)

    // ── Pinned IDs — URL is source of truth, localStorage is secondary ────────
    const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
        // URL takes priority
        if (initialPinnedIds.length > 0) return initialPinnedIds.slice(0, MAX_PINS)
        // Fallback to localStorage
        try {
            const saved = localStorage.getItem(LS_PINS_KEY)
            if (saved) return (JSON.parse(saved) as string[]).slice(0, MAX_PINS)
        } catch { /* ignore */ }
        return []
    })

    // Sync initialPinnedIds → pinnedIds when URL changes (e.g. after modal navigation)
    // This is needed because useState only reads initialPinnedIds once on mount.
    // When the modal navigates to /sessions?pins=..., the prop changes but state doesn't.
    useEffect(() => {
        const incoming = initialPinnedIds.join(',')
        const current = pinnedIds.join(',')
        if (incoming !== current && incoming !== '') {
            setPinnedIds(initialPinnedIds.slice(0, MAX_PINS))
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialPinnedIds.join(',')])

    // Sync pinnedIds → URL + localStorage
    useEffect(() => {
        localStorage.setItem(LS_PINS_KEY, JSON.stringify(pinnedIds))
        const pinsParam = pinnedIds.length > 0 ? pinnedIds.join(',') : undefined
        void navigate({ to: '/sessions', search: (prev) => ({ ...prev, pins: pinsParam }), replace: true })
    }, [pinnedIds, navigate])

    // Clamp activePinIndex when pins shrink
    useEffect(() => {
        if (activePinIndex >= pinnedIds.length) setActivePinIndex(Math.max(0, pinnedIds.length - 1))
    }, [pinnedIds.length, activePinIndex])

    // Auto-focus newly created session if it gets pinned
    useEffect(() => {
        if (modalNewSessionId && pinnedIds.includes(modalNewSessionId)) {
            const index = pinnedIds.indexOf(modalNewSessionId)
            if (activePinIndex !== index) {
                setActivePinIndex(index)
            }
        }
    }, [modalNewSessionId, pinnedIds, activePinIndex])

    // ── Listen for toast notification clicks ─────────────────────────────────
    // ToastContainer dispatches 'hapi:focus-session' instead of navigating.
    // Dashboard handles it: focus if pinned, pin+focus if slot available, or open replace modal.
    useEffect(() => {
        const handleFocusSession = (e: Event) => {
            const sessionId = (e as CustomEvent<{ sessionId: string }>).detail?.sessionId
            if (!sessionId) return

            // Use functional updates so this always has current state
            setPinnedIds(prev => {
                const idx = prev.indexOf(sessionId)
                if (idx !== -1) {
                    // Already pinned — just focus it
                    setActivePinIndex(idx)
                    return prev
                }
                if (prev.length < MAX_PINS) {
                    // Slot available — pin and focus
                    setActivePinIndex(prev.length)
                    return [...prev, sessionId]
                }
                // Full — open replace modal
                setPendingReplacePin(sessionId)
                return prev
            })
        }

        document.addEventListener('hapi:focus-session', handleFocusSession)
        return () => document.removeEventListener('hapi:focus-session', handleFocusSession)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])


    const statuses = new Map<string, SessionStatus>()
    for (const s of sessions) statuses.set(s.id, getSessionStatus(s))

    const archivedSessions = sessions.filter(s => !s.active)

    const visibleSessions = [...sessions]
        .sort((a, b) => {
            if (modalNewSessionId) {
                if (a.id === modalNewSessionId) return -1
                if (b.id === modalNewSessionId) return 1
            }
            const pa = getStatusPriority(statuses.get(a.id) ?? 'active')
            const pb = getStatusPriority(statuses.get(b.id) ?? 'active')
            return pa !== pb ? pa - pb : b.updatedAt - a.updatedAt
        })
    const projectGroups = groupByProject(visibleSessions).sort((a, b) => {
        const aHasPin = a.sessions.some(s => pinnedIds.includes(s.id))
        const bHasPin = b.sessions.some(s => pinnedIds.includes(s.id))
        if (aHasPin && !bHasPin) return -1
        if (!aHasPin && bHasPin) return 1
        return a.project.localeCompare(b.project)
    })

    const pinnedSessions = pinnedIds
        .map(id => sessions.find(s => s.id === id))
        .filter((s): s is SessionSummary => s !== undefined)

    const thinkingCount = [...statuses.values()].filter(s => s === 'thinking').length
    const doneCount = [...statuses.values()].filter(s => s === 'done').length
    const waitingCount = [...statuses.values()].filter(s => s === 'waiting').length

    const pinCount = pinnedIds.length
    const hasPins = pinCount > 0
    const hasOverflowSidebar = pinCount <= 2
    const unarchivedCount = archivedSessions.length - addedArchivedIds.size
    const sidebarCardLimit = pinCount === 1 ? 8 : 4

    // Layout class
    const layoutClass = pinCount === 0 ? 'db__content--grid'
        : pinCount === 1 ? 'db__content--split-1'
        : pinCount === 2 ? 'db__content--split-2'
        : pinCount === 3 ? 'db__content--split-3'
        : 'db__content--split-4'

    // ── Handlers ─────────────────────────────────────────────────────────────
    const clearNewSessionHighlight = useCallback(() => {
        if (!modalNewSessionId) return
        void navigate({
            search: (prev: any) => {
                const newSearch = { ...prev }
                delete newSearch.modalNewSessionId
                return newSearch
            },
            replace: true
        } as any)
    }, [navigate, modalNewSessionId])

    const handlePin = useCallback((sessionId: string, e?: React.MouseEvent) => {
        if (pinnedIds.includes(sessionId)) {
            if (e) {
                setPinnedAction({ id: sessionId, x: e.clientX, y: e.clientY })
            } else {
                setPinnedAction({ id: sessionId, x: window.innerWidth / 2, y: window.innerHeight / 2 })
            }
            return
        }
        if (pinnedIds.length >= MAX_PINS) {
            setPendingReplacePin(sessionId)
            return
        }
        setPinnedIds(prev => [...prev, sessionId])
        setActivePinIndex(pinnedIds.length)
        // If they pin a new session, we can optionally close the overview drawer here:
        setShowOverviewDrawer(false)
    }, [pinnedIds])

    const handleUnpin = useCallback((sessionId: string) => {
        setPinnedIds(prev => prev.filter(id => id !== sessionId))
    }, [])

    const handleReplacePin = useCallback((oldSessionId: string) => {
        if (!pendingReplacePin) return
        setPinnedIds(prev => {
            const next = [...prev]
            const idx = next.indexOf(oldSessionId)
            if (idx !== -1) {
                next[idx] = pendingReplacePin
                setActivePinIndex(idx)
            }
            return next
        })
        setPendingReplacePin(null)
    }, [pendingReplacePin])

    const handleUnpinAll = useCallback(() => setPinnedIds([]), [])

    const handleAddArchived = useCallback((ids: string[]) => {
        setAddedArchivedIds(prev => new Set([...prev, ...ids]))
    }, [])

    const handleDetach = useCallback((sessionId: string) => {
        setAddedArchivedIds(prev => { const n = new Set(prev); n.delete(sessionId); return n })
        setPinnedIds(prev => prev.filter(id => id !== sessionId))
    }, [])

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
        // @ts-expect-error tanstack router navigate generic types are too complex here
        void navigate({ search: (prev: any) => ({ ...prev, modal: 'new-session', modalPath: path }) })
    }, [navigate])

    const renderMiniSessionList = () => (
        <div className="db__overview-list">
            {projectGroups.map(({ project, sessions: groupSessions }) => (
                <div key={project} className="db__overview-group">
                    <div className="db__overview-group-header">
                        <span className="db__group-name">{project}</span>
                        <span className="db__group-count">{groupSessions.length}</span>
                    </div>
                    {groupSessions.map(s => {
                        const isHighlighted = s.id === modalNewSessionId
                        return (
                            <button
                                key={s.id}
                                type="button"
                                className={`db__overview-item ${pinnedIds.includes(s.id) ? 'db__overview-item--pinned' : ''} ${isHighlighted ? 'ring-2 ring-[var(--app-button)]' : ''}`}
                                onClick={(e) => { 
                                    if (isHighlighted) clearNewSessionHighlight()
                                    handlePin(s.id, e)
                                }}
                                onFocusCapture={() => {
                                    if (isHighlighted) clearNewSessionHighlight()
                                }}
                            >
                                <span className={`db-card__dot db-card__dot--${statuses.get(s.id) ?? 'active'}`} />
                                <span className="db__overview-item-title">{getSessionTitle(s)}</span>
                                <span className={`db-card__agent db-card__agent--${s.metadata?.flavor ?? 'claude'}`}>{getAgentLabel(s)}</span>
                                {pinnedIds.includes(s.id) && (
                                    <span className="db__overview-item-pin-index">
                                        <PinIcon filled />
                                        <span className="db__overview-item-pin-number">{pinnedIds.indexOf(s.id) + 1}</span>
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            ))}
        </div>
    )

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
                        title={t('dashboard.browseWorkspace')}
                        onClick={() => void navigate({ search: (prev: any) => ({ ...prev, modal: 'browser' }) } as any)}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        <span className="db__label">Browse</span>
                    </button>
                    <button
                        type="button"
                        className="db__topbar-btn db__topbar-btn--editor"
                        title="Editor Mode"
                        onClick={() => void navigate({ to: '/editor' })}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m8 10 3 3-3 3" /><path d="M13 16h3" /></svg>
                        <span className="db__label">Editor</span>
                    </button>
                    <button
                        type="button"
                        className="db__topbar-btn"
                        title={t('dashboard.settings')}
                        onClick={() => void navigate({ search: (prev: any) => ({ ...prev, modal: 'settings' }) } as any)}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        <span className="db__label">Settings</span>
                    </button>
                    <button
                        type="button"
                        className="db__topbar-btn db__topbar-btn--primary"
                        title={t('dashboard.newSession')}
                        onClick={() => void navigate({ search: (prev: any) => ({ ...prev, modal: 'new-session' }) } as any)}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        <span className="db__label">New Session</span>
                    </button>
                    {hasPins && (
                        <button type="button" className="db__unpin-all" onClick={handleUnpinAll}>
                            <XIcon /> Unpin All ({pinCount})
                        </button>
                    )}
                </div>
            </div>



            {/* Mobile tab strip — shown on mobile when pinned sessions exist */}
            {hasPins && (
                <div className="db__pinned-tabs">
                    <button
                        type="button"
                        className="db__pin-tab db__pin-tab--overview-trigger"
                        onClick={() => setShowOverviewDrawer(true)}
                        title={t('dashboard.viewAllSessions')}
                    >
                        {thinkingCount > 0 && <span className="db-card__dot db-card__dot--thinking" />}
                        {waitingCount > 0 && <span className="db-card__dot db-card__dot--waiting" />}
                        {thinkingCount === 0 && waitingCount === 0 && doneCount > 0 && <span className="db-card__dot db-card__dot--done" />}
                        {/* Short label on mobile, full label on desktop */}
                        <span className="db__pin-tab-label--short">{t('dashboard.allSessionsShort', { n: sessions.length })}</span>
                        <span className="db__pin-tab-label--long">{t('dashboard.allSessions', { n: sessions.length })}</span>
                    </button>

                    {pinnedIds.map((id, idx) => {
                        const s = sessions.find(x => x.id === id)
                        const status = statuses.get(id) ?? 'active'
                        const title = s ? getSessionTitle(s) : id.slice(0, 8)
                        return (
                            <button
                                key={id}
                                type="button"
                                className={`db__pin-tab ${idx === activePinIndex ? 'db__pin-tab--active' : ''}`}
                                onClick={() => setActivePinIndex(idx)}
                            >
                                <span className="db__pin-tab-index" style={{ opacity: 0.5, fontSize: 10, fontWeight: 700 }}>{idx + 1}</span>
                                <span className={`db-card__dot db-card__dot--${status}`} />
                                <span className="db__pin-tab-title">{title}</span>
                                <span
                                    className="db__pin-tab-close"
                                    role="button"
                                    tabIndex={0}
                                    onClick={e => { e.stopPropagation(); handleUnpin(id) }}
                                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); handleUnpin(id) } }}
                                >
                                    <XIcon />
                                </span>
                            </button>
                        )
                    })}
                </div>
            )}

            {/* Main content area */}
            <div className={`db__content ${layoutClass}`}>

                {/* Pinned panels area */}
                {hasPins && (
                    <div className="db__pinned-area">
                        {pinnedSessions.map((s, idx) => (
                            <div
                                key={s.id}
                                className={[
                                    'db__pinned-panel',
                                    pinnedIds.length >= 2 ? `db__pinned-panel--mobile-${idx === activePinIndex ? 'active' : 'hidden'}` : '',
                                    s.id === modalNewSessionId ? 'ring-2 ring-[var(--app-button)]' : ''
                                ].filter(Boolean).join(' ')}
                                onClick={() => {
                                    if (s.id === modalNewSessionId) clearNewSessionHighlight()
                                }}
                                onFocusCapture={() => {
                                    if (s.id === modalNewSessionId) clearNewSessionHighlight()
                                }}
                            >
                                <PinnedPanel
                                    sessionId={s.id}
                                    api={api}
                                    onUnpin={() => handleUnpin(s.id)}
                                    onSessionResolved={(newId) => {
                                        setPinnedIds(prev => prev.map(id => id === s.id ? newId : id))
                                    }}
                                    pinIndex={idx + 1}
                                    compact={true}
                                    isActive={activePinIndex === idx}
                                    onFocus={() => setActivePinIndex(idx)}
                                />
                            </div>
                        ))}

                        {/* 4th cell placeholder for 3-pin mode */}
                        {pinnedSessions.length === 3 && (
                            <div className="db__pinned-placeholder">
                                <div className="db__pinned-placeholder-header">
                                    <span className="db__pinned-placeholder-title">{t('dashboard.selectToPin', { n: 4, suffix: 'th' })}</span>
                                </div>
                                <div className="db__pinned-placeholder-content app-scroll-y">
                                    <div className="db__groups db__groups--compact">
                                        {projectGroups.map(({ project, sessions: groupSessions }) => (
                                            <div key={project} className="db__group">
                                                <div className="db__group-header db__group-header--sidebar">
                                                    <span className="db__group-name">{project}</span>
                                                    <span className="db__group-count">{groupSessions.length}</span>
                                                </div>
                                                <div className="db__grid db__grid--compact">
                                                    {groupSessions.map(session => (
                                                        <SessionCard
                                                            key={session.id}
                                                            session={session}
                                                            status={statuses.get(session.id) ?? 'archived'}
                                                            isPinned={pinnedIds.includes(session.id)}
                                                            pinIndex={pinnedIds.includes(session.id) ? pinnedIds.indexOf(session.id) + 1 : undefined}
                                                            pinDisabled={pinnedIds.length >= MAX_PINS}
                                                            compact={true}
                                                            isAddedArchived={statuses.get(session.id) === 'archived'}
                                                            isHighlighted={session.id === modalNewSessionId}
                                                            onSelect={(e) => {
                                                                if (session.id === modalNewSessionId) clearNewSessionHighlight()
                                                                handlePin(session.id, e)
                                                            }}
                                                            onFocusCapture={() => {
                                                                if (session.id === modalNewSessionId) clearNewSessionHighlight()
                                                            }}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Session card grid — sidebar when 1-2 pins, hidden when 3-4 pins */}
                {(pinCount === 0 || hasOverflowSidebar) && (
                    <div className={`db__grid-area ${hasPins ? 'db__grid-area--sidebar' : ''}`}>
                        {isLoading && <div className="db__loading">{t('dashboard.loadingSessions')}</div>}

                        {!isLoading && visibleSessions.length === 0 && !hasPins && (
                            <div className="db__empty">
                                <p>No active sessions</p>
                                <p style={{ fontSize: 12, opacity: 0.5, marginTop: 4 }}>Start a session from the Sessions tab</p>
                            </div>
                        )}

                        <div className={`db__groups ${hasPins ? 'db__groups--compact' : ''}`}>
                            {projectGroups.map(({ project, sessions: groupSessions }) => {
                                // In sidebar mode, limit cards shown
                                const displaySessions = hasPins ? groupSessions.slice(0, sidebarCardLimit) : groupSessions
                                return (
                                    <div key={project} className="db__group">
                                        {/* Always show group header — compact version in sidebar mode */}
                                        {hasPins ? (
                                            <div className="db__group-header db__group-header--sidebar">
                                                <span className="db__group-name">{project}</span>
                                                <span className="db__group-count">{groupSessions.length}</span>
                                            </div>
                                        ) : (
                                            <div className="db__group-header">
                                                <div className="db__group-header-left">
                                                    <span className="db__group-name">{project}</span>
                                                    <span className="db__group-count">{groupSessions.length}</span>
                                                </div>
                                                <div className="db__group-actions">
                                                    <button type="button" className="db__group-action" title={t('dashboard.newSessionIn', { project })} onClick={() => handleNewInGroup(groupSessions)}>
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                                        <span className="db__label">New</span>
                                                    </button>
                                                    <button type="button" className="db__group-action" title={t('dashboard.copyPath')} onClick={() => handleCopyPath(project, groupSessions)}>
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                                        <span className="db__label">Copy Path</span>
                                                    </button>
                                                    {pendingConfirm?.project === project ? (
                                                        <div className={`db__inline-confirm ${pendingConfirm.action === 'delete' ? 'db__inline-confirm--danger' : ''}`}>
                                                            <span className="db__inline-confirm-text">
                                                                {pendingConfirm.action === 'archive'
                                                                    ? t('dashboard.confirmArchive', { n: pendingConfirm.targetSessions.length })
                                                                    : t('dashboard.confirmDelete', { n: pendingConfirm.targetSessions.length })}
                                                            </span>
                                                            <button type="button" className="db__inline-confirm-yes" onClick={() => void handleExecuteConfirm()}>{t('dashboard.confirm')}</button>
                                                            <button type="button" className="db__inline-confirm-no" onClick={() => setPendingConfirm(null)}>{t('dashboard.cancel')}</button>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            {groupSessions.some(s => s.active) && (
                                                                <button type="button" className="db__group-action db__group-action--warning" title={t('dashboard.archiveAllTitle')} onClick={() => handleRequestArchiveAll(project, groupSessions)}>
                                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                                                                    <span className="db__label">{t('dashboard.archiveAll')}</span>
                                                                </button>
                                                            )}
                                                            {groupSessions.some(s => !s.active) && (
                                                                <button type="button" className="db__group-action db__group-action--danger" title={t('dashboard.deleteAllTitle')} onClick={() => handleRequestDeleteAll(project, groupSessions)}>
                                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                                                                    <span className="db__label">{t('dashboard.deleteArchived')}</span>
                                                                </button>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        <div className={`db__grid ${hasPins ? 'db__grid--compact' : ''}`}>
                                            {displaySessions.map(session => (
                                                <SessionCard
                                                    key={session.id}
                                                    session={session}
                                                    status={statuses.get(session.id) ?? 'archived'}
                                                    isPinned={pinnedIds.includes(session.id)}
                                                    pinIndex={pinnedIds.includes(session.id) ? pinnedIds.indexOf(session.id) + 1 : undefined}
                                                    pinDisabled={pinnedIds.length >= MAX_PINS}
                                                    compact={hasPins}
                                                    isAddedArchived={statuses.get(session.id) === 'archived'}
                                                    isHighlighted={session.id === modalNewSessionId}
                                                    onSelect={() => {
                                                        if (session.id === modalNewSessionId) clearNewSessionHighlight()
                                                        handlePin(session.id)
                                                    }}
                                                    onFocusCapture={() => {
                                                        if (session.id === modalNewSessionId) clearNewSessionHighlight()
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                )}



                {showOverviewDrawer && (
                    <div className="db__overview-overlay" onClick={() => setShowOverviewDrawer(false)}>
                        <div className="db__overview-drawer" onClick={e => e.stopPropagation()}>
                            <div className="db__overview-header">
                                <span className="db__overview-title">{t('dashboard.sessions', { n: sessions.length })}</span>
                                <button type="button" className="db__overview-close" onClick={() => setShowOverviewDrawer(false)}><XIcon /></button>
                            </div>
                            {renderMiniSessionList()}
                        </div>
                    </div>
                )}
            </div>

            {pendingReplacePin && (
                <ReplacePinModal
                    sessionToPinId={pendingReplacePin}
                    pinnedSessions={pinnedSessions}
                    onReplace={handleReplacePin}
                    onCancel={() => setPendingReplacePin(null)}
                />
            )}

            {pinnedAction && (
                <PinnedSessionContextMenu
                    sessionTitle={getSessionTitle(sessions.find(s => s.id === pinnedAction.id) || { id: pinnedAction.id } as any)}
                    x={pinnedAction.x}
                    y={pinnedAction.y}
                    onFocus={() => {
                        const idx = pinnedIds.indexOf(pinnedAction.id)
                        if (idx !== -1) setActivePinIndex(idx)
                        setPinnedAction(null)
                        setShowOverviewDrawer(false)
                    }}
                    onUnpin={() => {
                        setPinnedIds(prev => prev.filter(id => id !== pinnedAction.id))
                        setPinnedAction(null)
                    }}
                    onCancel={() => setPinnedAction(null)}
                />
            )}
        </div>
    )
}
