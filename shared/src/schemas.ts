import { z } from 'zod'
import { COPILOT_AGENT_MODES, type CopilotAgentMode } from './copilotModes'
import { CODEX_COLLABORATION_MODES, PERMISSION_MODES } from './modes'

export const PermissionModeSchema = z.enum(PERMISSION_MODES)
export const CodexCollaborationModeSchema = z.enum(CODEX_COLLABORATION_MODES)
/** Accept legacy `fleet` (was briefly a peer mode) and coerce to interactive. */
export const CopilotAgentModeSchema = z.union([
    z.enum(COPILOT_AGENT_MODES),
    z.literal('fleet').transform((): CopilotAgentMode => 'interactive'),
])
export const SessionEndReasonSchema = z.enum(['completed', 'terminated', 'error', 'handoff', 'cleared'])
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>

const MetadataSummarySchema = z.object({
    text: z.string(),
    updatedAt: z.number()
})

const ConversationHistoryCapabilitiesSchema = z.object({
    forkCurrent: z.boolean().optional(),
    forkAtMessage: z.boolean().optional(),
    rewindToMessage: z.boolean().optional()
})

// Written to an archived OpenCode source before the runner is asked to spawn.
// The stable replacement id makes retrying a lost RPC acknowledgement safe.
export const OpencodeClearOperationSchema = z.object({
    replacementSessionId: z.string(),
    state: z.enum(['reserved', 'abort-needed', 'cleanup-confirmed', 'finalizing', 'pending', 'failed', 'completed', 'aborted']),
    updatedAt: z.number(),
    error: z.string().optional()
})
export type OpencodeClearOperation = z.infer<typeof OpencodeClearOperationSchema>

const SessionCapabilitiesSchema = z.object({
    terminal: z.boolean().optional(),
    conversationHistory: ConversationHistoryCapabilitiesSchema.optional()
})

export type ConversationHistoryCapabilities = z.infer<typeof ConversationHistoryCapabilitiesSchema>

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
    // Parent HAPI session id when this session was created by message-level fork
    // (`claude --resume <id> --fork-session`). Lets the web list mark the new
    // session as a branch of `<id>` instead of an unrelated duplicate.
    forkedFrom: z.string().optional(),
    codexSessionId: z.string().optional(),
    // 原始 Codex thread id。导入 Codex 历史后，HAPI 会 fork 出自己的续写 thread；
    // codexSessionId 保存 fork 后的 thread，codexSourceSessionId 保留来源 thread 便于同步/展示。
    codexSourceSessionId: z.string().optional(),
    geminiSessionId: z.string().optional(),
    opencodeSessionId: z.string().optional(),
    grokSessionId: z.string().optional(),
    agySessionId: z.string().optional(),
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
    copilotSessionId: z.string().optional(),
    piSessionId: z.string().optional(),
    piResumeAttempt: z.object({
        state: z.enum(['resuming', 'terminating', 'quarantined']),
        machineId: z.string(),
        startedAt: z.number(),
        childSessionId: z.string().optional(),
        archiveSnapshot: z.object({
            lifecycleState: z.string().optional(),
            lifecycleStateSince: z.number().optional(),
            archivedBy: z.string().optional(),
            archiveReason: z.string().optional(),
        }).optional(),
    }).optional(),
    ptyResumeAttempt: z.object({
        state: z.enum(['resuming', 'quarantined']),
        machineId: z.string(),
        startedAt: z.number(),
    }).optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(),
    happyHomeDir: z.string().optional(),
    happyLibDir: z.string().optional(),
    happyToolsDir: z.string().optional(),
    startedFromRunner: z.boolean().optional(),
    hostPid: z.number().optional(),
    hapiMcpUrl: z.string().url().optional(),
    startedBy: z.enum(['runner', 'terminal']).optional(),
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    // Set only after a completed fresh-session clear. The source row remains
    // archived; web clients use this durable link to follow the replacement.
    supersededBySessionId: z.string().optional(),
    // Durable in-progress state for runner-backed OpenCode /clear.
    opencodeClearOperation: OpencodeClearOperationSchema.optional(),
    preferredPermissionMode: PermissionModeSchema.optional(),
    preferredCopilotAgentMode: CopilotAgentModeSchema.optional(),
    flavor: z.string().nullish(),
    // Launch mode, surfaced so the web can show the agent-terminal toggle only
    // for PTY sessions (a 'remote'/SDK session has no agent PTY to view).
    startingMode: z.enum(['local', 'remote', 'pty']).nullish(),
    capabilities: SessionCapabilitiesSchema.optional(),
    conversationHistoryPoints: z.record(z.string(), z.literal(true)).optional(),
    // Native locators for historical fork/rewind (e.g. Grok prompt indexes).
    // Kept separately from the boolean UI markers above.
    conversationHistoryIndexes: z.record(z.string(), z.number().int().nonnegative()).optional(),
    // Codex localId → turnId mapping (durable across runner relaunches).
    conversationHistoryTurns: z.record(z.string(), z.string().min(1)).optional(),
    // Pi localId → append-only session entry id mapping. Pi entry ids are the
    // only stable native boundary accepted by its fork API.
    conversationHistoryEntryIds: z.record(z.string(), z.string().min(1)).optional(),
    // Latest Pi append-log entry observed by HAPI. Import uses it as the
    // incremental cursor so native history already streamed live is not copied twice.
    piHistoryLeafEntryId: z.string().optional(),
    piImportState: z.object({
        state: z.enum(['importing', 'complete', 'failed', 'diverged']),
        machineId: z.string(),
        piSessionId: z.string(),
        sourceFile: z.string(),
        startedAt: z.number(),
        updatedAt: z.number(),
        leafEntryId: z.string().nullable().optional(),
        error: z.string().optional()
    }).optional(),
    // Set when native rewind succeeded but HAPI truncate/hydrate failed.
    conversationHistoryDiverged: z.boolean().optional(),
    worktree: WorktreeMetadataSchema.optional(),
    // Cached Pi model list — written by CLI, read by web (inactive session fallback).
    // Minimal shape: each entry must have modelId; other fields (provider, name, etc.) pass through.
    piAvailableModels: z.array(z.object({ modelId: z.string() }).passthrough()).optional(),
    // Pi-selected model with provider identity. The legacy `session.model`
    // field stores only modelId (shared across all flavors); this preserves
    // the provider so web can resolve the exact model when two providers
    // share a modelId.
    piSelectedModel: z.object({ provider: z.string(), modelId: z.string() }).nullable().optional()
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
    // The mode the session was started in. Persisted so reopen/resume can
    // re-spawn in the same mode — notably 'pty', which has no agent terminal
    // otherwise (a reopened PTY session would silently fall back to 'remote').
    startingMode: z.enum(['local', 'remote', 'pty']).nullish(),
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
    // Hub may still emit null for legacy SQLite rows; keep output type number.
    activeAt: z.number().nullish().transform((value) => value ?? 0),
    metadata: MetadataSchema.nullable(),
    metadataVersion: z.number(),
    agentState: AgentStateSchema.nullable(),
    agentStateVersion: z.number(),
    thinking: z.boolean(),
    thinkingAt: z.number(),
    activeTurnStartedAt: z.number().nullable().optional(),
    backgroundTaskCount: z.number().optional(),
    todos: TodosSchema.optional(),
    teamState: TeamStateSchema.optional(),
    // Watermarks for structured SSE patches (PR #897). Dual EventSource
    // connections can deliver todos/teamState out of order; caches reject
    // stale patches with version <= these fields. Optional so older
    // full-session payloads and hand-built Session literals stay valid.
    todosUpdatedAt: z.number().optional(),
    teamStateUpdatedAt: z.number().optional(),
    model: z.string().nullable().optional().default(null),
    modelReasoningEffort: z.string().nullable().optional().default(null),
    effort: z.string().nullable().optional().default(null),
    serviceTier: z.string().nullable().optional().default(null),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    copilotAgentMode: CopilotAgentModeSchema.optional()
})

export type Session = z.infer<typeof SessionSchema>

// Versioned wrappers mirror the socket.io `update-session` broadcast shape so
// metadata/agentState always travel as an atomic (version, value) pair — the
// version is the only safe way for downstream caches to reject stale patches.
const VersionedMetadataPatchSchema = z.object({
    version: z.number(),
    value: MetadataSchema.nullable()
})

const VersionedAgentStatePatchSchema = z.object({
    version: z.number(),
    value: AgentStateSchema.nullable()
})

// Same dual-SSE race as metadata/agentState: global + session EventSources
// have no shared order. Version = store `todos_updated_at` /
// `team_state_updated_at`. Normal TodoWrite / team writes stamp message
// `createdAt`; rewind/fork `replaceSessionTodos` ratchets the watermark
// so a lagged pre-rewind patch cannot resurrect deleted todos.
const VersionedTodosPatchSchema = z.object({
    version: z.number(),
    value: TodosSchema
})

const VersionedTeamStatePatchSchema = z.object({
    version: z.number(),
    // `null` value = TeamDelete clear. Discriminator remains "key present".
    value: TeamStateSchema.nullable()
})

export const SessionPatchSchema = z.object({
    active: z.boolean().optional(),
    thinking: z.boolean().optional(),
    activeTurnStartedAt: z.number().nullable().optional(),
    activeAt: z.number().optional(),
    updatedAt: z.number().optional(),
    // Structured-patch fields for the second half of #884. Letting the four
    // hub-side emit-sites in cli/sessionHandlers.ts (todos, teamState,
    // metadata, agentState writes) carry their delta means the web client's
    // SSE handler can patch the cache in place instead of falling through to
    // the invalidation fallback that triggers per-session REST refetches.
    // Versioned wrappers for metadata/agentState mirror the socket.io
    // `update-session` broadcast shape — the version field is the only safe
    // way for downstream caches to reject stale patches.
    metadata: VersionedMetadataPatchSchema.optional(),
    agentState: VersionedAgentStatePatchSchema.optional(),
    todos: VersionedTodosPatchSchema.optional(),
    teamState: VersionedTeamStatePatchSchema.optional(),
    model: z.string().nullable().optional(),
    modelReasoningEffort: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    serviceTier: z.string().nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    copilotAgentMode: CopilotAgentModeSchema.optional(),
    backgroundTaskCount: z.number().optional(),
    // tiann/hapi#893 (scratchlist v2). Bumped whenever any entry on the
    // session_scratchlist table mutates. Web client uses the change as a
    // trigger to refetch the entries query - the timestamp itself is the
    // signal, not the payload. Keep this minimal: per the operator's 80/20
    // ruling, scratchlist mutations are rare relative to keep-alive
    // patches, so a fresh event type would be overkill.
    scratchlistUpdatedAt: z.number().optional()
}).strict()

export type SessionPatch = z.infer<typeof SessionPatchSchema>

// tiann/hapi#893: per-session scratchlist entries (operator notes /
// drafts / parking-lot ideas). Hub-side typed-table source of truth;
// web treats localStorage as offline cache only. Single-user notes -
// no collaborative edit semantics (no version field, no conflict
// resolution beyond last-write-wins).
export const ScratchlistEntrySchema = z.object({
    entryId: z.string().min(1),
    text: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    attachments: z.array(z.object({
        id: z.string(),
        filename: z.string(),
        mimeType: z.string(),
        size: z.number(),
        path: z.string(),
    })).optional().default([])
})

export type ScratchlistEntry = z.infer<typeof ScratchlistEntrySchema>

export const ScratchlistEntriesResponseSchema = z.object({
    entries: z.array(ScratchlistEntrySchema)
})

export type ScratchlistEntriesResponse = z.infer<typeof ScratchlistEntriesResponseSchema>

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
    capabilities: z.object({ piExistingSessionResume: z.literal(true).optional() }).optional(),
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

export const MachineHealthSchema = z.object({
    collectedAt: z.number(),
    cpuCount: z.number().int().positive().optional(),
    load1m: z.number().nonnegative().optional(),
    cpuPercent: z.number().min(0).max(100).optional(),
    memoryPercent: z.number().min(0).max(100).optional(),
    uptimeSeconds: z.number().nonnegative().optional()
}).strict()

export type MachineHealth = z.infer<typeof MachineHealthSchema>

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
    runnerStateVersion: z.number(),
    health: MachineHealthSchema.nullable().optional()
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
            subscriptionId: z.string().optional(),
            /**
             * Reconnect verdict. 'ok' means the hub replayed every event the
             * client missed (sent right after this one), so the client can skip
             * its full refetch. 'gap' (or absence, on older hubs) means the
             * client must resync from REST.
             */
            resume: z.enum(['ok', 'gap']).optional()
        }).optional()
    })
])

export type SyncEvent = z.infer<typeof SyncEventSchema>

export const CancelMessageResponseSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('cancelled'), localId: z.string().nullable() }),
    z.object({ status: z.literal('invoked'), message: DecryptedMessageSchema }),
])

export type CancelMessageResponse = z.infer<typeof CancelMessageResponseSchema>
