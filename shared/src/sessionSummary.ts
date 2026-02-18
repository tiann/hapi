import type { ModelMode, PermissionMode } from './modes'
import type { Session, WorktreeMetadata } from './schemas'

export type SessionSummaryMetadata = {
    name?: string
    path: string
    machineId?: string
    summary?: { text: string }
    flavor?: string | null
    worktree?: WorktreeMetadata
}

export type SessionSummary = {
    id: string
    active: boolean
    thinking: boolean
    activeAt: number
    updatedAt: number
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    permissionMode?: PermissionMode
    modelMode?: ModelMode
}

export function toSessionSummary(session: Session): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0

    const metadata: SessionSummaryMetadata | null = session.metadata ? {
        name: session.metadata.name,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        summary: session.metadata.summary ? { text: session.metadata.summary.text } : undefined,
        flavor: session.metadata.flavor ?? null,
        worktree: session.metadata.worktree
    } : null

    const todoProgress = session.todos?.length ? {
        completed: session.todos.filter(t => t.status === 'completed').length,
        total: session.todos.length
    } : null

    return {
        id: session.id,
        active: session.active,
        thinking: session.thinking,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        metadata,
        todoProgress,
        pendingRequestsCount,
        permissionMode: session.permissionMode,
        modelMode: session.modelMode
    }
}
