import { z } from 'zod'
import { CODEX_COLLABORATION_MODES, PERMISSION_MODES } from './modes'

export const PermissionModeSchema = z.enum(PERMISSION_MODES)
export const CodexCollaborationModeSchema = z.enum(CODEX_COLLABORATION_MODES)
export const SessionEndReasonSchema = z.enum(['completed', 'terminated', 'error', 'handoff'])
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>

const MetadataSummarySchema = z.object({
    text: z.string(),
    updatedAt: z.number()
})

const SessionCapabilitiesSchema = z.object({
    terminal: z.boolean().optional()
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
    cursorSessionProtocol: z.enum(['acp', 'stream-json']).optional(),
    // Drives the web `CursorMigrationBanner`:
    //   'in_progress' = legacy-to-ACP transplant currently running; banner shows spinner + "Upgrading..."
    //   'ambiguous'   = migrator refused to transplant (ambiguous source drawer OR size mismatch);
    //                   banner switches to "Manual review needed" until the operator resolves on disk.
    //   undefined     = no migration in flight; banner hidden.
    // tiann/hapi#873.
    cursorMigrationState: z.enum(['in_progress', 'ambiguous']).optional(),
    kimiSessionId: z.string().optional(),
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
    preferredPermissionMode: PermissionModeSchema.optional(),
    flavor: z.string().nullish(),
    capabilities: SessionCapabilitiesSchema.optional(),
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
    priority: z.enum(['high', 'medium', 'low']).optional().default('medium'),
    id: z.string().optional().default(''),
    activeForm: z.string().optional()
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

export const ThreadGoalStatusSchema = z.enum(['active', 'paused', 'budgetLimited', 'complete'])
export type ThreadGoalStatus = z.infer<typeof ThreadGoalStatusSchema>

export const ThreadGoalSchema = z.object({
    threadId: z.string(),
    objective: z.string(),
    status: ThreadGoalStatusSchema,
    tokenBudget: z.number().nullable().optional(),
    tokensUsed: z.number().optional().default(0),
    timeUsedSeconds: z.number().optional().default(0),
    createdAt: z.number().optional().default(0),
    updatedAt: z.number().optional().default(0)
})

export type ThreadGoal = z.infer<typeof ThreadGoalSchema>

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
    createdAt: z.number(),
    invokedAt: z.number().nullable().optional(),
    scheduledAt: z.number().nullable().optional()
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
    model: z.string().nullable().optional().default(null),
    modelReasoningEffort: z.string().nullable().optional().default(null),
    effort: z.string().nullable().optional().default(null),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional()
})

export type Session = z.infer<typeof SessionSchema>

export const SessionPatchSchema = z.object({
    active: z.boolean().optional(),
    thinking: z.boolean().optional(),
    activeAt: z.number().optional(),
    updatedAt: z.number().optional(),
    model: z.string().nullable().optional(),
    modelReasoningEffort: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    backgroundTaskCount: z.number().optional()
}).strict()

export type SessionPatch = z.infer<typeof SessionPatchSchema>

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    displayName: z.string().optional(),
    homeDir: z.string().optional(),
    happyHomeDir: z.string().optional(),
    happyLibDir: z.string().optional(),
    workspaceRoots: z.array(z.string()).optional()
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

export const RunnerStateSchema = z.object({
    status: z.union([z.enum(['running', 'shutting-down']), z.string()]),
    pid: z.number().optional(),
    httpPort: z.number().optional(),
    startedAt: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.union([z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']), z.string()]).optional(),
    lastSpawnError: z.object({
        message: z.string(),
        pid: z.number().optional(),
        exitCode: z.number().nullable().optional(),
        signal: z.string().nullable().optional(),
        at: z.number()
    }).nullable().optional()
})

export type RunnerState = z.infer<typeof RunnerStateSchema>

export const MachineSchema = z.object({
    id: z.string(),
    namespace: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    metadata: MachineMetadataSchema.nullable(),
    metadataVersion: z.number(),
    runnerState: RunnerStateSchema.nullable(),
    runnerStateVersion: z.number()
})

export type Machine = z.infer<typeof MachineSchema>

export const MachinePatchSchema = z.object({
    active: z.boolean().optional(),
    activeAt: z.number().optional(),
    updatedAt: z.number().optional()
}).strict()

export type MachinePatch = z.infer<typeof MachinePatchSchema>

export const SessionUpdatedDataSchema = z.union([SessionSchema, SessionPatchSchema])
export type SessionUpdatedData = z.infer<typeof SessionUpdatedDataSchema>

export const MachineUpdatedDataSchema = z.union([MachineSchema, MachinePatchSchema, z.null()])
export type MachineUpdatedData = z.infer<typeof MachineUpdatedDataSchema>

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
        data: SessionUpdatedDataSchema.optional()
    }),
    SessionEventBaseSchema.extend({
        type: z.literal('session-removed'),
        sessionId: z.string()
    }),
    SessionChangedSchema.extend({
        type: z.literal('message-received'),
        message: DecryptedMessageSchema
    }),
    SessionChangedSchema.extend({
        type: z.literal('messages-invalidated')
    }),
    SessionChangedSchema.extend({
        type: z.literal('scheduled-matured')
    }),
    SessionChangedSchema.extend({
        type: z.literal('session-ended'),
        reason: SessionEndReasonSchema.optional()
    }),
    MachineChangedSchema.extend({
        type: z.literal('machine-updated'),
        data: MachineUpdatedDataSchema.optional()
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
    SessionChangedSchema.extend({
        type: z.literal('messages-consumed'),
        localIds: z.array(z.string()),
        invokedAt: z.number()
    }),
    SessionChangedSchema.extend({
        type: z.literal('message-cancelled'),
        messageId: z.string(),
        localId: z.string().optional()
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

export const CancelMessageResponseSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('cancelled'), localId: z.string().nullable() }),
    z.object({ status: z.literal('invoked'), message: DecryptedMessageSchema }),
])

export type CancelMessageResponse = z.infer<typeof CancelMessageResponseSchema>
