export const DEFAULT_RPC_TIMEOUT_MS = 30_000

/** expiresAt uses the Runner/target machine's monotonic milliseconds, not wall time. */
export type SessionStopPreparationLease = { id: string; expiresAt: number }

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
    WorkspaceReadFile: 'workspace-read-file',
    WorkspaceListDirectory: 'workspace-list-directory',
    WorkspaceStatFiles: 'workspace-stat-files',
    WorkspaceGitStatus: 'workspace-git-status',
    WorkspaceGitDiffNumstat: 'workspace-git-diff-numstat',
    WorkspaceGitDiffFile: 'workspace-git-diff-file',
    WorkspaceRipgrep: 'workspace-ripgrep',
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
    ListOpencodeSessions: 'listOpencodeSessions',
    ListOpencodeModelsForCwd: 'listOpencodeModelsForCwd',
    ListGrokModelsForCwd: 'listGrokModelsForCwd',
    ListGrokModels: 'listGrokModels',
    ListGrokReasoningEffortOptions: 'listGrokReasoningEffortOptions',
    ListCopilotModelsForCwd: 'listCopilotModelsForCwd',
    ListCopilotModels: 'listCopilotModels',
    ListKimiModelsForCwd: 'listKimiModelsForCwd',
    ListKimiModels: 'listKimiModels',
    ListDshModels: 'listDshModels',
    ListDshModelsForMachine: 'listDshModelsForMachine',
    ListOpencodeReasoningEffortOptions: 'listOpencodeReasoningEffortOptions',
    ListAgyModels: 'listAgyModels',
    ListClaudeModels: 'listClaudeModels',
    /** Deliver one queued message into the active Pi turn (native steer). */
    SteerQueuedMessage: 'steer-queued-message',
    ForkConversation: 'fork-conversation',
    RewindConversation: 'rewind-conversation',
    ClearConversation: 'clear-conversation',
    ImplementCodexPlan: 'implement-codex-plan',
} as const

export const RPC_TARGET_MISSING_ERROR_CODE = 'rpc_target_missing' as const

/** Select the exact machine/PID; the handler still validates the OS start marker. */
export function getSessionStopPreparationMethod(machineId: string, pid: number): string {
    return `${RPC_METHODS.KillSession}/process/${encodeURIComponent(machineId)}/${pid}`
}

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
