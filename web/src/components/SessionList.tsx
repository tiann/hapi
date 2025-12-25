import type { SessionSummary } from '@/types/api'

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

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
}) {
    const { renderHeader = true } = props

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {props.sessions.length} sessions
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

            <div className="flex flex-col divide-y divide-[var(--app-divider)]">
                {props.sessions.map((s) => (
                    <button
                        key={s.id}
                        type="button"
                        onClick={() => props.onSelect(s.id)}
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
                            </div>
                        </div>
                        <div className="truncate text-xs text-[var(--app-hint)]">
                            {s.metadata?.path ?? s.id}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--app-hint)]">
                            <span>❖ {getAgentLabel(s)}</span>
                            <span>model: {getModelLabel(s)}</span>
                            {(() => {
                                const lastSeen = getLastSeenLabel(s)
                                if (!lastSeen) return null
                                return <span>{lastSeen}</span>
                            })()}
                        </div>
                    </button>
                ))}
            </div>
        </div>
    )
}
