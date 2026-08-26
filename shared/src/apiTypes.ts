import { z } from 'zod'
import {
    AttachmentMetadataSchema,
    CodexCollaborationModeSchema,
    CopilotAgentModeSchema,
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

export const CreateOrLoadMachineRequestSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    runnerState: z.unknown().nullable().optional()
})

export type CreateOrLoadMachineRequest = z.infer<typeof CreateOrLoadMachineRequestSchema>

export const CreateOrLoadSessionRequestSchema = z.object({
    id: z.string().uuid().optional(),
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional(),
    model: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    effort: z.string().optional(),
    machine: CreateOrLoadMachineRequestSchema.optional()
})

export type CreateOrLoadSessionRequest = z.infer<typeof CreateOrLoadSessionRequestSchema>

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
    session: SessionSchema,
    /** Hub opt-in for AGENT_NOTIFY_SUMMARY prompt injection (default off when omitted). */
    sessionSummaryContract: z.boolean().optional()
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const HubSettingsResponseSchema = z.object({
    sessionSummaryContract: z.boolean(),
    /** Show compact AGENT_NOTIFY_SUMMARY in chat (default off / hide). */
    sessionSummaryInChat: z.boolean()
})

export type HubSettingsResponse = z.infer<typeof HubSettingsResponseSchema>

export const UpdateHubSettingsRequestSchema = z
    .object({
        sessionSummaryContract: z.boolean().optional(),
        sessionSummaryInChat: z.boolean().optional()
    })
    .refine(
        (data) => data.sessionSummaryContract !== undefined || data.sessionSummaryInChat !== undefined,
        { message: 'At least one hub setting field is required' }
    )

export type UpdateHubSettingsRequest = z.infer<typeof UpdateHubSettingsRequestSchema>

export const CreateMachineResponseSchema = z.object({
    machine: MachineSchema
})

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>

export const GetSessionResponseSchema = CreateSessionResponseSchema
export type GetSessionResponse = CreateSessionResponse

export const ClearOpencodeSessionResponseSchema = z.object({
    ok: z.literal(true),
    sessionId: z.string()
})
export type ClearOpencodeSessionResponse = z.infer<typeof ClearOpencodeSessionResponseSchema>

export const ClearOpencodeSessionCallbackRequestSchema = z.object({
    replacementSessionId: z.string()
})
export type ClearOpencodeSessionCallbackRequest = z.infer<typeof ClearOpencodeSessionCallbackRequestSchema>

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
        direction: 'latest' | 'before' | 'after'
        limit: number
        epoch: number
        reset: boolean
        nextBeforeSeq: number | null
        nextBeforeAt: number | null
        nextAfterSeq: number | null
        nextAfterAt: number | null
        snapshotHeadSeq: number | null
        snapshotHeadAt: number | null
        hasMore: boolean
    }
}

export type MachinesResponse = { machines: Machine[] }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | {
        type: 'error'
        message: string
        code?: 'agent_unavailable' | 'runner_upgrade_required' | 'outside_workspace_roots'
        agent?: z.infer<typeof AgentFlavorSchema>
    }

export const SessionPermissionModeRequestSchema = z.object({
    mode: PermissionModeSchema
})

export type SessionPermissionModeRequest = z.infer<typeof SessionPermissionModeRequestSchema>

export const ResumeSessionRequestSchema = z.object({
    permissionMode: PermissionModeSchema.optional()
})

export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>

export const ReopenSessionResponseSchema = z.object({
    ok: z.literal(true),
    sessionId: z.string(),
    resumed: z.boolean(),
    cursorSessionProtocol: z.enum(['acp', 'stream-json']).optional()
})

export type ReopenSessionResponse = z.infer<typeof ReopenSessionResponseSchema>

export const ReopenSessionMissingMetadataResponseSchema = z.object({
    error: z.string(),
    missing: z.array(z.string()).nonempty()
})

export type ReopenSessionMissingMetadataResponse = z.infer<typeof ReopenSessionMissingMetadataResponseSchema>

export const CursorChatStoreStatusSchema = z.object({
    onDisk: z.boolean(),
    store: z.enum(['legacy', 'acp']).nullable()
})

