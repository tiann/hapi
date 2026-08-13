import type { SessionSummary } from '@hapi/protocol'

export function hasRunningAttachedJob(session: SessionSummary): boolean {
    return session.attachedJob?.status === 'running'
}

/**
 * Hub `thinking` that reflects real agent foreground work — not ambient ACP
 * state_update chatter while an attached job is the honest outliving signal (#1553).
 */
export function isAgentForegroundThinking(session: SessionSummary): boolean {
    if (!session.active || !session.thinking) {
        return false
    }
    if ((session.backgroundTaskCount ?? 0) > 0) {
        return true
    }
    if ((session.pendingRequestsCount ?? 0) > 0) {
        return false
    }
    if (hasRunningAttachedJob(session)) {
        return false
    }
    return true
}

/** Agent work that belongs in the In progress "Running" bucket (not Jobs). */
export function hasAgentForegroundWork(session: SessionSummary): boolean {
    if (!session.active) {
        return false
    }
    if ((session.backgroundTaskCount ?? 0) > 0) {
        return true
    }
    return isAgentForegroundThinking(session)
}
