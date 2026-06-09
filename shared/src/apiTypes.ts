import { z } from 'zod'
import {
    AttachmentMetadataSchema,
    CodexCollaborationModeSchema,
    DecryptedMessageSchema,
    MachineSchema,
    PermissionModeSchema,
    SessionSchema
} from './schemas'
import { AgentFlavorSchema } from './modes'
import type {
    DecryptedMessage,
    Machine,
    Session
} from './schemas'
import type { SessionSummary } from './sessionSummary'

export const CreateOrLoadSessionRequestSchema = z.object({
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional(),
    model: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    effort: z.string().optional()
})

export type CreateOrLoadSessionRequest = z.infer<typeof CreateOrLoadSessionRequestSchema>

export const CreateOrLoadMachineRequestSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    runnerState: z.unknown().nullable().optional()
})

export type CreateOrLoadMachineRequest = z.infer<typeof CreateOrLoadMachineRequestSchema>

export const CliMessagesResponseSchema = z.object({
    messages: z.array(z.object({
        id: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        localId: z.string().nullable().optional(),
        content: z.unknown()
    }))
})

export type CliMessagesResponse = z.infer<typeof CliMessagesResponseSchema>

export const CreateSessionResponseSchema = z.object({
    session: SessionSchema
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const CreateMachineResponseSchema = z.object({
    machine: MachineSchema
})

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>

export const GetSessionResponseSchema = CreateSessionResponseSchema
export type GetSessionResponse = CreateSessionResponse

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
        nextBeforeSeq: number | null
        nextBeforeAt: number | null
        hasMore: boolean
    }
}

export type MachinesResponse = { machines: Machine[] }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }

export const SessionPermissionModeRequestSchema = z.object({
    mode: PermissionModeSchema
})

export type SessionPermissionModeRequest = z.infer<typeof SessionPermissionModeRequestSchema>

export const ResumeSessionRequestSchema = z.object({
    permissionMode: PermissionModeSchema.optional()
})

export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>

export const SessionCollaborationModeRequestSchema = z.object({
    mode: CodexCollaborationModeSchema
})

export type SessionCollaborationModeRequest = z.infer<typeof SessionCollaborationModeRequestSchema>

export type SessionModelIdentifier =
    | string
    | { provider: string; modelId: string }
    | null

export const SessionModelRequestSchema = z.object({
    model: z.union([
        z.string().trim().min(1),
        z.object({
            provider: z.string().trim().min(1),
            modelId: z.string().trim().min(1),
        }),
    ]).nullable()
})

export type SessionModelRequest = z.infer<typeof SessionModelRequestSchema>

export const SessionModelReasoningEffortRequestSchema = z.object({
    modelReasoningEffort: z.string().trim().min(1).nullable()
})

export type SessionModelReasoningEffortRequest = z.infer<typeof SessionModelReasoningEffortRequestSchema>

export const SessionEffortRequestSchema = z.object({
    effort: z.string().trim().min(1).nullable()
})

export type SessionEffortRequest = z.infer<typeof SessionEffortRequestSchema>

export const RenameSessionRequestSchema = z.object({
    name: z.string().min(1).max(255)
})

export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>

export const UploadFileRequestSchema = z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    mimeType: z.string().min(1).max(255)
})

export type UploadFileRequest = z.infer<typeof UploadFileRequestSchema>

export const DeleteUploadRequestSchema = z.object({
    path: z.string().min(1)
})

export type DeleteUploadRequest = z.infer<typeof DeleteUploadRequestSchema>

export const MessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    beforeAt: z.coerce.number().int().min(0).optional(),
}).refine((data) => (data.beforeAt === undefined) === (data.beforeSeq === undefined), {
    message: 'beforeAt and beforeSeq must be provided together',
    path: ['beforeAt'],
})

export type MessagesQuery = z.infer<typeof MessagesQuerySchema>

export const SendMessageRequestSchema = z.object({
    text: z.string(),
    localId: z.string().min(1).optional(),
    attachments: z.array(AttachmentMetadataSchema).optional(),
    scheduledAt: z.number().int().positive().nullable().optional()
}).refine(
    (data) => data.scheduledAt == null || typeof data.localId === 'string',
    { message: 'scheduledAt requires localId', path: ['localId'] }
).refine(
    (data) => data.scheduledAt == null || data.scheduledAt <= Date.now() + 7 * 24 * 60 * 60 * 1000,
    { message: 'scheduledAt must be within 7 days from now', path: ['scheduledAt'] }
).refine(
    (data) => data.scheduledAt == null || !data.attachments?.length,
    { message: 'scheduled messages with attachments are not supported', path: ['attachments'] }
)

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

export const SpawnSessionRequestSchema = z.object({
    directory: z.string().min(1),
    agent: AgentFlavorSchema.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional()
})

export type SpawnSessionRequest = z.infer<typeof SpawnSessionRequestSchema>