export type CursorChatStoreStatus = z.infer<typeof CursorChatStoreStatusSchema>

export const CodexImportedMessageSchema = z.union([
    z.object({
        role: z.literal('user'),
        content: z.object({ type: z.literal('text'), text: z.string() }),
        meta: z.object({ sentFrom: z.literal('cli') })
    }),
    z.object({
        role: z.literal('agent'),
        content: z.object({ type: z.literal('codex'), data: z.unknown() }),
        meta: z.object({ sentFrom: z.literal('cli') })
    }),
    z.object({
        role: z.literal('agent'),
        content: z.object({ type: z.literal('event'), data: z.unknown() }),
        meta: z.object({ sentFrom: z.literal('cli') })
    })
])

export const CodexLocalSessionSummarySchema = z.object({
    id: z.string().min(1),
    title: z.string(),
    lastUserMessage: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    file: z.string().min(1),
    modifiedAt: z.number(),
    originator: z.string().nullable().optional(),
    cliVersion: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    threadSource: z.string().nullable().optional(),
    forkedFromId: z.string().nullable().optional()
})

export const CodexLocalSessionWithMessagesSchema = CodexLocalSessionSummarySchema.extend({
    messages: z.array(CodexImportedMessageSchema)
})

export const ListCodexSessionsRpcRequestSchema = z.object({
    cwd: z.string().nullable().optional(),
    sessionIds: z.array(z.string().min(1)).optional()
})

export const ListCodexSessionsRpcResponseSchema = z.union([
    z.object({ success: z.literal(true), sessions: z.array(z.union([CodexLocalSessionWithMessagesSchema, CodexLocalSessionSummarySchema])) }),
    z.object({ success: z.literal(false), error: z.string() })
])

export const ArchiveCodexSessionRpcRequestSchema = z.object({ sessionId: z.string().min(1) })
export const ArchiveCodexSessionRpcResponseSchema = z.union([
    z.object({ success: z.literal(true), archivedPath: z.string() }),
    z.object({ success: z.literal(false), error: z.string() })
])

export type ListCodexSessionsRpcRequest = z.infer<typeof ListCodexSessionsRpcRequestSchema>
export type ListCodexSessionsRpcResponse = z.infer<typeof ListCodexSessionsRpcResponseSchema>
export type ArchiveCodexSessionRpcRequest = z.infer<typeof ArchiveCodexSessionRpcRequestSchema>
export type ArchiveCodexSessionRpcResponse = z.infer<typeof ArchiveCodexSessionRpcResponseSchema>

export const PiImportedMessageContentSchema = CodexImportedMessageSchema

export const PiImportedMessageSchema = z.object({
    localId: z.string().min(1),
    entryId: z.string().min(1),
    parentEntryId: z.string().nullable().optional(),
    createdAt: z.number(),
    content: PiImportedMessageContentSchema
})

export const PiLocalSessionSummarySchema = z.object({
    id: z.string().min(1),
    title: z.string(),
    lastUserMessage: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    file: z.string().min(1),
    modifiedAt: z.number(),
    model: z.string().nullable().optional(),
    thinkingLevel: z.string().nullable().optional(),
    leafEntryId: z.string().nullable().optional(),
    messageCount: z.number().int().nonnegative()
})

export const PiLocalSessionWithMessagesSchema = PiLocalSessionSummarySchema.extend({
    messages: z.array(PiImportedMessageSchema),
    activeEntryIds: z.array(z.string().min(1))
})

export const ListPiSessionsRpcRequestSchema = z.object({
    cwd: z.string().nullable().optional(),
    sessionIds: z.array(z.string().min(1)).optional()
})

export const ListPiSessionsRpcResponseSchema = z.union([
    z.object({ success: z.literal(true), sessions: z.array(z.union([PiLocalSessionWithMessagesSchema, PiLocalSessionSummarySchema])) }),
    z.object({ success: z.literal(false), error: z.string() })
])

