import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
}) {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
                <div className="text-sm text-[var(--app-hint)]">
                    {props.sessions.length} sessions
                </div>
                <button
                    type="button"
                    onClick={props.onNewSession}
                    className="p-1.5 rounded-full text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                    title="New Session"
                >
                    <PlusIcon />
                </button>
            </div>

            <div className="flex flex-col gap-3">
                {props.sessions.map((s) => (
                    <Card key={s.id} className="cursor-pointer" onClick={() => props.onSelect(s.id)}>
                        <CardHeader className="pb-2">
                            <div className="flex items-center justify-between gap-2">
                                <CardTitle className="truncate">{getSessionTitle(s)}</CardTitle>
                                <div className="flex items-center gap-2 shrink-0">
                                    {(() => {
                                        const progress = getTodoProgress(s)
                                        if (!progress) return null
                                        return (
                                            <Badge className="gap-1 border-transparent bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                                                <BulbIcon className="h-3 w-3" />
                                                {progress.completed}/{progress.total}
                                            </Badge>
                                        )
                                    })()}
                                    {s.active ? (
                                        s.pendingRequestsCount > 0 ? (
                                            <Badge variant="warning">{s.pendingRequestsCount} pending</Badge>
                                        ) : (
                                            <Badge variant="success">active</Badge>
                                        )
                                    ) : (
                                        <Badge>inactive</Badge>
                                    )}
                                </div>
                            </div>
                            <CardDescription className="truncate">
                                {s.metadata?.path ?? s.id}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                ))}
            </div>
        </div>
    )
}
