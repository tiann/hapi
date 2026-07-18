import type { ProviderReadinessIssueCode } from '@hapi/protocol'

export interface SpawnSessionOptions {
    spawnRequestId?: string
    machineId?: string
    directory: string
    sessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: 'claude' | 'claude-deepseek' | 'claude-ark' | 'cc-api' | 'codex' | 'cursor' | 'agy' | 'grok' | 'opencode' | 'hermes-moa'
    model?: string
    effort?: string
    modelReasoningEffort?: string
    serviceTier?: string
    yolo?: boolean
    permissionMode?: string
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'pending'; spawnRequestId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | {
        type: 'error'
        errorMessage: string
        code?: ProviderReadinessIssueCode
        recoveryCommand?: string
    }

export type QuerySpawnSessionResult = SpawnSessionResult | {
    type: 'not_found'
    spawnRequestId: string
} | {
    type: 'conflict'
    spawnRequestId: string
}
