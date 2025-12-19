export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | null | undefined
export type ModelMode = 'default' | 'sonnet' | 'opus' | null | undefined

export type SessionMetadataSummary = {
    path: string
    host: string
    version?: string
    name?: string
    os?: string
    summary?: { text: string; updatedAt: number }
    machineId?: string
    tools?: string[]
    flavor?: string | null
}

export type AgentStateRequest = {
    tool: string
    arguments: unknown
    createdAt?: number | null
}

export type AgentStateCompletedRequest = {
    tool: string
    arguments: unknown
    createdAt?: number | null
    completedAt?: number | null
    status: 'canceled' | 'denied' | 'approved'
    reason?: string
    mode?: string
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    allowTools?: string[]
    answers?: Record<string, string[]>
}

export type AgentState = {
    controlledByUser?: boolean | null
    requests?: Record<string, AgentStateRequest> | null
    completedRequests?: Record<string, AgentStateCompletedRequest> | null
}

export type TodoItem = {
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    priority: 'high' | 'medium' | 'low'
    id: string
}

export type Session = {
    id: string
    createdAt: number
    updatedAt: number
    active: boolean
    thinking: boolean
    metadata: SessionMetadataSummary | null
    agentState: AgentState | null
    todos?: TodoItem[]
    permissionMode?: PermissionMode
    modelMode?: ModelMode
}

export type SessionSummaryMetadata = {
    name?: string
    path: string
    summary?: { text: string }
}

export type SessionSummary = {
    id: string
    active: boolean
    updatedAt: number
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
}

export type MessageStatus = 'sending' | 'sent' | 'failed'

export type DecryptedMessage = {
    id: string
    seq: number | null
    localId: string | null
    content: unknown
    createdAt: number
    status?: MessageStatus
    originalText?: string
}

export type Machine = {
    id: string
    active: boolean
    metadata: {
        host: string
        platform: string
        happyCliVersion: string
        displayName?: string
    } | null
}

export type AuthResponse = {
    token: string
    user: {
        id: number
        username?: string
        firstName?: string
        lastName?: string
    }
}

export type SessionsResponse = { sessions: SessionSummary[] }
export type SessionResponse = { session: Session }
export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        beforeSeq: number | null
        nextBeforeSeq: number | null
        hasMore: boolean
    }
}

export type MachinesResponse = { machines: Machine[] }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }

export type SyncEvent =
    | { type: 'session-added'; sessionId: string; data?: unknown }
    | { type: 'session-updated'; sessionId: string; data?: unknown }
    | { type: 'session-removed'; sessionId: string }
    | { type: 'message-received'; sessionId: string; message: DecryptedMessage }
    | { type: 'machine-updated'; machineId: string; data?: unknown }
    | { type: 'connection-changed'; data?: { status: string } }
