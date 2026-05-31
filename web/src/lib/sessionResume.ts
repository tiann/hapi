import type { Session } from '@/types/api'

/** Agent thread id used by hub `resolveAgentResumeId` (any flavor). */
export function resolveAgentSessionIdFromMetadata(
    metadata: Session['metadata'] | null | undefined,
): string | undefined {
    if (!metadata) {
        return undefined
    }
    return metadata.codexSessionId
        ?? metadata.claudeSessionId
        ?? metadata.geminiSessionId
        ?? metadata.opencodeSessionId
        ?? metadata.cursorSessionId
        ?? metadata.kimiSessionId
        ?? undefined
}

/**
 * Whether an inactive session can be activated via resume (or fresh spawn on first send).
 * Matches hub: resume with agent id, or fresh spawn when path exists, no agent id, no user messages.
 */
export function inactiveSessionCanResume(
    session: Session,
    userMessageCount: number,
): boolean {
    if (session.active) {
        return true
    }
    if (!session.metadata?.path) {
        return false
    }
    if (resolveAgentSessionIdFromMetadata(session.metadata)) {
        return true
    }
    return userMessageCount === 0
}