export const MachineListDirectoryRequestSchema = z.object({
    path: z.string().min(1)
})

export type MachineListDirectoryRequest = z.infer<typeof MachineListDirectoryRequestSchema>

export const MachinePathsExistsRequestSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

export type MachinePathsExistsRequest = z.infer<typeof MachinePathsExistsRequestSchema>

export const AuthRequestSchema = z.union([
    z.object({ initData: z.string() }),
    z.object({ accessToken: z.string() })
])

export type AuthRequest = z.infer<typeof AuthRequestSchema>

export type CommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type GitCommandResponse = CommandResponse

export type FileReadResponse = {
    success: boolean
    content?: string
    error?: string
}

export type GeneratedImageResponse = {
    success: boolean
    content?: string
    mimeType?: string
    fileName?: string
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

export type RpcListDirectoryResponse = ListDirectoryResponse

export type MachineDirectoryEntry = DirectoryEntry & {
    isGitRepo?: boolean
}

export type MachineListDirectoryResponse = {
    success: boolean
    entries?: MachineDirectoryEntry[]
    error?: string
}

export type PathExistsResponse = {
    exists: Record<string, boolean>
}

export type MachinePathsExistsResponse = PathExistsResponse

export type CodexModelSummary = {
    id: string
    displayName: string
    isDefault: boolean
    defaultReasoningEffort?: string | null
    supportedReasoningEfforts?: string[]
}

export type CodexModelsResponse = {
    success: boolean
    models?: CodexModelSummary[]
    error?: string
}

export type ListCodexModelsResponse = CodexModelsResponse

export type OpencodeModelSummary = {
    modelId: string
    name?: string
}

export type OpencodeModelsResponse = {
    success: boolean
    availableModels?: OpencodeModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListOpencodeModelsResponse = OpencodeModelsResponse

export type CursorModelSummary = OpencodeModelSummary

export type CursorModelsResponse = OpencodeModelsResponse

export type ListCursorModelsResponse = CursorModelsResponse

/** Maps thinking levels to provider-specific values. null = unsupported. */
export type PiThinkingLevelMap = Partial<Record<string, string | null>>

export type PiModelSummary = {
    provider: string
    modelId: string
    name?: string
    contextWindow?: number
    /** Whether the model supports reasoning/thinking */
    reasoning?: boolean
    /** Maps Pi thinking levels to provider values; null = unsupported level */
    thinkingLevelMap?: PiThinkingLevelMap
}

export type PiModelsResponse = {
    success: boolean
    availableModels?: PiModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListPiModelsResponse = PiModelsResponse

export type PiCommandSummary = {
    name: string
    description?: string
    source: 'extension' | 'prompt' | 'skill'
}

export type PiCommandsResponse = {
    success: boolean
    commands?: PiCommandSummary[]
    error?: string
}

export type PiSteeringMode = 'all' | 'one-at-a-time'
export type PiFollowUpMode = 'all' | 'one-at-a-time'

export type PiSteerResponse = {
    success: boolean
    error?: string
}

export type PiFollowUpResponse = {
    success: boolean
    error?: string
}

export type PiQueueModeResponse = {
    success: boolean
    error?: string
}

export type PiMessageEntry = {
    entryId: string
    role: 'user' | 'assistant'
    text: string
}

export type PiMessagesResponse = {
    success: boolean
    messages?: PiMessageEntry[]
    error?: string
}

// P3: Compact
export type PiCompactResponse = {
    success: boolean
    result?: {
        summary: string
        firstKeptEntryId: string
        tokensBefore: number
    }
    error?: string
}

export type PiSetAutoCompactionResponse = {
    success: boolean
    error?: string
}

// P3: Fork
export type PiForkResponse = {
    success: boolean
    text?: string
    error?: string
}

export type PiForkMessageEntry = {
    entryId: string
    text: string
}

export type PiForkMessagesResponse = {
    success: boolean
    messages?: PiForkMessageEntry[]
    error?: string
}

// P3: Clone
export type PiCloneResponse = {
    success: boolean
    error?: string
}

// P3: Switch session
export type PiSwitchSessionResponse = {
    success: boolean
    error?: string
}

// P3: Session stats
export type PiSessionStats = {
    sessionId: string
    userMessages: number
    assistantMessages: number
    toolCalls: number
    totalMessages: number
    tokens: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        total: number
    }
    cost: number
}

export type PiSessionStatsResponse = {
    success: boolean
    stats?: PiSessionStats
    error?: string
}

// P3: HTML export
export type PiExportHtmlResponse = {
    success: boolean
    path?: string
    error?: string
}

export type ListPiCommandsResponse = PiCommandsResponse

export type SlashCommand = {
    name: string
    description?: string
    source: 'builtin' | 'user' | 'plugin' | 'project'
    content?: string
    pluginName?: string
}

export type SlashCommandsResponse = {
    success: boolean
    commands?: SlashCommand[]
    error?: string
}