export type PiImportedMessageContent = z.infer<typeof PiImportedMessageContentSchema>
export type PiImportedMessage = z.infer<typeof PiImportedMessageSchema>
export type PiLocalSessionSummary = z.infer<typeof PiLocalSessionSummarySchema>
export type PiLocalSessionWithMessages = z.infer<typeof PiLocalSessionWithMessagesSchema>
export type ListPiSessionsRpcRequest = z.infer<typeof ListPiSessionsRpcRequestSchema>
export type ListPiSessionsRpcResponse = z.infer<typeof ListPiSessionsRpcResponseSchema>

export const SessionCollaborationModeRequestSchema = z.object({
    mode: CodexCollaborationModeSchema
})

export type SessionCollaborationModeRequest = z.infer<typeof SessionCollaborationModeRequestSchema>

export const SessionCopilotAgentModeRequestSchema = z.object({
    mode: CopilotAgentModeSchema
})

export type SessionCopilotAgentModeRequest = z.infer<typeof SessionCopilotAgentModeRequestSchema>

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

// Fast mode is an explicit two-way choice. `'standard'` (not `null`) is the
// stored sentinel for an explicit Fast-off so it stays distinct from
// "untouched" and survives restart/resume. Reject anything else so stray tier
// strings are never forwarded to the Codex app-server.
export const SessionServiceTierRequestSchema = z.object({
    serviceTier: z.enum(['fast', 'standard'])
})

export type SessionServiceTierRequest = z.infer<typeof SessionServiceTierRequestSchema>

export const RenameSessionRequestSchema = z.object({
    name: z.string().min(1).max(255)
})

export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>

export const UpdateSessionSummaryRequestSchema = z.object({
    text: z.string().trim().min(1).max(255)
})

export type UpdateSessionSummaryRequest = z.infer<typeof UpdateSessionSummaryRequestSchema>

export const SessionTitleSuggestionResponseSchema = z.object({
    title: z.string().min(1).max(255)
})

export type SessionTitleSuggestionResponse = z.infer<typeof SessionTitleSuggestionResponseSchema>

export const SetSessionPinnedRequestSchema = z.object({
    mode: z.enum(['none', 'project', 'global'])
})

export type SetSessionPinnedRequest = z.infer<typeof SetSessionPinnedRequestSchema>
export type SessionPinMode = SetSessionPinnedRequest['mode']

/**
 * An empty string clears the custom name, so unlike session rename there is no
 * `min(1)`: the machine falls back to its hostname. The length ceiling is
 * enforced after trimming, so it is not expressed here.
 */
export const RenameMachineRequestSchema = z.object({
    displayName: z.string()
})

export type RenameMachineRequest = z.infer<typeof RenameMachineRequestSchema>

export const MACHINE_DISPLAY_NAME_MAX_LENGTH = 64


/**
 * Scratchlist v2 (tiann/hapi#893) per-entry caps.
 *
 * `MAX_ENTRIES` (200) is a per-session ceiling: refuses to create entry
 * 201 on the hub. Mirrors `SCRATCHLIST_MAX_ENTRIES` in
 * `web/src/lib/scratchlist.ts` so the hub and web agree on the limit -
 * the web side has UX for the cap (disabled add button + atCap hint),
 * the hub side enforces it as a server-side guard against malicious /
 * runaway clients writing arbitrary amounts.
 *
 * `MAX_TEXT_LENGTH` (10_000) is the per-entry text cap. Mirrors
 * `SCRATCHLIST_MAX_TEXT_LENGTH`. The web side truncates rather than
 * rejects; the hub-side schema allows up to this length and rejects
 * anything longer with 400.
 */
export const SCRATCHLIST_MAX_ENTRIES = 200
export const SCRATCHLIST_MAX_TEXT_LENGTH = 10_000
/**
 * Hard cap on client-supplied entry id length. The id is persisted as
 * part of the SQLite primary key, so without a bound an authenticated
 * client could grow the table and its index with arbitrarily large
 * keys. 128 chars comfortably fits a UUID (36) plus any prefix scheme
 * we might layer on later.
 */
export const SCRATCHLIST_MAX_ENTRY_ID_LENGTH = 128

import { ScratchlistAttachmentsArraySchema } from './scratchlistAttachments'

export const ScratchlistEntryCreateRequestSchema = z.object({
    /**
     * Optional client-supplied entry id. Lets the web client preserve its
     * pre-v2 localStorage entry ids during migration so the optimistic-
     * update path doesn't have to re-key entries already in the React
     * tree. New entries created post-v2 can omit this and let the hub
     * generate one.
     */
    entryId: z.string().min(1).max(SCRATCHLIST_MAX_ENTRY_ID_LENGTH).optional(),
    text: z.string().max(SCRATCHLIST_MAX_TEXT_LENGTH).default(''),
    attachments: ScratchlistAttachmentsArraySchema.optional().default([]),
    /**
     * Optional client-supplied createdAt. Used by the migration path to
     * preserve the original timestamps from localStorage. New entries
     * omit this and let the hub stamp `Date.now()`.
     */
    createdAt: z.number().int().nonnegative().optional()
}).refine(
    (data) => data.text.trim().length > 0 || data.attachments.length > 0,
    { message: 'Scratchlist entry requires text or attachments', path: ['text'] }
)

export type ScratchlistEntryCreateRequest = z.infer<typeof ScratchlistEntryCreateRequestSchema>

export const ScratchlistEntryUpdateRequestSchema = z.object({
    text: z.string().max(SCRATCHLIST_MAX_TEXT_LENGTH).optional(),
    attachments: ScratchlistAttachmentsArraySchema.optional(),
}).refine(
    (data) => data.text !== undefined || data.attachments !== undefined,
    { message: 'Update requires text and/or attachments', path: ['text'] }
).refine(
    (data) => {
        // Attachments-only patch may clear the list (`[]`) while keeping text.
        if (data.text === undefined && data.attachments !== undefined) {
            return true
        }
        if (data.text !== undefined && data.attachments === undefined) {
            return data.text.trim().length > 0
        }
        if (data.text !== undefined && data.attachments !== undefined) {
            return data.text.trim().length > 0 || data.attachments.length > 0
        }
        return true
    },
    { message: 'Scratchlist entry requires non-empty text or attachments', path: ['text'] }
)

export type ScratchlistEntryUpdateRequest = z.infer<typeof ScratchlistEntryUpdateRequestSchema>

/** Per-session legacy stream-json → ACP migrator request. See tiann/hapi#824. */
export const CursorMigrateToAcpRequestSchema = z.object({
    /** Skip removing the legacy ~/.cursor/chats source store.db even after verify passes. */
    keepSource: z.boolean().optional(),
    /** Allow migrating a session whose lifecycleState === 'running' by archiving it first. */
    forceArchiveRunning: z.boolean().optional(),
    /** Skip the verify-by-prompt step (session/load alone is run). */
    skipVerify: z.boolean().optional()
})

export type CursorMigrateToAcpRequest = z.infer<typeof CursorMigrateToAcpRequestSchema>

export type CursorMigrateOutcome =
    | { ok: true; sessionId: string; acpSessionId: string; replayNotifications: number; durationMs: number; lastUsedModelPreserved: string | null; sourceRemoved: boolean }
    | { ok: false; sessionId: string; reason: CursorMigrateRefusalReason; message: string; durationMs: number }

export type CursorMigrateRefusalReason =
    | 'not_cursor_session'
    | 'already_acp'
    | 'running_refused'
    | 'no_cursor_session_id'
    | 'no_legacy_store_on_disk'
    | 'target_already_exists'
    | 'verify_load_failed'
    | 'verify_prompt_failed'
    | 'metadata_write_failed'
    | 'archive_failed'
    | 'lock_release_timeout'
    | 'acp_transport_active'
    | 'session_resumed_during_migrate'
    | 'legacy_store_modified_during_migrate'
    | 'cross_host_session'
    | 'ambiguous_legacy_store'
    | 'size_mismatch'
    | 'internal_error'

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
    afterSeq: z.coerce.number().int().min(1).optional(),
    afterAt: z.coerce.number().int().min(0).optional(),
    untilSeq: z.coerce.number().int().min(1).optional(),
    untilAt: z.coerce.number().int().min(0).optional(),
    epoch: z.coerce.number().int().min(0).optional(),
})
    .refine((data) => (data.beforeAt === undefined) === (data.beforeSeq === undefined), {
        message: 'beforeAt and beforeSeq must be provided together',
        path: ['beforeAt'],
    })
    .refine((data) => (data.afterAt === undefined) === (data.afterSeq === undefined), {
        message: 'afterAt and afterSeq must be provided together',
        path: ['afterAt'],
    })
    .refine((data) => (data.untilAt === undefined) === (data.untilSeq === undefined), {
        message: 'untilAt and untilSeq must be provided together',
        path: ['untilAt'],
    })
    .refine((data) => data.beforeAt === undefined || data.afterAt === undefined, {
        message: 'before and after cursors are mutually exclusive',
        path: ['afterAt'],
    })
    .refine((data) => data.untilAt === undefined || data.afterAt !== undefined, {
        message: 'until cursor requires an after cursor',
        path: ['untilAt'],
    })
    .refine((data) => data.epoch === undefined || data.afterAt !== undefined, {
        message: 'epoch requires an after cursor',
        path: ['epoch'],
    })

