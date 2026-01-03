export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: 'claude' | 'codex' | 'gemini'
    yolo?: boolean
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }
