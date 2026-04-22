import type { CodexCollaborationMode, PermissionMode } from './modes'

export type ImportableSessionAgent = 'codex' | 'claude'

export type ImportableCodexSessionSummary = {
    agent: 'codex'
    externalSessionId: string
    cwd: string | null
    timestamp: number | null
    transcriptPath: string
    previewTitle: string | null
    previewPrompt: string | null
    model?: string | null
    effort?: string | null
    modelReasoningEffort?: string | null
    collaborationMode?: CodexCollaborationMode | null
    approvalPolicy?: string | null
    sandboxPolicy?: unknown | null
    permissionMode?: PermissionMode | null
    serviceTier?: string | null
}

export type ImportableClaudeSessionSummary = {
    agent: 'claude'
    externalSessionId: string
    cwd: string | null
    timestamp: number | null
    transcriptPath: string
    previewTitle: string | null
    previewPrompt: string | null
}

export type ImportableSessionSummary =
    | ImportableCodexSessionSummary
    | ImportableClaudeSessionSummary

export type RpcListImportableSessionsRequest = {
    agent: ImportableSessionAgent
}

export type RpcListImportableSessionsResponse = {
    sessions: ImportableSessionSummary[]
}