export type MessagesQuery = z.infer<typeof MessagesQuerySchema>

export const MessageDeliveryModeSchema = z.enum(['queue', 'steer'])
export type MessageDeliveryMode = z.infer<typeof MessageDeliveryModeSchema>

export const SendMessageRequestSchema = z.object({
    text: z.string(),
    localId: z.string().min(1).optional(),
    attachments: z.array(AttachmentMetadataSchema).optional(),
    scheduledAt: z.number().int().positive().nullable().optional(),
    deliveryMode: MessageDeliveryModeSchema.optional()
}).refine(
    (data) => data.scheduledAt == null || typeof data.localId === 'string',
    { message: 'scheduledAt requires localId', path: ['localId'] }
).refine(
    (data) => data.scheduledAt == null || data.scheduledAt <= Date.now() + 7 * 24 * 60 * 60 * 1000,
    { message: 'scheduledAt must be within 7 days from now', path: ['scheduledAt'] }
).refine(
    (data) => data.scheduledAt == null || !data.attachments?.length,
    { message: 'scheduled messages with attachments are not supported', path: ['attachments'] }
).refine(
    (data) => data.scheduledAt == null || data.deliveryMode !== 'steer',
    { message: 'scheduled messages cannot use steer delivery', path: ['deliveryMode'] }
)

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

export const ForkConversationRequestSchema = z.object({
    messageLocalId: z.string().min(1).optional()
})

export type ForkConversationRequest = z.infer<typeof ForkConversationRequestSchema>

export type ForkConversationResponse = {
    sessionId: string
}

export const RewindConversationRequestSchema = z.object({
    messageLocalId: z.string().min(1)
})

export type RewindConversationRequest = z.infer<typeof RewindConversationRequestSchema>

export type RewindConversationResponse = {
    success: true
}

/** CLI → hub RPC result for native fork (before HAPI child binding). */
export type ForkConversationRpcResult = {
    nativeSessionId: string
    /** When true, hub must spawn with --fork-session (Claude). */
    forkSession?: boolean
}

export type RewindConversationRpcResult = {
    success: true
    /** Truncate HAPI transcript at/after this localId, then accept rehydrated history. */
    truncateFromLocalId: string
    messages?: Array<{
        content: unknown
        localId?: string | null
        createdAt?: number
        invokedAt?: number | null
    }>
} | {
    success: false
    error: string
    /** Native state is unchanged, cancelled, or was restored exactly. */
    outcome: 'rejected' | 'cancelled' | 'source_restored'
}

export const QueuedStateRequestSchema = z.object({
    localIds: z.array(z.string().min(1)).max(1000)
})

export type QueuedStateRequest = z.infer<typeof QueuedStateRequestSchema>

export type QueuedStateResponse = {
    queuedLocalIds: string[]
    indeterminateLocalIds?: string[]
    invokedLocalMessages: Array<{
        localId: string
        invokedAt: number
    }>
}

export const SpawnSessionRequestSchema = z.object({
    directory: z.string().min(1),
    agent: AgentFlavorSchema.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    yolo: z.boolean().optional(),
    permissionMode: PermissionModeSchema.optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional(),
    serviceTier: z.enum(['fast', 'standard']).optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    copilotAgentMode: CopilotAgentModeSchema.optional(),
    startingMode: z.enum(['remote', 'pty']).optional()
})

