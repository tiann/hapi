// Re-export protocol types
import type {
    Session,
    SessionSummary,
    SessionSummaryMetadata,
    WorktreeMetadata
} from '@zs/protocol/types'

export type {
    Session,
    SessionSummary,
    SessionSummaryMetadata,
    WorktreeMetadata
}

export type SessionMetadataSummary = {
    path: string
    host: string
    version?: string
    name?: string
    os?: string
    summary?: { text: string; updatedAt: number }
    machineId?: string
    tools?: string[]
    flavor?: string | null
    worktree?: WorktreeMetadata
}

export type SessionsResponse = { sessions: SessionSummary[] }
export type SessionResponse = { session: Session }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }
