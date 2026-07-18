import type {
    DecryptedMessage as ProtocolDecryptedMessage,
    MachineMetadata,
    Session,
    SessionSummary,
    SyncEvent as ProtocolSyncEvent,
    WorktreeMetadata
} from '@hapi/protocol/types'
import type { ProviderReadinessIssueCode } from '@hapi/protocol'

export type {
    AgentState,
    AttachmentMetadata,
    CodexCollaborationMode,
    PermissionMode,
    Session,
    SessionSummary,
    SessionSummaryMetadata,
    TeamMember,
    TeamMessage,
    TeamState,
    TeamTask,
    TodoItem,
    WorktreeMetadata
} from '@hapi/protocol/types'

export type SessionMetadataSummary = {
    path: string
    host: string
    version?: string
    name?: string
    title?: string
    titleUpdatedAt?: number
    os?: string
    summary?: { text: string; updatedAt: number }
    mirrorSource?: string
    machineId?: string
    tools?: string[]
    flavor?: string | null
    worktree?: WorktreeMetadata
}

export type MessageStatus = 'sending' | 'sent' | 'failed'

export type DecryptedMessage = ProtocolDecryptedMessage & {
    status?: MessageStatus
    originalText?: string
}

export type RunnerState = {
    status?: string
    pid?: number
    httpPort?: number
    startedAt?: number
    shutdownRequestedAt?: number
    shutdownSource?: string
    lastSpawnError?: {
        message: string
        pid?: number
        exitCode?: number | null
        signal?: string | null
        at: number
    } | null
}

export type Machine = {
    id: string
    active: boolean
    metadata: MachineMetadata | null
    runnerState?: RunnerState | null
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
export type MessagePageContinuation = {
    direction: 'older' | 'newer'
    cursorSeq: number
}
export type MessagePage = {
    limit: number
    direction: 'latest' | 'older' | 'newer'
    beforeSeq: number | null
    afterSeq: number | null
    nextBeforeSeq: number | null
    nextAfterSeq: number | null
    hasMore: boolean
    hasOlder: boolean
    hasNewer: boolean
    range: { startSeq: number; endSeq: number } | null
    startComplete: boolean
    endComplete: boolean
    continuation: MessagePageContinuation | null
}
export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: MessagePage
}

export type RecentUserMessage = {
    id: string
    seq: number
    createdAt: number
    text: string
}

export type RecentUserMessagesResponse = {
    messages: RecentUserMessage[]
}

export type MachinesResponse = {
    machines: Machine[]
    knownMachinesCount: number
    offlineMachinesCount: number
    /** Hub wall clock at response time. Optional for compatibility with older Hubs. */
    serverTime?: number
}
export type MachinePathsExistsResponse = { exists: Record<string, boolean> }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'pending'; spawnRequestId: string }
    | { type: 'not_found'; spawnRequestId: string }
    | {
        type: 'error'
        message: string
        code?: ProviderReadinessIssueCode
        recoveryCommand?: string
    }

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

export type DirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
}

export type ListDirectoryResponse = {
    success: boolean
    entries?: DirectoryEntry[]
    error?: string
}

export type FileReadResponse = {
    success: boolean
    content?: string
    error?: string
}

export type UploadFileResponse = {
    success: boolean
    path?: string
    error?: string
}

export type DeleteUploadResponse = {
    success: boolean
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
    source: 'builtin' | 'user' | 'plugin' | 'project'
    content?: string  // Expanded content for Codex user prompts
    pluginName?: string
}

export type SlashCommandsResponse = {
    success: boolean
    commands?: SlashCommand[]
    error?: string
}

export type MentionSummary = {
    name: string
    label: string
    insertText: string
    description?: string
    kind: 'app' | 'plugin'
    pluginName: string
}

export type MentionsResponse = {
    success: boolean
    mentions?: MentionSummary[]
    error?: string
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
