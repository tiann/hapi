import type { AgentFlavor } from '@hapi/protocol'
import type { CopilotAgentMode } from '@hapi/protocol'

export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    // Live hub row id for reopen/resume. Runner stamps `--existing-session-id`.
    existingSessionId?: string
    // Hub-preallocated machine-spawn stub. Runner stamps `--hapi-session-id`
    // (adopt-stub create/getOrCreate) — must NOT take the reopen path.
    reservedSessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: AgentFlavor
    model?: string
    effort?: string
    modelReasoningEffort?: string
    yolo?: boolean
    permissionMode?: string
    serviceTier?: string
    collaborationMode?: 'default' | 'plan'
    copilotAgentMode?: CopilotAgentMode
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    startingMode?: 'remote' | 'pty'
    /** Claude: spawn with --fork-session after --resume. */
    forkSession?: boolean
    /** Runner-internal post-create containment revalidation. Never serialized. */
    validateDirectory?: (path: string) => Promise<boolean>
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string; childStarted: false }
    | {
        type: 'error'
        errorMessage: string
        code?: 'agent_unavailable' | 'outside_workspace_roots'
        agent?: AgentFlavor
        /**
         * Explicit false = runner rejected before exec (no OS child). Hub may
         * delete a preallocated stub. Omitted/true = child may exist — keep stub
         * until StopSession confirms gone (#1911 B3).
         */
        childStarted?: boolean
    }
