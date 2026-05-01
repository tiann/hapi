import { useEffect, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useSessions } from '@/hooks/queries/useSessions'
import { filterSessionsForEditorProject, sessionBelongsToEditorProject } from '@/lib/editor-session-filter'

export const sessionBelongsToProject = sessionBelongsToEditorProject
function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.summary?.text) return session.metadata.summary.text
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts[parts.length - 1] ?? session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function getRelativeTime(value: number): string {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return ''
    const delta = Date.now() - ms
    if (delta < 60_000) return 'now'
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    return `${days}d`
}

function getStatusTitle(session: SessionSummary): string {
    if (!session.active) return 'Archived'
    if (session.thinking) return 'Thinking'
    if (session.pendingRequestsCount > 0) return `Waiting (${session.pendingRequestsCount})`
    return 'Active'
}

function getStatusColor(session: SessionSummary): string {
    if (!session.active) return '#475569'
    if (session.thinking) return '#818cf8'
    if (session.pendingRequestsCount > 0) return '#f59e0b'
    return '#22c55e'
}

function SessionRow(props: {
    session: SessionSummary
    selected: boolean
    onSelectSession: (sessionId: string) => void
}) {
    const title = getSessionTitle(props.session)
    const flavor = props.session.metadata?.flavor ?? 'agent'

    return (
        <button
            type="button"
            aria-label={`Select session ${title}`}
            aria-current={props.selected ? 'page' : undefined}
            onClick={() => props.onSelectSession(props.session.id)}
            className={`w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)] ${props.selected ? 'bg-[var(--app-subtle-bg)]' : ''}`}
        >
            <div className="flex items-center gap-2 min-w-0">
                <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: getStatusColor(props.session) }}
                    title={getStatusTitle(props.session)}
                />
                <span className="truncate text-xs font-medium text-[var(--app-fg)]">{title}</span>
                <span className="ml-auto shrink-0 text-[10px] uppercase text-[var(--app-hint)]">{flavor}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 pl-4 text-[10px] text-[var(--app-hint)]">
                <span className="truncate">{props.session.metadata?.path ?? props.session.id}</span>
                <span className="shrink-0">{getRelativeTime(props.session.updatedAt)}</span>
            </div>
        </button>
    )
}

export function EditorSessionList(props: {
    api: ApiClient | null
    machineId: string | null
    projectPath: string | null
    activeSessionId: string | null
    onSelectSession: (sessionId: string) => void
    onNewSession: () => void
}) {
    if (!props.machineId || !props.projectPath) {
        return (
            <div className="flex h-full items-center justify-center p-3 text-center text-xs text-[var(--app-hint)]">
                Select a project to view sessions
            </div>
        )
    }

    return (
        <SelectedEditorSessionList
            api={props.api}
            machineId={props.machineId}
            projectPath={props.projectPath}
            activeSessionId={props.activeSessionId}
            onSelectSession={props.onSelectSession}
            onNewSession={props.onNewSession}
        />
    )
}

function SelectedEditorSessionList(props: {
    api: ApiClient | null
    machineId: string
    projectPath: string
    activeSessionId: string | null
    onSelectSession: (sessionId: string) => void
    onNewSession: () => void
}) {
    const { sessions, isLoading, error } = useSessions(props.api)
    const { activeSessionId, onSelectSession } = props
    const projectSessions = useMemo(() => {
        return filterSessionsForEditorProject(sessions, props.machineId, props.projectPath)
    }, [props.machineId, props.projectPath, sessions])

    useEffect(() => {
        if (isLoading || error || projectSessions.length === 0) return
        if (!activeSessionId) {
            onSelectSession(projectSessions[0].id)
            return
        }
        if (projectSessions.some((session) => session.id === activeSessionId)) return

        const activeSession = sessions.find((session) => session.id === activeSessionId)
        // Newly-created editor sessions can be active before the sessions list
        // refetch includes them. Keep the explicit selection instead of
        // bouncing back to the first stale row.
        if (!activeSession) return

        onSelectSession(projectSessions[0].id)
    }, [activeSessionId, error, isLoading, onSelectSession, projectSessions, sessions])

    return (
        <div className="flex h-full min-h-0 flex-col border-b border-[var(--app-border)]">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3 py-2">
                <div className="min-w-0 flex-1 text-xs font-semibold text-[var(--app-fg)]">Sessions</div>
                <button
                    type="button"
                    onClick={props.onNewSession}
                    className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                >
                    + New
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {isLoading ? (
                    <div className="p-2 text-xs text-[var(--app-hint)]">Loading sessions...</div>
                ) : error ? (
                    <div className="p-2 text-xs text-red-500">{error}</div>
                ) : projectSessions.length === 0 ? (
                    <div className="p-2 text-xs text-[var(--app-hint)]">No sessions for this project</div>
                ) : (
                    <div className="flex flex-col gap-1">
                        {projectSessions.map((session) => (
                            <SessionRow
                                key={session.id}
                                session={session}
                                selected={session.id === props.activeSessionId}
                                onSelectSession={props.onSelectSession}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
