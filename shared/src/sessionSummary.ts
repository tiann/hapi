import type { Session, WorktreeMetadata } from './schemas'
import type { CodexCollaborationMode, PermissionMode } from './modes'

export type SessionSummaryMetadata = {
    name?: string
    path: string
    machineId?: string
    summary?: { text: string }
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
    model: string | null
    modelReasoningEffort: string | null
    effort: string | null
    serviceTier: string | null
    permissionMode: PermissionMode | null
    collaborationMode: CodexCollaborationMode | null
}

export function toSessionSummary(session: Session): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0

    const metadata: SessionSummaryMetadata | null = session.metadata ? {
        name: session.metadata.name,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        summary: session.metadata.summary ? { text: session.metadata.summary.text } : undefined,
        flavor: session.metadata.flavor ?? null,
        worktree: session.metadata.worktree,
        agentSessionId: session.metadata.codexSessionId
            ?? session.metadata.claudeSessionId
            ?? session.metadata.geminiSessionId
            ?? session.metadata.opencodeSessionId
            ?? session.metadata.cursorSessionId
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
        model: session.model,
        modelReasoningEffort: session.modelReasoningEffort,
        effort: session.effort,
        serviceTier: session.serviceTier,
        permissionMode: session.permissionMode ?? null,
        collaborationMode: session.collaborationMode ?? null
    }
}
