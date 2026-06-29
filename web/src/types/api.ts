import type {
    DecryptedMessage as ProtocolDecryptedMessage,
    Machine,
    RunnerState,
    Session,
    SessionSummary,
    SyncEvent as ProtocolSyncEvent,
    WorktreeMetadata
} from '@hapi/protocol/types'

export type {
    CodexModelsResponse,
    CodexModelSummary,
    CommandResponse,
    CursorModelsResponse,
    CursorModelSummary,
    CursorChatStoreStatus,
    DeleteUploadResponse,
    DirectoryEntry,
    FileReadResponse,
    GitCommandResponse,
    GrokModelsResponse,
    GrokModelSummary,
    GrokReasoningEffortResponse,
    GrokReasoningEffortOption,
    ListDirectoryResponse,
    MachineDirectoryEntry,
    MachineListDirectoryResponse,
    MachinePathsExistsResponse,
    AuthResponse,
    MachinesResponse,
    MessagesResponse,
    OpencodeModelsResponse,
    OpencodeModelSummary,
    PathExistsResponse,
    PiModelSummary,
    PiModelsResponse,
    PiThinkingLevelMap,
    SlashCommand,
    SlashCommandsResponse,
    SessionResponse,
    SessionsResponse,
    SpawnResponse,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'

export type {
    AgentState,
    AttachmentMetadata,
    CodexCollaborationMode,
    Metadata,
    PermissionMode,
    Machine,
    MachineHealth,
    PendingRequest,
    PendingRequestKind,
    RunnerState,
    Session,
    SessionPatch,
    SessionSummary,
    SessionSummaryMetadata,
    TeamMember,
    TeamMessage,
    TeamState,
    TeamTask,
    ThreadGoal,
    ThreadGoalStatus,
    TodoItem,
    WorktreeMetadata
} from '@hapi/protocol/types'

export type { HapiSessionExport } from '@hapi/protocol/sessionExport'

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
    capabilities?: {
        terminal?: boolean
    }
    worktree?: WorktreeMetadata
}

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed'

export type DecryptedMessage = ProtocolDecryptedMessage & {
    status?: MessageStatus
    originalText?: string
    invokedAt?: number | null
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

export type SkillSummary = {
    name: string
    description?: string
}

export type SkillsResponse = {
    success: boolean
    skills?: SkillSummary[]
    error?: string
}

export type PushSubscriptionKeys = {
    p256dh: string
    auth: string
}

export type PushSubscriptionPayload = {
    endpoint: string
    keys: PushSubscriptionKeys
}

export type PushUnsubscribePayload = {
    endpoint: string
}

export type PushVapidPublicKeyResponse = {
    publicKey: string
}

export type CodexDesktopScriptResponse = {
    success: boolean
    message?: string
    pid?: number
    command?: string
    script?: string
    cwd?: string
    output?: string
    error?: string
    codexDesktopRunning?: boolean
    codexClientAvailable?: boolean
    // 中文注释：多选导入时返回实际处理完成的 Codex 会话数量，用于前端提示本次导入条数。
    syncedCount?: number
    // 中文注释：这里存放本次导入对应的 Codex thread ID 列表，方便日志和排查 direct import 结果。
    sessionIds?: string[]
    hapiSessionIds?: string[]
}

export type CodexLocalSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
    source?: string | null
    threadSource?: string | null
    forkedFromId?: string | null
}

export type CodexLocalSessionsResponse = {
    success: true
    sessions: CodexLocalSessionSummary[]
    machineId?: string
} | {
    success: false
    error: string
    sessions: []
    machineId?: string
}


export type CodexArchiveSessionResponse = {
    success: true
    archivedPath: string
    machineId?: string
} | {
    success: false
    error: string
    machineId?: string
}

export type CodexDesktopSyncRequest = {
    // 中文注释：前端弹窗直接提交 Codex thread ID，后端会按这些 transcript 直接导入到 Hapi。
    sessionIds: string[]
    cwd?: string | null
    machineId?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    yolo?: boolean
}

export type CodexDesktopStatusResponse = {
    success: true
    codexDesktopRunning: boolean
    codexClientAvailable: boolean
}

export type CodexDuplicateSessionGroup = {
    codexSessionId: string
    hapiSessionIds: string[]
    canonicalSessionId?: string
    removedSessionIds?: string[]
}

export type CodexDuplicateSessionsResponse = {
    success: true
    // 中文注释：这里只返回本次选中导入的 codexSessionId 中检测出来的重复会话，不包含未勾选的其它会话。
    duplicates: CodexDuplicateSessionGroup[]
} | {
    success: false
    error: string
}

export type CodexMergeDuplicateSessionsResponse = {
    success: true
    merged: CodexDuplicateSessionGroup[]
    mergedCount: number
} | {
    success: false
    error: string
}

export type VisibilityPayload = {
    subscriptionId: string
    visibility: 'visible' | 'hidden'
}

export type SyncEvent = ProtocolSyncEvent