export type SpawnSessionRequest = z.infer<typeof SpawnSessionRequestSchema>

export const MachineListDirectoryRequestSchema = z.object({
    path: z.string().min(1),
    includeHidden: z.boolean().optional()
})

export type MachineListDirectoryRequest = z.infer<typeof MachineListDirectoryRequestSchema>

export const MachinePathsExistsRequestSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

export type MachinePathsExistsRequest = z.infer<typeof MachinePathsExistsRequestSchema>

export const AgentAvailabilityReasonSchema = z.enum(['not_found', 'invalid_configuration'])
export type AgentAvailabilityReason = z.infer<typeof AgentAvailabilityReasonSchema>

export const AgentAvailabilityEntrySchema = z.object({
    agent: AgentFlavorSchema,
    available: z.boolean(),
    reason: AgentAvailabilityReasonSchema.optional()
})
export type AgentAvailabilityEntry = z.infer<typeof AgentAvailabilityEntrySchema>

export const AgentAvailabilityResponseSchema = z.object({
    agents: z.array(AgentAvailabilityEntrySchema)
})
export type AgentAvailabilityResponse = z.infer<typeof AgentAvailabilityResponseSchema>

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
    size?: number
    modified?: number
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

export type FileMetadataEntry = {
    path: string
    size?: number
    modified?: number
}

export type StatFilesResponse = {
    success: boolean
    entries?: FileMetadataEntry[]
    error?: string
}

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
    /** Requested paths rejected by the runner's configured workspace roots. */
    outsideWorkspaceRoots?: string[]
}

export type MachinePathsExistsResponse = PathExistsResponse

export type CodexModelSummary = {
    id: string
    displayName: string
    isDefault: boolean
    defaultReasoningEffort?: string | null
    defaultServiceTier?: string | null
    supportedReasoningEfforts?: string[]
    /** Service tier ids advertised for this model in the current auth/plan context (e.g. 'fast'). */
    serviceTiers?: string[]
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
    /** CLI `agent --list-models` skus grouped under ACP wire bases for variant pickers. */
    cliModelSkus?: OpencodeModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListOpencodeModelsResponse = OpencodeModelsResponse

export type GrokModelSummary = {
    modelId: string
    name?: string
    reasoningEfforts?: GrokReasoningEffortOption[]
}

export type GrokReasoningEffortOption = {
    value: string
    name?: string
    isDefault?: boolean
}

export type GrokModelsResponse = {
    success: boolean
    availableModels?: GrokModelSummary[]
    currentModelId?: string | null
    autoPermissionModeSupported?: boolean
    error?: string
}
export type ListGrokModelsResponse = GrokModelsResponse

export type CopilotModelSummary = {
    modelId: string
    name?: string
}

export type CopilotModelsResponse = {
    success: boolean
    availableModels?: CopilotModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListCopilotModelsResponse = CopilotModelsResponse

export type GrokReasoningEffortResponse = {
    success: boolean
    options?: GrokReasoningEffortOption[]
    currentValue?: string | null
    error?: string
}

export type OpencodeReasoningEffortOption = {
    value: string
    name?: string
}

export type OpencodeReasoningEffortResponse = {
    success: boolean
    options?: OpencodeReasoningEffortOption[]
    currentValue?: string | null
    error?: string
}

export type AgyModelSummary = {
    modelId: string
    name?: string
}

export type AgyModelsResponse = {
    success: boolean
    availableModels?: AgyModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListAgyModelsResponse = AgyModelsResponse

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

export type SqliteStorageUsageResponse = {
    path: string
    databaseBytes: number
    walBytes: number
    shmBytes: number
    totalBytes: number
}

export type UsageSummaryBucket = {
    key: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    totalTokens: number
    uncachedTokens: number
    requests: number
}

export type UsageSummaryResponse = {
    range: {
        from: number | null
        to: number | null
    }
    totals: {
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        cacheCreationTokens: number
        totalTokens: number
        uncachedTokens: number
        requests: number
        sessions: number
    }
    daily: Array<UsageSummaryBucket & { key: string }>
    byAgent: UsageSummaryBucket[]
    byModel: UsageSummaryBucket[]
    updatedAt: number
}
