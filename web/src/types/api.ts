export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | null | undefined
export type ModelMode = 'default' | 'sonnet' | 'opus' | null | undefined

export type WorktreeMetadata = {
    basePath: string
    branch: string
    name: string
    worktreePath?: string
    createdAt?: number
}

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
    worktree?: WorktreeMetadata
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
    machineId?: string
    summary?: { text: string }
    flavor?: string | null
    worktree?: WorktreeMetadata
}

export type SessionSummary = {
    id: string
    active: boolean
    activeAt: number
    updatedAt: number
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    modelMode?: ModelMode
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
export type MachinePathsExistsResponse = { exists: Record<string, boolean> }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }

export type GitCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type FileSearchItem = {
    fileName: string
    filePath: string
    fullPath: string
    fileType: 'file' | 'folder'
}

export type FileSearchResponse = {
    success: boolean
    files?: FileSearchItem[]
    error?: string
}

export type FileReadResponse = {
    success: boolean
    content?: string
    error?: string
}

export type GitFileStatus = {
    fileName: string
    filePath: string
    fullPath: string
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
    isStaged: boolean
    linesAdded: number
    linesRemoved: number
    oldPath?: string
}

export type GitStatusFiles = {
    stagedFiles: GitFileStatus[]
    unstagedFiles: GitFileStatus[]
    branch: string | null
    totalStaged: number
    totalUnstaged: number
}

export type SlashCommand = {
    name: string
    description?: string
    source: 'builtin' | 'user'
}

export type SlashCommandsResponse = {
    success: boolean
    commands?: SlashCommand[]
    error?: string
}

export type SyncEvent =
    | { type: 'session-added'; sessionId: string; data?: unknown }
    | { type: 'session-updated'; sessionId: string; data?: unknown }
    | { type: 'session-removed'; sessionId: string }
    | { type: 'message-received'; sessionId: string; message: DecryptedMessage }
    | { type: 'machine-updated'; machineId: string; data?: unknown }
    | { type: 'connection-changed'; data?: { status: string } }
