import type { AgentFlavor, CodexCollaborationMode } from '@hapi/protocol'

export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: AgentFlavor
    model?: string
    effort?: string
    modelReasoningEffort?: string
    collaborationMode?: CodexCollaborationMode
    yolo?: boolean
    permissionMode?: string
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }
