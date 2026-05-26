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
    DeleteUploadResponse,
    DirectoryEntry,
    FileReadResponse,
    GitCommandResponse,
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
    RunnerSpawnOptionsPreviewRequest,
    RunnerSpawnOptionsPreviewResponse,
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
    PermissionMode,
    Machine,
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

export type VisibilityPayload = {
    subscriptionId: string
    visibility: 'visible' | 'hidden'
}

export type SyncEvent = ProtocolSyncEvent
