import type { SessionSummary } from '@hapi/protocol'

import { isAttachedJobStale } from './attachedJob'

export function hasRunningAttachedJob(session: SessionSummary): boolean {
    return session.attachedJob?.status === 'running'
}

export function hasUnarchivedJob(session: SessionSummary): boolean {
    // A process can outlive its session. Keep its meter on the project row,
    // but do not let it move an archived conversation back into Active.
    return session.metadata?.lifecycleState !== 'archived' && hasRunningAttachedJob(session)
}

export function hasInProgressJobSession(session: SessionSummary, now = Date.now()): boolean {
    const job = session.attachedJob
    return hasUnarchivedJob(session) && !!job && !isAttachedJobStale({ heartbeatAt: job.latestRunningHeartbeatAt ?? job.heartbeatAt }, now)
}

/**
 * Hub `thinking` that should show the Running spinner / bucket.
 * Ambient ACP chatter is filtered in the CLI (#1553); do not second-guess
 * `thinking` here when a long-running job is also attached — real prompts
 * still set thinking=true via prompt().
 */
export function isAgentForegroundThinking(session: SessionSummary): boolean {
    if (!session.active || !session.thinking) {
        return false
    }
    if ((session.pendingRequestsCount ?? 0) > 0) {
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
