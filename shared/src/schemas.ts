import { z } from 'zod'
import { CODEX_COLLABORATION_MODES, PERMISSION_MODES } from './modes'

export const PermissionModeSchema = z.enum(PERMISSION_MODES)
export const CodexCollaborationModeSchema = z.enum(CODEX_COLLABORATION_MODES)

const MetadataSummarySchema = z.object({
    text: z.string(),
    updatedAt: z.number()
})

export const WorktreeMetadataSchema = z.object({
    basePath: z.string(),
    branch: z.string(),
    name: z.string(),
    worktreePath: z.string().optional(),
    createdAt: z.number().optional()
})

export type WorktreeMetadata = z.infer<typeof WorktreeMetadataSchema>

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: MetadataSummarySchema.optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(),
    codexSessionId: z.string().optional(),
    geminiSessionId: z.string().optional(),
    opencodeSessionId: z.string().optional(),
    cursorSessionId: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(),
    happyHomeDir: z.string().optional(),
    happyLibDir: z.string().optional(),
    happyToolsDir: z.string().optional(),
    startedFromRunner: z.boolean().optional(),
    hostPid: z.number().optional(),
    startedBy: z.enum(['runner', 'terminal']).optional(),
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    flavor: z.string().nullish(),
    worktree: WorktreeMetadataSchema.optional()
})

export type Metadata = z.infer<typeof MetadataSchema>

export const AgentStateRequestSchema = z.object({
    tool: z.string(),
    arguments: z.unknown(),
    createdAt: z.number().nullish()
})

export type AgentStateRequest = z.infer<typeof AgentStateRequestSchema>

export const AgentStateCompletedRequestSchema = z.object({
    tool: z.string(),
    arguments: z.unknown(),
    createdAt: z.number().nullish(),
    completedAt: z.number().nullish(),
    status: z.enum(['canceled', 'denied', 'approved']),
    reason: z.string().optional(),
    mode: z.string().optional(),
    decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
    allowTools: z.array(z.string()).optional(),
    // Flat format: Record<string, string[]> (AskUserQuestion)
    // Nested format: Record<string, { answers: string[] }> (request_user_input)
    answers: z.union([
        z.record(z.string(), z.array(z.string())),
        z.record(z.string(), z.object({ answers: z.array(z.string()) }))
    ]).optional()
})

export type AgentStateCompletedRequest = z.infer<typeof AgentStateCompletedRequestSchema>

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), AgentStateRequestSchema).nullish(),
    completedRequests: z.record(z.string(), AgentStateCompletedRequestSchema).nullish()
})

export type AgentState = z.infer<typeof AgentStateSchema>

export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']),
    id: z.string()
})

export type TodoItem = z.infer<typeof TodoItemSchema>

export const TodosSchema = z.array(TodoItemSchema)

export const TeamMemberSchema = z.object({
    name: z.string(),
    agentType: z.string().optional(),
    status: z.enum(['active', 'idle', 'shutdown']).optional()
})

export type TeamMember = z.infer<typeof TeamMemberSchema>

export const TeamTaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
    owner: z.string().optional()
})

export type TeamTask = z.infer<typeof TeamTaskSchema>

export const TeamMessageSchema = z.object({
    from: z.string(),
    to: z.string(),
    summary: z.string(),
    type: z.enum(['message', 'broadcast', 'shutdown_request', 'shutdown_response']),
    timestamp: z.number()
})

export type TeamMessage = z.infer<typeof TeamMessageSchema>

export const TeamStateSchema = z.object({
    teamName: z.string(),
    description: z.string().optional(),
    members: z.array(TeamMemberSchema).optional(),
    tasks: z.array(TeamTaskSchema).optional(),
    messages: z.array(TeamMessageSchema).optional(),
    updatedAt: z.number().optional()
})

export type TeamState = z.infer<typeof TeamStateSchema>

export const AttachmentMetadataSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    path: z.string(),
    previewUrl: z.string().optional()
})

export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>

export const DecryptedMessageSchema = z.object({
    id: z.string(),
    seq: z.number().nullable(),
    localId: z.string().nullable(),
    content: z.unknown(),
    createdAt: z.number()
})

export type DecryptedMessage = z.infer<typeof DecryptedMessageSchema>

export const SessionSchema = z.object({
    id: z.string(),
    namespace: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    metadata: MetadataSchema.nullable(),
    metadataVersion: z.number(),
    agentState: AgentStateSchema.nullable(),
    agentStateVersion: z.number(),
    thinking: z.boolean(),
    thinkingAt: z.number(),
    backgroundTaskCount: z.number().optional(),
    todos: TodosSchema.optional(),
    teamState: TeamStateSchema.optional(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional()
})

export type Session = z.infer<typeof SessionSchema>

const SessionEventBaseSchema = z.object({
    namespace: z.string().optional()
})

const SessionChangedSchema = SessionEventBaseSchema.extend({
    sessionId: z.string()
})

const MachineChangedSchema = SessionEventBaseSchema.extend({
    machineId: z.string()
})

export const SyncEventSchema = z.discriminatedUnion('type', [
    SessionChangedSchema.extend({
        type: z.literal('session-added'),
        data: z.unknown().optional()
    }),
    SessionChangedSchema.extend({
        type: z.literal('session-updated'),
        data: z.unknown().optional()
    }),
    SessionEventBaseSchema.extend({
        type: z.literal('session-removed'),
        sessionId: z.string()
    }),
    SessionChangedSchema.extend({
        type: z.literal('message-received'),
        message: DecryptedMessageSchema
    }),
    MachineChangedSchema.extend({
        type: z.literal('machine-updated'),
        data: z.unknown().optional()
    }),
    SessionEventBaseSchema.extend({
        type: z.literal('toast'),
        data: z.object({
            title: z.string(),
            body: z.string(),
            sessionId: z.string(),
            url: z.string()
        })
    }),
    SessionEventBaseSchema.extend({
        type: z.literal('heartbeat'),
        data: z.object({
            timestamp: z.number()
        }).optional()
    }),
    SessionEventBaseSchema.extend({
        type: z.literal('connection-changed'),
        data: z.object({
            status: z.string(),
            subscriptionId: z.string().optional()
        }).optional()
    })
])

export type SyncEvent = z.infer<typeof SyncEventSchema>
