export interface SpawnSessionOptions {
    directory: string
    sessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: string
    model?: string
    effort?: string
    modelReasoningEffort?: string
    yolo?: boolean
    permissionMode?: string
    manualFields?: string[]
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    pluginFields?: Record<string, unknown>
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }
