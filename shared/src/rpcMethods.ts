export const RPC_METHODS = {
    Permission: 'permission',
    Abort: 'abort',
    Switch: 'switch',
    SetSessionConfig: 'set-session-config',
    KillSession: 'killSession',
    HandoffLocal: 'handoff-local',
    SpawnHappySession: 'spawn-happy-session',
    StopSession: 'stop-session',
    StopRunner: 'stop-runner',
    ListMachineDirectory: 'list-directory',
    PathExists: 'path-exists',
    AgentAvailability: 'agent-availability',
    CursorChatStoreStatus: 'cursor-chat-store-status',
    GitStatus: 'git-status',
    GitDiffNumstat: 'git-diff-numstat',
    GitDiffFile: 'git-diff-file',
    ReadFile: 'readFile',
    ReadGeneratedImage: 'readGeneratedImage',
    WriteFile: 'writeFile',
    ListDirectory: 'listDirectory',
    StatFiles: 'statFiles',
    GetDirectoryTree: 'getDirectoryTree',
    UploadFile: 'uploadFile',
    DeleteUpload: 'deleteUpload',
    Ripgrep: 'ripgrep',
    Difftastic: 'difftastic',
    Bash: 'bash',
    ListSlashCommands: 'listSlashCommands',
    ListSkills: 'listSkills',
    ListCodexModels: 'listCodexModels',
    ListPiModelsForMachine: 'listPiModelsForMachine',
    ListCodexSessions: 'listCodexSessions',
    ArchiveCodexSession: 'archiveCodexSession',
    ListCursorModels: 'listCursorModels',
    ListPiModels: 'listPiModels',
    ListPiSessions: 'listPiSessions',
    ListOpencodeModels: 'listOpencodeModels',
    ListOpencodeModelVariants: 'listOpencodeModelVariants',
    ListOpencodeModelsForCwd: 'listOpencodeModelsForCwd',
    ListGrokModelsForCwd: 'listGrokModelsForCwd',
    ListGrokModels: 'listGrokModels',
    ListGrokReasoningEffortOptions: 'listGrokReasoningEffortOptions',
    ListCopilotModelsForCwd: 'listCopilotModelsForCwd',
    ListCopilotModels: 'listCopilotModels',
    ListKimiModelsForCwd: 'listKimiModelsForCwd',
    ListKimiModels: 'listKimiModels',
    ListOpencodeReasoningEffortOptions: 'listOpencodeReasoningEffortOptions',
    ListAgyModels: 'listAgyModels',
    /** Deliver one queued message into the active Pi turn (native steer). */
    SteerQueuedMessage: 'steer-queued-message',
    ForkConversation: 'fork-conversation',
    RewindConversation: 'rewind-conversation',
    ClearConversation: 'clear-conversation',
    ImplementCodexPlan: 'implement-codex-plan',
    BridgeModelError: 'bridge-model-error'
} as const

export const RPC_TARGET_MISSING_ERROR_CODE = 'rpc_target_missing' as const

/**
 * Thrown by a permission handler's handleMissingPendingResponse when a
 * Permission RPC response arrives for a request the CLI no longer has
 * pending (already answered, or canceled on the agent side). Shared so the
 * hub can match on the specific message rather than treating any error on
 * this RPC method as "not found" — see RpcGateway.approvePermission/
 * denyPermission.
 */
export const PERMISSION_REQUEST_NOT_FOUND_MESSAGE = 'Permission request not found or already resolved' as const

export type RpcMethod = typeof RPC_METHODS[keyof typeof RPC_METHODS]
