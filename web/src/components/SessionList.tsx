import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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

function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
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
                            <CardDescription className="truncate">
                                {s.metadata?.host ? `Host: ${s.metadata.host}` : 'Host: (unknown)'}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="pt-0">
                            <div className="text-xs text-[var(--app-hint)] truncate">
                                {s.metadata?.path ?? s.id}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    )
}
