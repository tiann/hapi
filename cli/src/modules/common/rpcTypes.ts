export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode'
    model?: string
    effort?: string
    modelReasoningEffort?: string
    yolo?: boolean
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }

export type ImportableSessionAgent = 'codex'

export type ImportableCodexSessionSummary = {
    agent: 'codex'
    externalSessionId: string
    cwd: string | null
    timestamp: number | null
    transcriptPath: string
    previewTitle: string | null
    previewPrompt: string | null
}

export type RpcListImportableSessionsRequest = {
    agent: ImportableSessionAgent
}

export type RpcListImportableSessionsResponse = {
    sessions: ImportableCodexSessionSummary[]
}
