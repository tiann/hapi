import { z } from 'zod'
import { AGENT_FLAVORS, CODEX_COLLABORATION_MODES, CODEX_SERVICE_TIERS, PERMISSION_MODES } from './modes'

export const PermissionModeSchema = z.enum(PERMISSION_MODES)
export const CodexCollaborationModeSchema = z.enum(CODEX_COLLABORATION_MODES)
export const CodexServiceTierSchema = z.enum(CODEX_SERVICE_TIERS)

export const ProviderReadinessStatusSchema = z.enum([
    'ready',
    'not-installed',
    'not-authenticated',
    'unsupported-version',
    'probe-failed'
])

export const ProviderAuthCheckSchema = z.enum(['command', 'credential-file', 'unavailable'])

export const ProviderReadinessSchema = z.object({
    status: ProviderReadinessStatusSchema,
    installed: z.boolean(),
    authenticated: z.boolean().nullable(),
    authCheck: ProviderAuthCheckSchema,
    version: z.string().min(1).nullable(),
    minimumVersion: z.string().min(1).nullable(),
    modes: z.array(PermissionModeSchema),
    models: z.array(z.string().min(1)),
    efforts: z.record(z.string(), z.array(z.string().min(1))),
    attachments: z.boolean(),
    resume: z.boolean(),
    experimental: z.boolean(),
    checkedAt: z.number().nonnegative()
}).strict().superRefine((entry, ctx) => {
    const issue = (message: string, path: (string | number)[]) => {
        ctx.addIssue({ code: 'custom', message, path })
    }

    if (entry.status === 'ready') {
        if (!entry.installed) issue('ready providers must be installed', ['installed'])
        if (entry.version === null) issue('ready providers must report a version', ['version'])
        if (entry.authenticated === false) issue('ready providers cannot report failed authentication', ['authenticated'])
        if (entry.authenticated === null && entry.authCheck !== 'unavailable') {
            issue('ready providers may omit authentication only when no safe auth check exists', ['authCheck'])
        }
    }

    if (entry.status === 'not-installed') {
        if (entry.installed) issue('not-installed providers cannot be installed', ['installed'])
        if (entry.version !== null) issue('not-installed providers cannot report a version', ['version'])
        if (entry.authenticated === true) issue('not-installed providers cannot be authenticated', ['authenticated'])
    } else if (!entry.installed) {
        issue('only not-installed providers may report installed=false', ['installed'])
    }

    if (entry.status === 'not-authenticated') {
        if (!entry.installed) issue('not-authenticated providers must be installed', ['installed'])
        if (entry.authenticated !== false) issue('not-authenticated providers must report authenticated=false', ['authenticated'])
        if (entry.version === null) issue('not-authenticated providers must report a version', ['version'])
        if (entry.authCheck === 'unavailable') issue('not-authenticated requires an explicit authentication check', ['authCheck'])
    }

    if (entry.status === 'unsupported-version') {
        if (!entry.installed) issue('unsupported-version providers must be installed', ['installed'])
        if (entry.version === null) issue('unsupported-version providers must report a version', ['version'])
    }

    if (entry.authCheck === 'unavailable' && entry.authenticated !== null) {
        issue('unavailable auth checks must report authenticated=null', ['authenticated'])
    }
})

export type ProviderReadinessStatus = z.infer<typeof ProviderReadinessStatusSchema>
export type ProviderAuthCheck = z.infer<typeof ProviderAuthCheckSchema>
export type ProviderReadiness = z.infer<typeof ProviderReadinessSchema>

const providerReadinessShape = Object.fromEntries(
    AGENT_FLAVORS.map((flavor) => [flavor, ProviderReadinessSchema.optional()])
) as Record<typeof AGENT_FLAVORS[number], z.ZodOptional<typeof ProviderReadinessSchema>>

