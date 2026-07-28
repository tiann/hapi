import type { Session, WorktreeMetadata } from './schemas'

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
    /** Epoch ms when the request was raised; falls back to `session.updatedAt`
     *  for older requests that were stored without `createdAt`. */
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
    modelReasoningEffort?: string | null
    effort: string | null
}

export function getPendingRequests(
    session: Session,
    cap: number = PENDING_REQUEST_SUMMARY_CAP
): PendingRequest[] {
    const requests = session.agentState?.requests
    if (!requests) {
        return []
    }

    const items: PendingRequest[] = []
    for (const [id, request] of Object.entries(requests)) {
        items.push({
            id,
            kind: classifyKind(request.tool),
            tool: request.tool,
            since: typeof request.createdAt === 'number' ? request.createdAt : session.updatedAt
        })
    }

    items.sort((a, b) => {
        if (a.since !== b.since) return a.since - b.since
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return cap >= items.length ? items : items.slice(0, cap)
}

export function getPendingRequestKinds(session: Session): PendingRequestKind[] {
    const requests = session.agentState?.requests
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
            ?? session.metadata.grokSessionId
            ?? session.metadata.cursorSessionId
            ?? session.metadata.kimiSessionId
            ?? undefined,
        lifecycleState: session.metadata.lifecycleState
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
        pendingRequestKinds: getPendingRequestKinds(session),
        pendingRequests: getPendingRequests(session),
        backgroundTaskCount: session.backgroundTaskCount ?? 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: session.model,
        modelReasoningEffort: session.modelReasoningEffort,
        effort: session.effort
    }
}
