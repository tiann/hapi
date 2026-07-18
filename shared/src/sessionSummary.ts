import type { Session, WorktreeMetadata } from './schemas'

export type SessionSummaryMetadata = {
    name?: string
    title?: string
    titleUpdatedAt?: number
    path: string
    machineId?: string
    summary?: { text: string }
    mirrorSource?: string
    flavor?: string | null
    worktree?: WorktreeMetadata
    agentSessionId?: string
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
    unreadCount: number
    model: string | null
    serviceTier?: string | null
    effort: string | null
}

export function toSessionSummary(session: Session, options?: { unreadCount?: number }): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0

    const metadata: SessionSummaryMetadata | null = session.metadata ? {
        name: session.metadata.name,
        title: session.metadata.title,
        titleUpdatedAt: session.metadata.titleUpdatedAt,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        summary: session.metadata.summary ? { text: session.metadata.summary.text } : undefined,
        mirrorSource: session.metadata.mirrorSource,
        flavor: session.metadata.flavor ?? null,
        worktree: session.metadata.worktree,
        agentSessionId: session.metadata.codexSessionId
            ?? session.metadata.claudeSessionId
            ?? session.metadata.agySessionId
            ?? session.metadata.grokSessionId
            ?? session.metadata.opencodeSessionId
            ?? session.metadata.cursorSessionId
            ?? session.metadata.hermesSessionId
            ?? undefined
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
        unreadCount: options?.unreadCount ?? 0,
        model: session.model,
        serviceTier: session.serviceTier ?? null,
        effort: session.effort
    }
}