export const ProviderReadinessMapSchema = z.object(providerReadinessShape).strict()
export type ProviderReadinessMap = z.infer<typeof ProviderReadinessMapSchema>

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    displayName: z.string().optional(),
    homeDir: z.string().optional(),
    happyHomeDir: z.string().optional(),
    happyLibDir: z.string().optional(),
    providerReadiness: ProviderReadinessMapSchema.optional()
}).strict()

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

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

export const ExecutionControlOwnerSchema = z.enum(['desktop-sync', 'hapi-runner'])

export const ManagedLifecycleStateSchema = z.enum(['running', 'archived', 'stopped', 'unhealthy'])
export type ManagedLifecycleState = z.infer<typeof ManagedLifecycleStateSchema>

export const ManagedStoppedBySchema = z.enum(['runner-recycle', 'runner-forced'])
export type ManagedStoppedBy = z.infer<typeof ManagedStoppedBySchema>

export const ManagedStopReasonSchema = z.enum([
    'runner-recycle',
    'runner-recycle-sigkill',
    'stale-owner-term',
    'stale-owner-sigkill',
    'ambiguous-turn-delivery'
])
export type ManagedStopReason = z.infer<typeof ManagedStopReasonSchema>

export const DeliveryAttemptStateSchema = z.enum([
    'prepared',
    'written',
    'accepted',
    'definitive-rejected',
    'definitive-no-write',
    'ambiguous',
    'canceled',
    'superseded'
])
export type DeliveryAttemptState = z.infer<typeof DeliveryAttemptStateSchema>

export const ExecutionControlSchema = z.object({
    owner: ExecutionControlOwnerSchema,
    generation: z.number().int().min(1),
    leaseExpiresAt: z.number().nullable(),
    runnerSessionId: z.string().nullable(),
    updatedAt: z.number()
})

export type ExecutionControl = z.infer<typeof ExecutionControlSchema>

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    titleUpdatedAt: z.number().optional(),
    os: z.string().optional(),
    summary: MetadataSummarySchema.optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(),
    codexSessionId: z.string().optional(),
    agySessionId: z.string().optional(),
    grokSessionId: z.string().optional(),
    grokCapabilities: z.object({
        version: z.string().nullable(),
        loadSession: z.boolean(),
        image: z.boolean(),
        currentModel: z.string().nullable(),
        currentEffort: z.string().nullable(),
        models: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            efforts: z.array(z.object({
                id: z.string(),
                label: z.string(),
                description: z.string().optional(),
                isDefault: z.boolean()
            }))
        })),
        commands: z.array(z.object({ name: z.string(), description: z.string().optional() }))
    }).optional(),
    opencodeSessionId: z.string().optional(),
    cursorSessionId: z.string().optional(),
    hermesSessionId: z.string().optional(),
    mirrorSource: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(),
    happyHomeDir: z.string().optional(),
    happyLibDir: z.string().optional(),
    happyToolsDir: z.string().optional(),
    startedFromRunner: z.boolean().optional(),
    hostPid: z.number().optional(),
    startedBy: z.enum(['runner', 'terminal']).optional(),
    launchNonce: z.string().optional(),
    runnerInstanceId: z.string().optional(),
    lifecycleState: ManagedLifecycleStateSchema.optional(),
    lifecycleStateSince: z.number().optional(),
    stoppedBy: ManagedStoppedBySchema.optional(),
    stopReasonCode: ManagedStopReasonSchema.optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    flavor: z.string().nullish(),
    executionControl: ExecutionControlSchema.optional(),
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
    model: z.string().nullable().optional().default(null),
    modelReasoningEffort: z.string().nullable().optional().default(null),
    serviceTier: CodexServiceTierSchema.nullable().optional(),
    effort: z.string().nullable().optional().default(null),
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
            subscriptionId: z.string().optional(),
            reason: z.string().optional()
        }).optional()
    })
])

export type SyncEvent = z.infer<typeof SyncEventSchema>
