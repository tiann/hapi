import type { AgentState, Metadata, Session, TodoItem, WorktreeMetadata } from './schemas'

export type PendingRequestKind = 'permission' | 'input'

const INPUT_REQUEST_TOOLS = new Set([
    'AskUserQuestion',
    'ask_user_question',
    'ExitPlanMode',
    'exit_plan_mode',
    'request_user_input'
])

/** Cap on `pendingRequests` carried in `SessionSummary`. The list is meant for
 *  per-row hover copy ("Approve `Bash`, `Edit` (+1 more)"); deep inspection
 *  should use `Session.agentState.requests`. The `pendingRequestsCount` field
 *  is the authoritative total — `pendingRequests.length` may be smaller. */
export const PENDING_REQUEST_SUMMARY_CAP = 5

export type PendingRequest = {
    id: string
    kind: PendingRequestKind
    tool: string
    /** Epoch ms when the request was raised; falls back to the caller-supplied
     *  `fallbackSince` (typically `session.updatedAt`) for older requests
     *  stored without `createdAt`. */
    since: number
}

function classifyKind(tool: string): PendingRequestKind {
    return INPUT_REQUEST_TOOLS.has(tool) ? 'input' : 'permission'
}

export type SessionSummaryMetadata = {
    name?: string
    path: string
    machineId?: string
    summary?: { text: string }
    flavor?: string | null
    worktree?: WorktreeMetadata
    agentSessionId?: string
    lifecycleState?: string
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
    pendingRequestKinds: PendingRequestKind[]
    /** Capped, oldest-first slice of pending tool requests. Use this for tooltip
     *  / per-row UX. The full count (which may exceed the cap) is in
     *  `pendingRequestsCount`. */
    pendingRequests: PendingRequest[]
    backgroundTaskCount: number
    futureScheduledMessageCount: number
    /** Epoch ms of the soonest uninvoked future scheduled message, or null. */
    nextScheduledAt: number | null
    model: string | null
    effort: string | null
}

// Re-exported as a standalone derivation so SSE patch handlers can recompute
// summary fields from a structured `agentState` patch without needing the
// full Session in hand.
export function computePendingRequestKinds(agentState: AgentState | null | undefined): PendingRequestKind[] {
    const requests = agentState?.requests
    if (!requests) {
        return []
    }

    const kinds = new Set<PendingRequestKind>()
    for (const request of Object.values(requests)) {
        kinds.add(classifyKind(request.tool))
    }

    return kinds.has('permission') && kinds.has('input')
        ? ['permission', 'input']
        : Array.from(kinds)
}

export function computePendingRequests(
    agentState: AgentState | null | undefined,
    fallbackSince: number,
    cap: number = PENDING_REQUEST_SUMMARY_CAP
): PendingRequest[] {
    const requests = agentState?.requests
    if (!requests) {
        return []
    }

    const items: PendingRequest[] = []
    for (const [id, request] of Object.entries(requests)) {
        items.push({
            id,
            kind: classifyKind(request.tool),
            tool: request.tool,
            since: typeof request.createdAt === 'number' ? request.createdAt : fallbackSince
        })
    }

    items.sort((a, b) => {
        if (a.since !== b.since) return a.since - b.since
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return cap >= items.length ? items : items.slice(0, cap)
}

export function getPendingRequestKinds(session: Session): PendingRequestKind[] {
    return computePendingRequestKinds(session.agentState)
}

export function getPendingRequests(
    session: Session,
    cap: number = PENDING_REQUEST_SUMMARY_CAP
): PendingRequest[] {
    return computePendingRequests(session.agentState, session.updatedAt, cap)
}

export function computePendingRequestsCount(agentState: AgentState | null | undefined): number {
    return agentState?.requests ? Object.keys(agentState.requests).length : 0
}

export function computeTodoProgress(todos: TodoItem[] | undefined): SessionSummary['todoProgress'] {
    if (!todos?.length) {
        return null
    }
    return {
        completed: todos.filter((todo) => todo.status === 'completed').length,
        total: todos.length
    }
}

export function toSessionSummaryMetadata(metadata: Metadata | null | undefined): SessionSummaryMetadata | null {
    if (!metadata) {
        return null
    }
    return {
        name: metadata.name,
        path: metadata.path,
        machineId: metadata.machineId ?? undefined,
        summary: metadata.summary ? { text: metadata.summary.text } : undefined,
        flavor: metadata.flavor ?? null,
        worktree: metadata.worktree,
        agentSessionId: metadata.codexSessionId
            ?? metadata.claudeSessionId
            ?? metadata.geminiSessionId
            ?? metadata.opencodeSessionId
            ?? metadata.cursorSessionId
            ?? metadata.kimiSessionId
            ?? undefined,
        lifecycleState: metadata.lifecycleState
    }
}

export function toSessionSummary(session: Session): SessionSummary {
    return {
        id: session.id,
        active: session.active,
        thinking: session.thinking,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        metadata: toSessionSummaryMetadata(session.metadata),
        todoProgress: computeTodoProgress(session.todos),
        pendingRequestsCount: computePendingRequestsCount(session.agentState),
        pendingRequestKinds: computePendingRequestKinds(session.agentState),
        pendingRequests: computePendingRequests(session.agentState, session.updatedAt),
        backgroundTaskCount: session.backgroundTaskCount ?? 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: session.model,
        effort: session.effort
    }
}
